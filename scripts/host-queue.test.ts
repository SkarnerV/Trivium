import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtInPackages } from "../src/shared/recommended.ts";
import type { FileChange, HostEvent, SessionStatus } from "../src/shared/protocol.ts";
import { ModelServer, messageText } from "./real/model-server.ts";

/**
 * How the host hands messages to pi around the edges of a run, with the real pi SDK on throwaway folders, a scripted
 * model and one extension whose handlers the tests set. The folders go in the environment before anything reads it.
 */

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-host-queue-")));
const folders = { agent: join(dir, "agent"), home: join(dir, "trivium"), project: join(dir, "project") };
for (const folder of [join(folders.agent, "extensions"), folders.home, folders.project]) mkdirSync(folder, { recursive: true });
Object.assign(process.env, { PI_CODING_AGENT_DIR: folders.agent, TRIVIUM_HOME: folders.home, PI_OFFLINE: "1" });
delete process.env.TRIVIUM_DEV_FAUX;

const model = new ModelServer();
const provider = {
	baseUrl: await model.start(),
	api: "openai-completions",
	apiKey: "none",
	models: [{ id: "scripted", contextWindow: 200_000, maxTokens: 8000 }],
};
writeFileSync(join(folders.agent, "models.json"), JSON.stringify({ providers: { scripted: provider } }));
writeFileSync(join(folders.agent, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted" }));
// Write has no shell and no git; the packages Trivium ships are left out, so only the probe's handlers run.
writeFileSync(
	join(folders.home, "settings.json"),
	JSON.stringify({ apps: { write: { disabled: [], added: [], removed: builtInPackages("write"), disabledSkills: [] } } }),
);

type Handler = (event: any, ctx: any) => unknown;
/** What the extension does, until the test ends. */
let handlers: Record<string, Handler> = {};
let commands: Record<string, (args: string, ctx: any) => unknown> = {};
let pi!: ExtensionAPI;
Object.assign(globalThis, {
	triviumQueueProbe: (api: ExtensionAPI) => {
		pi = api;
		for (const name of ["session_start", "input", "before_agent_start", "agent_settled", "session_before_compact"]) {
			(api.on as (name: string, handler: Handler) => void)(name, (event, ctx) => handlers[name]?.(event, ctx));
		}
		api.registerCommand("probe", { description: "Runs what the test says", handler: async (args, ctx) => void (await commands.probe?.(args, ctx)) });
	},
});
writeFileSync(join(folders.agent, "extensions", "probe.ts"), "export default (pi) => globalThis.triviumQueueProbe(pi);\n");

const { SessionHost } = await import("../src/main/host.ts");
const { INTERNALS } = await import("../src/main/dispatch.ts");
const { SettingsStore } = await import("../src/main/settings.ts");
const { DialogBroker } = await import("../src/main/dialogs.ts");
const { ServiceTracker } = await import("../src/main/services.ts");

let events: HostEvent[] = [];
let listen: (event: HostEvent) => void = () => {};
let onDone: (path: string) => void = () => {};
const emit = (event: HostEvent) => {
	events.push(event);
	listen(event);
};
const broker = new DialogBroker(emit);
const services = new ServiceTracker({ file: join(folders.home, "services.json"), emit: () => {} });
const host = new SessionHost({
	emit,
	broker,
	indexFile: join(folders.home, "session-apps.json"),
	settings: new SettingsStore(join(folders.home, "settings.json")),
	onDone: (path) => onDone(path),
	services,
});
await host.init();

afterEach(() => {
	handlers = {};
	commands = {};
	events = [];
	listen = () => {};
	onDone = () => {};
	model.scripts.clear();
	fastAuth();
});

after(async () => {
	host.dispose();
	services.dispose();
	await model.stop();
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Internals {
	session: AgentSession;
	tracker: { apply: (event: unknown) => boolean; current: () => unknown };
	changes: { list: () => Promise<FileChange[]> };
	lastActive: number;
}
const live = (path: string) => (host as unknown as { live: Map<string, Internals> }).live.get(path)!;
const open = async () => (await host.newSession({ app: "write", cwd: folders.project })).path;

async function until(what: string, read: () => unknown, timeoutMs = 15_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 5));
	}
}

const tick = () => new Promise((done) => setTimeout(done, 20));
const pending = async (promise: Promise<unknown>) => (await Promise.race([promise.then(() => "done", () => "done"), tick().then(() => "pending")])) === "pending";

/** Something a handler waits for until the test lets it go on. */
function gate() {
	let open = () => {};
	let reached = false;
	const opened = new Promise<void>((done) => (open = done));
	return {
		open: () => open(),
		pass: () => {
			reached = true;
			return opened;
		},
		reached: () => reached,
	};
}

const statuses = (path: string) => events.filter((event): event is HostEvent & { type: "status" } => event.type === "status" && event.path === path);
const last = (path: string): SessionStatus | undefined => statuses(path).at(-1);
const notices = () => events.flatMap((event) => (event.type === "notice" ? [event.notice.message] : []));
const settled = (path: string) => until("the session to settle", () => last(path)?.running === false && !live(path).session.isStreaming);
/** The user's messages the model was given, as the session holds them. */
const prompts = (path: string) =>
	live(path)
		.session.messages.filter((message) => message.role === "user")
		.map((message) => messageText(message as Parameters<typeof messageText>[0]).trim());

/** Makes pi look the provider's credentials up, which takes a while, rather than know that they are there. */
function slowAuth() {
	const lookup = gate();
	let asked = 0;
	Object.assign(host.runtime, {
		hasConfiguredAuth: () => false,
		checkAuth: async () => {
			asked++;
			await lookup.pass();
			return { type: "api_key" };
		},
	});
	return { open: lookup.open, asked: () => asked };
}
function fastAuth() {
	const runtime = host.runtime as { hasConfiguredAuth?: unknown; checkAuth?: unknown };
	delete runtime.hasConfiguredAuth;
	delete runtime.checkAuth;
}

/** Holds up whatever asks for a session's changed files next. */
function slowChanges(path: string) {
	const reading = gate();
	const { changes } = live(path);
	const list = changes.list.bind(changes);
	changes.list = async () => {
		await reading.pass();
		return list();
	};
	return reading;
}

/** Makes the next runs fail to be prepared, once the test says so. */
function failPreparation(path: string, times = 1) {
	const preparing = gate();
	const runner = live(path).session.extensionRunner as unknown as { emitBeforeAgentStart: (...args: unknown[]) => Promise<unknown> };
	const original = runner.emitBeforeAgentStart;
	let left = times;
	runner.emitBeforeAgentStart = async () => {
		await preparing.pass();
		if (!--left) runner.emitBeforeAgentStart = original;
		throw new Error("cannot prepare");
	};
	return preparing;
}

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** A run an extension starts, such as for a background task that ended. */
const wake = () => pi.sendMessage({ customType: "wake", content: "A background task ended.", display: true }, { triggerTurn: true });
const unload = (path: string) => host.reloadApp("write").includes(path);
/** What the minute timer does, for a session no one looked at in years. */
const evict = (path: string) => {
	live(path).lastActive = 0;
	(host as unknown as { unloadIdle: () => void }).unloadIdle();
	return !(host as unknown as { live: Map<string, unknown> }).live.has(path);
};

/** A run whose reply waits for the test, so it is certainly going. */
function longRun() {
	const reply = gate();
	model.scripts.set("long", [
		async () => {
			await reply.pass();
			return { text: "Done." };
		},
	]);
	return reply;
}

test("a message that starts a run says so before the run ends, and one sent meanwhile is queued for after", async () => {
	const path = await open();
	const reply = longRun();
	const first = await host.send(path, "@@long@@", "prompt");
	assert.deepEqual([first.outcome, first.status.running], ["started", true]);
	const second = await host.send(path, "second", "prompt");
	assert.deepEqual([second.outcome, second.status.queue.followUp], ["queued", ["second"]]);
	const third = await host.send(path, "third", "steer");
	assert.deepEqual([third.outcome, third.status.queue.steering], ["queued", ["third"]]);
	reply.open();
	await settled(path);
	assert.deepEqual(prompts(path).sort(), ["@@long@@", "second", "third"]);
	assert.deepEqual(notices(), []);
});

test("a message sent while pi still prepares a run joins it", async () => {
	const path = await open();
	const preparing = gate();
	handlers.before_agent_start = preparing.pass;
	const first = host.send(path, "first", "prompt");
	await until("the run to be prepared", preparing.reached);
	const second = await host.send(path, "second", "prompt");
	assert.deepEqual([second.outcome, second.status.running], ["queued", true]);
	// A command, and one that expands like a message, pass through the same window.
	assert.equal((await host.send(path, "/unknown text", "prompt")).outcome, "queued");
	await assert.rejects(host.editMessage(path, 0, "changed"), /Stop the run/);
	assert.deepEqual(host.reloadApp("write").includes(path), false, "it is not unloaded under the message");
	assert.ok(await pending(first));
	preparing.open();
	assert.equal((await first).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "second", "/unknown text"]);
	assert.deepEqual(notices(), []);
});

