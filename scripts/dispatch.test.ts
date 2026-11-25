import assert from "node:assert/strict";
import test from "node:test";
import { Dispatcher } from "../src/main/dispatch.ts";

type Outcome = "started" | "queued" | "handled";
interface PromptOptions {
	streamingBehavior?: string;
	images?: unknown;
	preflightResult?: (outcome: Outcome) => void;
}
type Prompt = (text: string, options: PromptOptions) => Promise<void>;

/** A session that does what the test says, to reach the moments real pi passes through too fast to catch. */
class FakeSession {
	isStreaming = false;
	isCompacting = false;
	_isEmittingAgentSettled = false;
	_agentRunAbortRequested = false;
	_deferredSettledActions: (() => Promise<void>)[] = [];
	extensionRunner = { getCommand: (name: string) => (name === "plan" ? {} : undefined) };
	agent = {
		signal: undefined as AbortSignal | undefined,
		abort: () => {},
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		steer: (message: unknown) => void this.custom.push(["steer", message]),
		followUp: (message: unknown) => void this.custom.push(["followUp", message]),
		peekQueuedMessages: () => [],
		clearSteeringQueue: () => {},
		clearFollowUpQueue: () => {},
	};
	custom: unknown[] = [];
	queued: unknown[] = [];
	starts: unknown[] = [];
	prompts: string[] = [];
	listeners = new Set<(event: { type: string }) => void>();
	onPrompt: Prompt;
	/** A run takes as long as this does, and fails when this does. */
	run: () => Promise<void> = () => never;
	/** Whether the model's loop takes a run's messages. */
	accepts = true;

	constructor(onPrompt?: Prompt) {
		this.onPrompt = onPrompt ?? ((text, options) => this._startRun({ messageType: "user", prompt: text }, () => options.preflightResult?.("started")));
	}