test("compaction before a run does not make the session look idle when it ends", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const { session } = live(path);
	// The next prompt finds the context full.
	session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 199_995, keepRecentTokens: 1 } });
	const compacting = gate();
	const preparing = gate();
	handlers.session_before_compact = async () => {
		await compacting.pass();
		return { cancel: true };
	};
	handlers.before_agent_start = preparing.pass;
	const second = host.send(path, "second", "prompt");
	await until("compaction", compacting.reached);
	assert.deepEqual([last(path)?.running, last(path)?.compacting], [true, true]);
	assert.equal((await host.send(path, "during", "prompt")).outcome, "queued");
	compacting.open();
	await until("the end of compaction", () => last(path)?.compacting === false);
	assert.equal(last(path)?.running, true);
	await until("the run to be prepared", preparing.reached);
	assert.equal((await host.send(path, "between", "prompt")).outcome, "queued");
	session.settingsManager.applyOverrides({ compaction: { enabled: false } });
	preparing.open();
	assert.equal((await second).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "second", "during", "between"]);
});

test("a message sent the moment a run settles survives an extension starting the next one", async () => {
	const path = await open();
	let woken = false;
	handlers.agent_settled = () => {
		if (woken) return;
		woken = true;
		pi.sendMessage({ customType: "wake", content: "A background task ended.", display: true }, { triggerTurn: true });
	};
	// As the window does: it sends its next queued message when it hears the session is idle.
	let next: ReturnType<typeof host.send> | undefined;
	listen = (event) => {
		if (event.type !== "status" || event.path !== path || event.running || next || !woken) return;
		next = new Promise((done) => setImmediate(done)).then(() => host.send(path, "from the queue", "prompt"));
	};
	await host.send(path, "first", "prompt");
	await until("the idle status", () => next);
	assert.equal((await next!).outcome, "queued");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "from the queue"]);
	assert.deepEqual(notices(), []);
});

test("a steer sent while extensions hear that the run settled starts the next run, not left in pi's queue", async () => {
	const path = await open();
	const menu = gate();
	handlers.agent_settled = menu.pass;
	await host.send(path, "first", "prompt");
	await until("the menu", menu.reached);
	const { session } = live(path);
	assert.deepEqual([session.isStreaming, last(path)?.running], [false, true]);
	const steer = host.send(path, "steered", "steer");
	assert.ok(await pending(steer));
	assert.deepEqual(session.getSteeringMessages(), []);
	handlers = {};
	menu.open();
	assert.equal((await steer).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "steered"]);
});

test("one that fails there rejects to its sender, and the session stays usable", async () => {
	const path = await open();
	const menu = gate();
	handlers.agent_settled = menu.pass;
	await host.send(path, "first", "prompt");
	await until("the menu", menu.reached);
	const { session } = live(path);
	const { model: chosen } = session;
	session.agent.state.model = undefined as never;
	const refused = assert.rejects(host.send(path, "second", "prompt"), /model/i);
	handlers = {};
	menu.open();
	await refused;
	assert.deepEqual(notices(), [], "its sender tells the user");
	session.agent.state.model = chosen!;
	assert.equal((await host.send(path, "third", "prompt")).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "third"]);
});

test("a message an extension deals with, or a command that starts nothing, leaves the session idle and says so", async () => {
	const path = await open();
	handlers.input = () => ({ action: "handled" });
	const taken = await host.send(path, "intercepted", "prompt");
	assert.deepEqual([taken.outcome, taken.status.running], ["handled", false]);
	handlers = {};
	for (const text of ["/probe", "/name Renamed"]) {
		const result = await host.send(path, text, "prompt");
		assert.deepEqual([result.outcome, result.status.running], ["handled", false], text);
	}
	assert.equal(last(path)?.title, "Renamed");
	assert.deepEqual(prompts(path), []);
});

test("a command that starts a run says the session is running", async () => {
	const path = await open();
	const reply = longRun();
	commands.probe = () => pi.sendUserMessage("@@long@@");
	// Extensions look at the run's message first, so it begins well after the command has returned.
	handlers.input = (event) => (event.source === "extension" ? tick() : undefined);
	const result = await host.send(path, "/probe", "prompt");
	assert.equal(result.status.running, true);
	reply.open();
	await settled(path);

	// One that stays for the whole of its run is taken once the run starts.
	handlers = {};
	const second = longRun();
	let returned = false;
	commands.probe = async (_args, ctx) => {
		pi.sendUserMessage("@@long@@");
		await new Promise((done) => setImmediate(done));
		await ctx.waitForIdle();
		returned = true;
	};
	const started = await host.send(path, "/probe", "prompt");
	assert.deepEqual([started.outcome, returned], ["started", false]);
	second.open();
	await until("the command to return", () => returned);
});

test("a run that cannot start rejects and shows the session idle again", async () => {
	const path = await open();
	const { session } = live(path);
	const runner = session.extensionRunner as unknown as { emitBeforeAgentStart: () => Promise<unknown> };
	const original = runner.emitBeforeAgentStart;
	runner.emitBeforeAgentStart = async () => {
		// Something else reports the session's status meanwhile, with pi busy.
		session.setSessionName("Busy");
		throw new Error("cannot prepare");
	};
	await assert.rejects(host.send(path, "first", "prompt"), /cannot prepare/);
	assert.ok(statuses(path).some((event) => event.running));
	assert.equal(last(path)?.running, false);
	runner.emitBeforeAgentStart = original;
	await host.send(path, "second", "prompt");
	await settled(path);
	assert.deepEqual(prompts(path), ["second"]);
});