	prompt(text: string, options: PromptOptions): Promise<void> {
		this.prompts.push(text);
		return this.onPrompt(text, options);
	}
	async sendCustomMessage(message: unknown, options: { triggerTurn?: boolean }): Promise<void> {
		if (options?.triggerTurn && !this.isStreaming) await this._startRun({ messageType: "custom", message });
	}
	async _startRun(trigger: unknown, onStarted?: () => void): Promise<void> {
		this.starts.push(trigger);
		this.isStreaming = true;
		try {
			await undefined;
			onStarted?.();
			if (!this.accepts) throw new Error("already processing");
			this.agent.signal = new AbortController().signal;
			await this.run();
		} finally {
			this.isStreaming = false;
			this.agent.signal = undefined;
		}
	}
	async _queueSteer(text: string, images?: unknown): Promise<void> {
		this.queued.push(["steer", text, images]);
	}
	async _queueFollowUp(text: string, images?: unknown): Promise<void> {
		this.queued.push(["followUp", text, images]);
	}
	_emitQueueUpdate(): void {}
	getSteeringMessages = () => [];
	getFollowUpMessages = () => [];
	waitForIdle = async () => {};
	subscribe(listener: (event: { type: string }) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** As pi does: extensions hear, then listeners, then what was put off gets its turn. */
	settle(): void {
		for (const listener of this.listeners) listener({ type: "agent_settled" });
		this._isEmittingAgentSettled = false;
		const actions = this._deferredSettledActions.splice(0);
		void (async () => {
			for (const action of actions) await action();
		})();
	}
}

function open(onPrompt?: Prompt) {
	const session = new FakeSession(onPrompt);
	const errors: unknown[] = [];
	const dispatcher = new Dispatcher(session as never, (error) => errors.push(error));
	const send = (text: string, options: { mode?: "steer" | "followUp"; images?: unknown[] } = {}) => dispatcher.send(text, { mode: "followUp", ...options } as never);
	return { session, dispatcher, errors, send };
}

const tick = () => new Promise((done) => setImmediate(done));
const never = new Promise<void>(() => {});

/** Whether a promise is still pending. */
const pending = async (promise: Promise<unknown>) => (await Promise.race([promise.then(() => "done", () => "done"), tick().then(() => "pending")])) === "pending";

function gate() {
	let open = () => {};
	const opened = new Promise<void>((done) => (open = done));
	return { open: () => open(), opened };
}

test("resolves with what pi made of the message, while its run goes on", async () => {
	const { send, errors, dispatcher } = open();
	assert.equal(await send("hello"), "started");
	assert.ok(dispatcher.busy);
	assert.deepEqual(errors, []);
	for (const outcome of ["queued", "handled"] as const) {
		const { send, dispatcher } = open(async (_text, options) => options.preflightResult?.(outcome));
		assert.equal(await send("hello"), outcome);
		await tick();
		assert.equal(dispatcher.busy, false);
	}
});

test("every message says how it joins a run, with its images", async () => {
	const seen: unknown[] = [];
	const { send } = open(async (_text, { streamingBehavior, images, preflightResult }) => {
		seen.push([streamingBehavior, images]);
		preflightResult?.("queued");
	});
	const images = [{ type: "image", data: "", mimeType: "image/png" }];
	await send("one");
	await send("two", { mode: "steer", images });
	assert.deepEqual(seen, [
		["followUp", undefined],
		["steer", images],
	]);
});

test("a message pi refuses rejects; a run that fails after its message was taken is reported instead", async () => {
	const refused = open(async () => {
		throw new Error("No model selected");
	});
	await assert.rejects(refused.send("hello"), /No model selected/);
	assert.deepEqual(refused.errors, []);

	const failed = open();
	failed.session.run = async () => {
		await tick();
		throw new Error("lost connection");
	};
	assert.equal(await failed.send("hello"), "started");
	await tick();
	await tick();
	assert.match(String(failed.errors[0]), /lost connection/);
	assert.equal(failed.dispatcher.busy, false);
});

test("a run counts as started once the model's loop has taken its messages, not when pi is about to hand them over", async () => {
	const { session, send, errors } = open();
	session.accepts = false;
	await assert.rejects(send("hello"), /already processing/);
	assert.deepEqual(errors, []);
});

test("a prompt that comes back without a word has no outcome until there is one", async () => {
	let say: (outcome: Outcome) => void = () => {};
	const { send } = open(async (_text, options) => {
		say = options.preflightResult!;
	});
	const sent = send("hello");
	assert.ok(await pending(sent));
	say("queued");
	assert.equal(await sent, "queued");
});

test("Stop gives back a message whose prompt came back without a word", async () => {
	const { dispatcher, send } = open(async () => {});
	const sent = send("hello");
	assert.ok(await pending(sent));
	dispatcher.stop();
	assert.equal(await sent, "stopped");
});

test("while extensions hear that a run settled the message waits, and its failure comes to its sender", async () => {
	for (const fails of [false, true]) {
		const { session, send, errors } = open(
			fails
				? async () => {
						throw new Error("No API key");
					}
				: undefined,
		);
		session._isEmittingAgentSettled = true;
		const sent = [send("hello", { mode: "steer" }), send("again", { mode: "steer" })];
		for (const promise of sent) promise.catch(() => {});
		assert.ok(await pending(sent[0]!));
		assert.deepEqual(session.prompts, []);
		session.settle();
		if (fails) for (const promise of sent) await assert.rejects(promise, /No API key/);
		else assert.deepEqual(await Promise.all(sent), ["started", "queued"]);
		assert.deepEqual(session.prompts, ["hello", "again"]);
		assert.deepEqual(errors, []);
	}
});

test("a message let through while a settled run's extensions hear of it waits for them, then starts", async () => {
	const hook = gate();
	const { session, send } = open(async (text, options) => {
		await hook.opened;
		await session._startRun({ messageType: "user", prompt: text }, () => options.preflightResult?.("started"));
	});
	const sent = send("hello");
	await tick();
	session._isEmittingAgentSettled = true;
	hook.open();
	assert.ok(await pending(sent));
	assert.deepEqual(session.starts, []);
	session.settle();
	assert.equal(await sent, "started");
});

test("a run an extension starts as the last one settles takes the waiting message", async () => {
	const { session, send } = open(async (_text, { preflightResult }) => preflightResult?.("queued"));
	session._isEmittingAgentSettled = true;
	const sent = send("hello");
	await tick();
	session.isStreaming = true;
	session.settle();
	assert.equal(await sent, "queued");
	assert.deepEqual(session.prompts, ["hello"]);
});

test("a second run joins the first, the way its message says, with its images", async () => {
	const { session, send } = open(async (text, options) => {
		await tick();
		await session._startRun({ messageType: "user", prompt: `${text}, expanded`, images: options.images }, () => options.preflightResult?.("started"));
	});
	const images = [{ type: "image", data: "", mimeType: "image/png" }];
	const sent = [send("one"), send("two", { images }), send("three", { mode: "steer" })];
	assert.deepEqual(await Promise.all(sent), ["started", "queued", "queued"]);
	assert.equal(session.starts.length, 1);
	assert.deepEqual(session.queued, [
		["followUp", "two, expanded", images],
		["steer", "three, expanded", undefined],
	]);
	// And so does an extension's, which pi found idle a moment ago.
	await session._startRun({ messageType: "custom", message: "wake" });
	assert.deepEqual(session.custom, [["followUp", "wake"]]);
});

test("a message during /compact waits for it; a command does not", async () => {
	const { session, send } = open();
	const compacting = gate();
	session.isCompacting = true;
	session.waitForIdle = () => compacting.opened;
	const sent = send("hello");
	const command = send("/plan now");
	assert.deepEqual(session.prompts, ["/plan now"]);
	assert.ok(await pending(sent));
	session.isCompacting = false;
	compacting.open();
	assert.deepEqual([await command, await sent].sort(), ["queued", "started"]);
	assert.deepEqual(session.prompts, ["/plan now", "hello"]);
});

test("compaction inside a run takes messages as the run does", async () => {
	const { session, send } = open(async (_text, { preflightResult }) => preflightResult?.("queued"));
	Object.assign(session, { isStreaming: true, isCompacting: true });
	assert.equal(await send("hello"), "queued");
});

test("a command is taken once a run it asked for starts, or when it is done; other runs are none of its business", async () => {
	const handler = gate();
	const { session, send, dispatcher } = open(async (text, options) => {
		if (text === "/plan alone") await handler.opened;
		else if (text === "/plan run") {
			void (session.prompt as Prompt)("the plan", {});
			await handler.opened;
		} else await session._startRun({ messageType: "user", prompt: text });
		if (text.startsWith("/plan ")) options.preflightResult?.("handled");
	});
	const ending = gate();
	session.run = () => ending.opened;
	const alone = send("/plan alone");
	await session.sendCustomMessage("something else", {}).then(() => void session._startRun({ messageType: "custom", message: "wake" }));
	await tick();
	assert.ok(await pending(alone));
	ending.open();
	await tick();
	assert.ok(await pending(alone));
	assert.equal(await send("/plan run"), "started");
	assert.ok(await pending(alone));
	handler.open();
	assert.equal(await alone, "handled");
	await tick();
	assert.equal(dispatcher.busy, false);
});

test("a command, or a message an extension deals with, is not done before what they send has an outcome", async () => {
	for (const [text, outcome] of [
		["/plan", "started"],
		["hello", "started"],
		["/plan", "queued"],
		["/plan", "refused"],
	] as const) {
		const hook = gate();
		const { session, send } = open(async (prompt, options) => {
			if (prompt !== text) {
				await hook.opened;
				if (outcome === "refused") throw new Error("No model selected");
				if (outcome === "queued") return options.preflightResult?.("queued");
				return session._startRun({ messageType: "user", prompt });
			}
			(session.prompt as Prompt)("sent by an extension", {}).catch(() => {});
			options.preflightResult?.("handled");
		});
		const sent = send(text);
		assert.ok(await pending(sent));
		hook.open();
		assert.equal(await sent, outcome === "refused" ? "handled" : outcome);
	}
});

test("what extensions send while a run settles gets its turn, whatever becomes of what came before it", async () => {
	const { session } = open(async (text, options) => {
		if (text === "refused") throw new Error("No model selected");
		options.preflightResult?.("handled");
	});
	session._isEmittingAgentSettled = true;
	const sent = [(session.prompt as Prompt)("refused", {}), (session.prompt as Prompt)("fine", {})];
	for (const promise of sent) promise.catch(() => {});
	await tick();
	assert.deepEqual(session.prompts, []);
	session.settle();
	await assert.rejects(sent[0]!, /No model/);
	await sent[1];
	assert.deepEqual(session.prompts, ["refused", "fine"]);
});

test("Stop gives back a message that has reached no run, and keeps one that is past pi's hooks from starting one", async () => {
	for (const settling of [true, false]) {
		const hook = gate();
		const { session, dispatcher, send, errors } = open(async (text) => {
			await hook.opened;
			await session._startRun({ messageType: "user", prompt: text });
		});
		session._isEmittingAgentSettled = settling;
		const sent = send("hello");
		await tick();
		dispatcher.stop();
		// What pi has may still be dealt with by the extension that looks at it.
		assert.equal(await pending(sent), !settling);
		hook.open();
		if (settling) session.settle();
		assert.equal(await sent, "stopped");
		await tick();
		assert.deepEqual([session.starts, errors, dispatcher.busy], [[], [], false]);
		const after = send("hello again");
		assert.equal(await after, "started");
	}
});

test("Stop keeps a message past pi's hooks from joining a run that goes on", async () => {
	for (const mode of ["steer", "followUp"] as const) {
		const hook = gate();
		const { session, dispatcher, send } = open(async (text, options) => {
			await hook.opened;
			await (mode === "steer" ? session._queueSteer(text) : session._queueFollowUp(text));
			options.preflightResult?.("queued");
		});
		session.isStreaming = true;
		const sent = send("hello", { mode });
		await tick();
		dispatcher.stop();
		hook.open();
		assert.equal(await sent, "stopped");
		assert.deepEqual(session.queued, []);
	}
});

test("a message that was dealt with before Stop stays so", async () => {
	const hook = gate();
	const { session, dispatcher, send } = open(async (text, options) => {
		if (text === "sent by an extension") await hook.opened.then(() => session._startRun({}));
		else {
			(session.prompt as Prompt)("sent by an extension", {}).catch(() => {});
			options.preflightResult?.("handled");
		}
	});
	const sent = send("hello");
	await tick();
	dispatcher.stop();
	assert.ok(await pending(sent));
	hook.open();
	assert.equal(await sent, "handled");
	assert.deepEqual(session.starts, []);
});

test("closing the session gives back every message still on its way, and none reaches a run", async () => {
	for (const settling of [false, true]) {
		const hook = gate();
		const { session, dispatcher, send, errors } = open(async (text) => {
			await hook.opened;
			await session._startRun({ messageType: "user", prompt: text });
		});
		session._isEmittingAgentSettled = settling;
		const sent = [send("hello"), send("/plan")];
		for (const promise of sent) promise.catch(() => {});
		await tick();
		dispatcher.close();
		for (const promise of sent) await assert.rejects(promise, /not open/);
		hook.open();
		if (settling) session.settle();
		await tick();
		assert.deepEqual([session.starts, errors, dispatcher.busy, session.listeners.size], [[], [], false, 0]);
		await assert.rejects(send("late"), /not open/);
		await assert.rejects((session.prompt as Prompt)("late", {}), /not open/);
	}
});