test("nothing that fails as a run settles keeps the window from hearing it is idle, or pi from going on", async () => {
	const path = await open();
	const { tracker } = live(path);
	const { apply, current } = tracker;
	let deferred = false;
	handlers.agent_settled = () => {
		if (deferred) return;
		deferred = true;
		// pi keeps this until its listeners have heard.
		pi.sendMessage({ customType: "wake", content: "More to do.", display: true }, { triggerTurn: true });
		tracker.apply = () => {
			throw new Error("apply failed");
		};
		tracker.current = () => {
			throw new Error("flush failed");
		};
	};
	onDone = () => {
		throw new Error("notification failed");
	};
	let order: string[] = [];
	listen = (event) => {
		if (event.type === "status" && event.path === path && !event.running) order.push("idle");
		if (event.type === "notice") order.push(event.notice.message);
		// Only this once, so the run that follows is an ordinary one.
		if (event.type === "notice" && event.notice.message === "flush failed") {
			Object.assign(tracker, { apply, current });
			onDone = () => {};
		}
	};
	await host.send(path, "first", "prompt");
	await until("the failures", () => order.includes("flush failed"));
	assert.deepEqual(order.slice(order.indexOf("idle"), order.indexOf("idle") + 4), ["idle", "apply failed", "notification failed", "flush failed"]);
	await until("what the extension asked for", () => live(path).session.messages.filter((message) => message.role === "assistant").length === 2);
	await settled(path);
	order = [];
	assert.equal((await host.send(path, "second", "prompt")).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "second"]);
});

test("/compact is done when its reply comes, and a message sent meanwhile waits rather than failing", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	live(path).session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1 } });
	const compacting = gate();
	handlers.session_before_compact = async () => {
		await compacting.pass();
		return { cancel: true };
	};
	const compact = host.send(path, "/compact", "prompt");
	await until("compaction", compacting.reached);
	assert.equal(last(path)?.compacting, true);
	const next = host.send(path, "second", "prompt");
	assert.ok(await pending(next));
	assert.ok(await pending(compact));
	assert.equal(host.reloadApp("write").includes(path), false);
	compacting.open();
	assert.equal((await compact).outcome, "handled");
	assert.equal((await next).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "second"]);
});

test("an edited message says its run started", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const result = await host.editMessage(path, 0, "better");
	assert.deepEqual([result?.outcome, result?.status.running], ["started", true]);
	await settled(path);
	assert.deepEqual(prompts(path), ["better"]);
});

test("a new session shows at once, and its first message that fails is reported", async () => {
	const preparing = gate();
	handlers.before_agent_start = preparing.pass;
	const { path } = await host.newSession({ app: "write", cwd: folders.project, message: "hello" });
	await until("the run to be prepared", preparing.reached);
	preparing.open();
	await settled(path);
	assert.deepEqual(prompts(path), ["hello"]);

	// Nothing is there for the message to go back to, so the error shows.
	handlers.input = () => {
		const newest = [...(host as unknown as { live: Map<string, Internals> }).live.values()].at(-1)!;
		newest.session.agent.state.model = undefined as never;
	};
	const failing = await host.newSession({ app: "write", cwd: folders.project, message: "hello" });
	await until("the error", () => notices().length);
	assert.match(notices()[0]!, /model/i);
	assert.equal(last(failing.path)?.running, false);
});

test("views and statuses count on, also over a session that was unloaded and opened again", async () => {
	const path = await open();
	const opened = await host.openSession(path);
	const { status } = await host.send(path, "first", "prompt");
	await settled(path);
	const again = await host.openSession(path);
	const told = statuses(path).map((event) => event.rev);
	assert.ok(told.length > 2);
	assert.ok(!told.includes(status.rev));
	assert.ok(existsSync(path));
	assert.ok(host.reloadApp("write").includes(path));
	const reopened = await host.openSession(path);
	assert.equal(reopened.running, false);
	const inOrder = [opened.rev, ...told, again.rev, reopened.rev];
	assert.deepEqual(inOrder, [...new Set(inOrder)].sort((a, b) => a - b));
});

test("closing gives back a message still waiting", async () => {
	const path = await open();
	const menu = gate();
	handlers.agent_settled = menu.pass;
	await host.send(path, "first", "prompt");
	await until("the menu", menu.reached);
	const waiting = assert.rejects(host.send(path, "second", "prompt"), /not open/);
	await tick();
	(host as unknown as { unload: (live: unknown) => void }).unload(live(path));
	await waiting;
	menu.open();
});

test("two messages sent at once while pi looks up credentials: one starts a run, the other joins it", async () => {
	const path = await open();
	const reply = longRun();
	const auth = slowAuth();
	const sent = [host.send(path, "@@long@@", "prompt"), host.send(path, "second", "prompt")];
	await until("both lookups", () => auth.asked() === 2);
	assert.equal(unload(path), false);
	auth.open();
	assert.deepEqual((await Promise.all(sent)).map((result) => result.outcome), ["started", "queued"]);
	await tick();
	assert.deepEqual([live(path).session.isStreaming, last(path)?.running], [true, true], "the first reply is still on its way");
	assert.deepEqual(last(path)?.queue.followUp, ["second"]);
	reply.open();
	await settled(path);
	assert.deepEqual(prompts(path), ["@@long@@", "second"]);
	assert.deepEqual(notices(), []);
});

test("a run an extension starts while pi looks up credentials takes the message, as it says it joins", async () => {
	for (const mode of ["prompt", "steer"] as const) {
		const path = await open();
		const auth = slowAuth();
		const sent = host.send(path, "mine", mode);
		await until("the lookup", () => auth.asked() === 1);
		const preparing = gate();
		handlers.before_agent_start = preparing.pass;
		wake();
		auth.open();
		const { outcome, status } = await sent;
		assert.deepEqual([outcome, status.queue], ["queued", { steering: mode === "steer" ? ["mine"] : [], followUp: mode === "steer" ? [] : ["mine"] }]);
		preparing.open();
		await settled(path);
		assert.deepEqual(prompts(path), ["mine"]);
		assert.deepEqual(notices(), []);
		handlers = {};
		fastAuth();
	}
});

test("messages sent as a run an extension began at session start settles are owned by their senders", async () => {
	for (const fails of [true, false]) {
		const menu = gate();
		handlers.session_start = () => wake();
		handlers.agent_settled = menu.pass;
		const path = await open();
		await until("the menu", menu.reached);
		const { session } = live(path);
		const chosen = session.model;
		if (fails) session.agent.state.model = undefined as never;
		const sent = [host.send(path, "one", "prompt"), host.send(path, "two", "prompt")];
		for (const promise of sent) promise.catch(() => {});
		for (const promise of sent) assert.ok(await pending(promise));
		assert.equal(unload(path), false);
		handlers = {};
		menu.open();
		if (fails) {
			for (const promise of sent) await assert.rejects(promise, /model/i);
			session.agent.state.model = chosen!;
		} else {
			assert.deepEqual((await Promise.all(sent)).map((result) => result.outcome), ["started", "queued"]);
		}
		await settled(path);
		assert.deepEqual(prompts(path), fails ? [] : ["one", "two"]);
		assert.deepEqual(notices(), []);
	}
});

test("what one extension asks for as a run settles does not go with what another asked for and was refused", async () => {
	const path = await open();
	let asked = false;
	handlers.agent_settled = () => {
		if (asked) return;
		asked = true;
		const { session } = live(path);
		const chosen = session.model!;
		handlers.input = (event) => {
			session.agent.state.model = event.text === "kept" ? chosen : (undefined as never);
		};
		pi.sendUserMessage("refused");
		pi.sendUserMessage("kept");
	};
	await host.send(path, "first", "prompt");
	await until("the second", () => prompts(path).includes("kept"));
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "kept"]);
	assert.match(notices().join(), /model/i);
});

test("a session whose stopped run left messages with pi is not unloaded, and the next run takes them", async () => {
	const path = await open();
	const reply = longRun();
	await host.send(path, "@@long@@", "prompt");
	assert.equal((await host.send(path, "kept", "prompt")).outcome, "queued");
	const stopped = host.abort(path);
	reply.open();
	await stopped;
	await settled(path);
	assert.deepEqual(last(path)?.queue.followUp, ["kept"], "Stop means it does not start by itself");
	assert.deepEqual([unload(path), evict(path)], [false, false]);
	await host.send(path, "next", "prompt");
	await settled(path);
	assert.deepEqual(prompts(path).slice(1), ["next", "kept"]);
	assert.equal(evict(path), true);
});

test("a message that joined a run which could not be prepared starts one of its own, with its images", async () => {
	const path = await open();
	const preparing = failPreparation(path);
	const first = assert.rejects(host.send(path, "first", "prompt"), /cannot prepare/);
	await until("the preparation", preparing.reached);
	const image = { type: "image" as const, data: PIXEL, mimeType: "image/png" };
	assert.equal((await host.send(path, "second", "prompt", { prefix: "", images: [image] })).outcome, "queued");
	assert.equal((await host.send(path, "steered", "steer")).outcome, "queued");
	preparing.open();
	await first;
	await until("both", () => prompts(path).length === 2);
	await settled(path);
	assert.deepEqual(prompts(path), ["steered", "second"], "a steer goes first, as it would have");
	const content = live(path).session.messages.filter((message) => message.role === "user")[1]!.content as { type: string }[];
	assert.deepEqual(content.map((part) => part.type), ["text", "image"]);
	assert.deepEqual(last(path)?.queue, { steering: [], followUp: [] });
});

test("one whose own run cannot be prepared either stays with pi, in its place, and the error shows", async () => {
	const path = await open();
	const preparing = failPreparation(path, 2);
	const first = assert.rejects(host.send(path, "first", "prompt"), /cannot prepare/);
	await until("the preparation", preparing.reached);
	for (const text of ["second", "third"]) await host.send(path, text, "prompt");
	preparing.open();
	await first;
	await until("the error", () => notices().length);
	assert.deepEqual([last(path)?.running, last(path)?.queue.followUp], [false, ["second", "third"]]);
	assert.equal(unload(path), false);
	await host.send(path, "fourth", "prompt");
	await settled(path);
	assert.deepEqual(prompts(path), ["fourth", "second", "third"]);
	assert.deepEqual(notices(), ["cannot prepare"]);
});

test("a preparation that fails once the user has stopped it starts nothing", async () => {
	const path = await open();
	const preparing = failPreparation(path);
	const first = host.send(path, "first", "prompt");
	await until("the preparation", preparing.reached);
	await host.send(path, "second", "prompt");
	const stopped = host.abort(path);
	preparing.open();
	assert.equal((await first).outcome, "stopped");
	await stopped;
	await tick();
	assert.deepEqual([last(path)?.running, last(path)?.queue.followUp, prompts(path)], [false, ["second"], []]);
});

test("a run that has nothing to do with a command neither ends it nor lets its session go", async () => {
	const path = await open();
	const menu = gate();
	commands.probe = menu.pass;
	const command = host.send(path, "/probe", "prompt");
	await until("the menu", menu.reached);
	wake();
	await until("the run", () => statuses(path).some((event) => event.running));
	await settled(path);
	assert.ok(await pending(command));
	assert.deepEqual([unload(path), evict(path)], [false, false]);
	menu.open();
	assert.equal((await command).outcome, "handled");
	assert.equal(unload(path), true);
});

test("a command is not done before the message it sends has an outcome", async () => {
	const path = await open();
	const reply = longRun();
	const hook = gate();
	handlers.input = (event) => (event.source === "extension" ? hook.pass() : undefined);
	commands.probe = () => pi.sendUserMessage("@@long@@");
	const command = host.send(path, "/probe", "prompt");
	await until("the hook", hook.reached);
	assert.ok(await pending(command));
	assert.equal(unload(path), false);
	hook.open();
	const result = await command;
	assert.deepEqual([result.outcome, result.status.running], ["started", true]);
	// What the window would send next joins that run rather than making pi refuse it.
	assert.equal((await host.send(path, "next", "prompt")).outcome, "queued");
	reply.open();
	await settled(path);
	assert.deepEqual(prompts(path), ["@@long@@", "next"]);
	assert.deepEqual(notices(), []);
});

test("a command that stays after its run has ended still keeps its session", async () => {
	const path = await open();
	const menu = gate();
	commands.probe = async (_args, ctx) => {
		wake();
		await ctx.waitForIdle();
		await menu.pass();
	};
	assert.equal((await host.send(path, "/probe", "prompt")).outcome, "started");
	await until("the menu", menu.reached);
	await settled(path);
	assert.deepEqual([unload(path), evict(path)], [false, false]);
	menu.open();
	await tick();
	assert.equal(unload(path), true);
});

test("a command whose run waits for the last one's extensions is done once that run starts", async () => {
	const path = await open();
	const menu = gate();
	const command = gate();
	commands.probe = async () => {
		await command.pass();
		pi.sendUserMessage("from the command");
		wake();
	};
	handlers.agent_settled = menu.pass;
	const reply = longRun();
	await host.send(path, "@@long@@", "prompt");
	const sent = host.send(path, "/probe", "prompt");
	await until("the command", command.reached);
	reply.open();
	await until("the menu", menu.reached);
	command.open();
	assert.ok(await pending(sent));
	handlers = {};
	menu.open();
	const result = await sent;
	assert.deepEqual([result.outcome, result.status.running], ["started", true]);
	await settled(path);
	assert.deepEqual(prompts(path), ["@@long@@", "from the command"]);
	assert.deepEqual(notices(), []);
});

test("Stop takes back a message that waits for a settled run's extensions", async () => {
	const path = await open();
	const menu = gate();
	handlers.agent_settled = menu.pass;
	await host.send(path, "first", "prompt");
	await until("the menu", menu.reached);
	const steer = host.send(path, "steered", "steer");
	assert.ok(await pending(steer));
	await host.abort(path);
	assert.equal((await steer).outcome, "stopped");
	handlers = {};
	menu.open();
	await settled(path);
	await tick();
	assert.deepEqual(prompts(path), ["first"]);
	assert.deepEqual(notices(), []);
});

test("Stop takes back a message extensions look at, or pi looks up credentials for", async () => {
	for (const where of ["hook", "auth"] as const) {
		const path = await open();
		const hook = gate();
		if (where === "hook") handlers.input = hook.pass;
		const auth = where === "auth" ? slowAuth() : undefined;
		const sent = host.send(path, "typed", "prompt");
		await until(where, () => hook.reached() || auth?.asked());
		await host.abort(path);
		assert.ok(await pending(sent), "the hook may still deal with it");
		hook.open();
		auth?.open();
		const { outcome, status } = await sent;
		assert.deepEqual([outcome, status.running], ["stopped", false]);
		await tick();
		assert.deepEqual(prompts(path), [], where);
		fastAuth();
		handlers = {};
		assert.equal((await host.send(path, "again", "prompt")).outcome, "started");
		await settled(path);
		assert.deepEqual(prompts(path), ["again"]);
	}
	// One the hook deals with was dealt with, whatever was stopped meanwhile.
	const path = await open();
	const hook = gate();
	handlers.input = async () => {
		await hook.pass();
		return { action: "handled" };
	};
	const sent = host.send(path, "typed", "prompt");
	await until("the hook", hook.reached);
	await host.abort(path);
	hook.open();
	assert.equal((await sent).outcome, "handled");
});

test("Stop takes back a steer an extension looks at, also when the run goes on over it", async () => {
	const path = await open();
	const reply = longRun();
	await host.send(path, "@@long@@", "prompt");
	const hook = gate();
	handlers.input = hook.pass;
	const steer = host.send(path, "steered", "steer");
	await until("the hook", hook.reached);
	const stopped = host.abort(path);
	reply.open();
	await stopped;
	handlers = {};
	wake();
	hook.open();
	assert.equal((await steer).outcome, "stopped");
	await settled(path);
	assert.deepEqual(prompts(path), ["@@long@@"]);
});

test("Stop takes back the message a command sent, and the command is done", async () => {
	const path = await open();
	const hook = gate();
	handlers.input = (event) => (event.source === "extension" ? hook.pass() : undefined);
	commands.probe = () => pi.sendUserMessage("from the command");
	const command = host.send(path, "/probe", "prompt");
	await until("the hook", hook.reached);
	await host.abort(path);
	hook.open();
	assert.equal((await command).outcome, "handled");
	await tick();
	assert.deepEqual(prompts(path), []);
});

test("a message an extension still looks at when its session is deleted never reaches the model", async () => {
	for (const text of ["typed", "/probe"]) {
		const path = await open();
		const { session } = live(path);
		const hook = gate();
		handlers.input = hook.pass;
		commands.probe = () => pi.sendUserMessage("from the command");
		const sent = assert.rejects(host.send(path, text, "prompt"), /not open/);
		await until("the hook", hook.reached);
		await host.deleteSessions([path], async () => {});
		await sent;
		hook.open();
		await tick();
		assert.deepEqual(session.messages.filter((message) => message.role === "user" || message.role === "assistant"), []);
		assert.equal(session.isStreaming, false);
	}
});

test("a session being deleted is not opened again meanwhile, and one that cannot be deleted can be", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const trashing = gate();
	const deleting = assert.rejects(
		host.deleteSessions([path], async () => {
			await trashing.pass();
			throw new Error("no Trash");
		}),
		/no Trash/,
	);
	await until("the Trash", trashing.reached);
	await assert.rejects(host.openSession(path), /no longer exists/);
	trashing.open();
	await deleting;
	assert.ok(events.some((event) => event.type === "unloaded" && event.paths.includes(path)), "the window opens it again");
	assert.equal((await host.openSession(path)).runs.length, 1);
});

test("a session opened while it is unloaded shows the one in its place", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const reading = slowChanges(path);
	const early = host.openSession(path);
	await until("the changes", reading.reached);
	assert.equal(unload(path), true);
	await host.openSession(path);
	const reply = longRun();
	const { status } = await host.send(path, "@@long@@", "prompt");
	reading.open();
	const view = await early;
	assert.deepEqual([view.running, view.runs.length], [true, 2]);
	assert.ok(view.rev > status.rev);
	reply.open();
	await settled(path);
});

test("an unloaded session's late work tells the window nothing about the one in its place", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const reading = slowChanges(path);
	const old = live(path);
	const internals = host as unknown as { emitChanges: (live: unknown) => Promise<unknown>; flush: (live: unknown) => void };
	const late = internals.emitChanges(old);
	await until("the changes", reading.reached);
	assert.equal(unload(path), true);
	await host.openSession(path);
	events = [];
	reading.open();
	await late;
	internals.flush(old);
	await tick();
	assert.deepEqual(events.filter((event) => event.type === "changes" || event.type === "run" || event.type === "status"), []);
});

test("opening a session twice at once starts it once", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	assert.equal(unload(path), true);
	let starts = 0;
	handlers.session_start = async () => {
		starts++;
		await tick();
	};
	const views = await Promise.all([host.openSession(path), host.openSession(path)]);
	assert.equal(starts, 1);
	assert.notEqual(views[0].rev, views[1].rev);
	assert.equal(unload(path), true);
});

test("a session that is still starting is not unloaded", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	assert.equal(unload(path), true);
	const starting = gate();
	handlers.session_start = starting.pass;
	const opened = host.openSession(path);
	await until("its start", starting.reached);
	assert.equal(unload(path), false);
	starting.open();
	await opened;
	assert.equal((await host.send(path, "second", "prompt")).outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["first", "second"]);
});

test("a session is not unloaded between going back for an edit and sending it", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const reading = slowChanges(path);
	const edit = host.editMessage(path, 0, "better");
	await until("the changes", reading.reached);
	assert.deepEqual([unload(path), evict(path)], [false, false]);
	reading.open();
	assert.equal((await edit)?.outcome, "started");
	await settled(path);
	assert.deepEqual(prompts(path), ["better"]);
});

test("an edit of a session deleted under it goes nowhere", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const { session } = live(path);
	const reading = slowChanges(path);
	const edit = assert.rejects(host.editMessage(path, 0, "better"), /not open/);
	await until("the changes", reading.reached);
	await host.deleteSessions([path], async () => {});
	reading.open();
	await edit;
	await tick();
	assert.equal(session.messages.some((message) => message.role === "user" && messageText(message as never) === "better"), false);
});

test("an edit that cannot be sent once the conversation went back comes with its files and images", async () => {
	const path = await open();
	const image = { type: "image" as const, data: PIXEL, mimeType: "image/png" };
	await host.send(path, "first", "prompt", { prefix: '<file name="/notes.txt">\nhello\n</file>\n<file name="/dot.png"></file>\n', images: [image, image] });
	await settled(path);
	const { session } = live(path);
	const chosen = session.model!;
	session.agent.state.model = undefined as never;
	const result = await host.editMessage(path, 0, "");
	session.agent.state.model = chosen;
	assert.ok(result?.outcome === "returned");
	assert.match(result.error!, /model/i);
	assert.deepEqual([result.status.running, result.prompt], [false, ""]);
	assert.deepEqual(result.files.map((file) => [file.label, file.text, file.image?.mimeType]), [
		["/notes.txt", "hello", undefined],
		["/dot.png", undefined, "image/png"],
		["Image", undefined, "image/png"],
	]);
	assert.deepEqual(prompts(path), []);

	// Stopped rather than refused, there is no error to show.
	await host.send(path, "second", "prompt");
	await settled(path);
	const hook = gate();
	handlers.input = hook.pass;
	const edit = host.editMessage(path, 0, "changed");
	await until("the hook", hook.reached);
	await host.abort(path);
	hook.open();
	const stopped = await edit;
	assert.ok(stopped?.outcome === "returned");
	assert.deepEqual([stopped.error, stopped.prompt, stopped.files], [undefined, "changed", []]);
});

test("a new session's first message that does not go out is handed back to its box", async () => {
	handlers.input = () => {
		const newest = [...(host as unknown as { live: Map<string, Internals> }).live.values()].at(-1)!;
		newest.session.agent.state.model = undefined as never;
	};
	const { path } = await host.newSession({ app: "write", cwd: folders.project, message: "hello" });
	await until("the message", () => events.some((event) => event.type === "returned"));
	assert.deepEqual(
		events.filter((event) => event.type === "returned"),
		[{ type: "returned", path, draft: { text: "hello", attachments: [] } }],
	);
});

test("what the window is told about a session counts on", async () => {
	const path = await open();
	await host.send(path, "first", "prompt");
	await settled(path);
	const { rev } = await host.openSession(path);
	const revs = events.flatMap((event) => (event.type === "run" || event.type === "status" || event.type === "changes" ? [event.rev] : []));
	assert.ok(events.some((event) => event.type === "run"));
	assert.deepEqual(revs, [...new Set(revs)].sort((a, b) => a - b));
	assert.ok(rev > revs.at(-1)!);
});

test("pi has what the dispatcher uses of it", async () => {
	const { session } = live(await open());
	assert.deepEqual(INTERNALS.filter((name) => !(name in session)), []);
	for (const name of ["_startRun", "_queueSteer", "_queueFollowUp"]) assert.equal(typeof Object.getPrototypeOf(session)[name], "function", name);
});
