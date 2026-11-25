import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n.ts";
import type { SendOutcome } from "../shared/protocol.ts";

/** How a message joins a run that is going; without one it starts its own either way. */
export type Delivery = "steer" | "followUp";

type RunTrigger = { messageType: "user"; prompt: string; images?: ImageContent[] } | { messageType: "custom"; message: AgentMessage };

/**
 * What of pi's AgentSession is private and used here all the same. pi decides whether a message starts a run or joins
 * one, then waits for extensions and credentials, and starts the run without looking again; nothing public comes
 * between. The pi version is pinned, and host-queue.test.ts checks these against it.
 */
interface Internals {
	/** The run is over and extensions hear so. pi puts off what would start another until they have. */
	readonly _isEmittingAgentSettled: boolean;
	readonly _deferredSettledActions: (() => Promise<void>)[];
	/** Whether the current or last run was stopped. */
	readonly _agentRunAbortRequested: boolean;
	_startRun(trigger: RunTrigger, onStarted?: () => void): Promise<void>;
	_queueSteer(text: string, images?: ImageContent[]): Promise<void>;
	_queueFollowUp(text: string, images?: ImageContent[]): Promise<void>;
	_emitQueueUpdate(): void;
}

export const INTERNALS = ["_startRun", "_queueSteer", "_queueFollowUp", "_emitQueueUpdate", "_isEmittingAgentSettled", "_deferredSettledActions", "_agentRunAbortRequested"] as const;

type DispatchedSession = Pick<
	AgentSession,
	"isStreaming" | "isCompacting" | "prompt" | "sendCustomMessage" | "waitForIdle" | "subscribe" | "getSteeringMessages" | "getFollowUpMessages"
> & {
	agent: Pick<
		AgentSession["agent"],
		"signal" | "abort" | "steer" | "followUp" | "steeringMode" | "followUpMode" | "peekQueuedMessages" | "clearSteeringQueue" | "clearFollowUpQueue"
	>;
	extensionRunner: Pick<AgentSession["extensionRunner"], "getCommand">;
};

/** The user pressed Stop before pi took a message. */
class Stopped extends Error {
	constructor() {
		super(t("Stopped before it was sent."));
	}
}

/** A message on its way into a run: one the host sends, or one an extension does. */
class Admission {
	readonly outcome: Promise<SendOutcome>;
	decided = false;
	/** Must not reach a run any more. */
	stopped = false;
	readonly mode: Delivery;
	readonly command: boolean;
	/** pi has it. From then on only pi can say what becomes of it. */
	private entered = false;
	/** pi's prompt() came back and said nothing. */
	private silent = false;
	/** A command's handler, or an extension, has dealt with it. */
	private done = false;
	/** What the command, or the extension that deals with this message, sends meanwhile. */
	private readonly children = new Set<Admission>();
	private parent: Admission | undefined;
	private resolve!: (outcome: SendOutcome) => void;
	private reject!: (error: unknown) => void;

	constructor(mode: Delivery, command = false) {
		this.mode = mode;
		this.command = command;
		this.outcome = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
		// An extension's messages have no one waiting here.
		this.outcome.catch(() => {});
	}

	enter(): void {
		this.entered = true;
	}

	/** Whatever starts this is not done until this has an outcome. */
	within(parent: Admission | undefined): void {
		if (!parent || parent.decided) return;
		this.parent = parent;
		parent.children.add(this);
	}

	decide(outcome: SendOutcome): void {
		if (this.decided) return;
		this.decided = true;
		this.resolve(outcome);
		// pi reports a command only once its handler returns, which can be long after a run it started.
		if (outcome === "started" && this.parent?.command) this.parent.decide("started");
	}

	fail(error: unknown): void {
		if (this.decided) return;
		if (this.stopped || error instanceof Stopped) {
			this.decide("stopped");
			return;
		}
		this.decided = true;
		this.reject(error);
	}

	/** A command or an extension dealt with it. What that sent decides whether a run follows. */
	async handled(): Promise<void> {
		this.done = true;
		const outcomes = new Set<SendOutcome>();
		// Those added while this waits are gone through too.
		for (const child of this.children) outcomes.add(await child.outcome.catch((): SendOutcome => "handled"));
		this.decide(outcomes.has("started") ? "started" : outcomes.has("queued") ? "queued" : "handled");
	}

	/** That prompt() came back does not say what became of the message: pi may have put it off. */
	returned(): void {
		this.silent = true;
		if (this.stopped) this.decide("stopped");
	}

	stop(): void {
		if (this.decided) return;
		for (const child of this.children) child.stop();
		if (this.done) return;
		if (!this.entered || this.silent) this.decide("stopped");
		// A command's handler goes on; only what it sent is stopped.
		else if (!this.command) this.stopped = true;
	}
}

/** Whose message pi is working on, followed through everything pi and extensions wait for. */
const current = new AsyncLocalStorage<Admission>();

/**
 * Hands messages to one session, and stands between the session's extensions and its runs so that each message starts
 * a run, joins one, or comes back to whoever sent it.
 */
export class Dispatcher {
	/** The host's messages whose outcome is not known. */
	private readonly pending = new Set<Admission>();
	/** Calls into pi that have not come back: a run, a command's handler, or a message extensions look at. */
	private working = 0;
	private closed = false;
	private wakers: (() => void)[] = [];
	private readonly session: DispatchedSession;
	private readonly internals: Internals;
	private readonly onError: (error: unknown) => void;
	private readonly pi: Pick<DispatchedSession, "prompt" | "sendCustomMessage"> & Pick<Internals, "_startRun" | "_queueSteer" | "_queueFollowUp">;
	private readonly unsubscribe: () => void;

	/** `onError` hears of what fails after its message was taken. Made before extensions can start a run. */
	constructor(session: DispatchedSession, onError: (error: unknown) => void) {
		const internals = session as unknown as Internals;
		this.session = session;
		this.internals = internals;
		this.onError = onError;
		this.pi = {
			prompt: session.prompt.bind(session),
			sendCustomMessage: session.sendCustomMessage.bind(session),
			_startRun: internals._startRun.bind(session),
			_queueSteer: internals._queueSteer.bind(session),
			_queueFollowUp: internals._queueFollowUp.bind(session),
		};
		// Extensions' messages come through these too.
		session.prompt = (text, options) => {
			const command = options?.expandPromptTemplates !== false && this.isCommand(text);
			return this.nested(new Admission(options?.streamingBehavior ?? "followUp", command), (admission) => this.prompt(admission, text, options));
		};
		session.sendCustomMessage = (message, options) => this.sendCustomMessage(message, options);
		internals._startRun = (trigger, onStarted) => this.startRun(trigger, onStarted);
		internals._queueSteer = async (text, images) => {
			this.check(current.getStore());
			return this.pi._queueSteer(text, images);
		};
		internals._queueFollowUp = async (text, images) => {
			this.check(current.getStore());
			return this.pi._queueFollowUp(text, images);
		};
		this.unsubscribe = session.subscribe((event) => {
			// pi counts as settled once its listeners have heard, so those waiting look again right after.
			if (event.type === "agent_settled") this.wake();
		});
	}

	/** Whether unloading the session would cut something off: a message, a run, or a command that is not done. */
	get busy(): boolean {
		return this.pending.size > 0 || this.working > 0;
	}

	/**
	 * Resolves with what became of the message, without waiting for its run. Rejects, or resolves with "stopped", when
	 * it reached no run and will not any more, so the caller still has it.
	 */
	async send(text: string, options: { mode: Delivery; images?: ImageContent[] }): Promise<SendOutcome> {
		const { mode, images } = options;
		const admission = new Admission(mode, this.isCommand(text));
		if (this.closed) throw closed();
		this.pending.add(admission);
		try {
			while (!admission.decided) {
				const wait = this.notReady(admission.command);
				if (!wait) {
					admission.enter();
					// Nothing waits between the look and the call.
					void this.enter(admission, text, { images, streamingBehavior: mode });
					break;
				}
				await Promise.race([wait, admission.outcome.catch(() => {})]);
			}
			return await admission.outcome;
		} finally {
			this.pending.delete(admission);
		}
	}

	/** Gives back every message that is in no run yet, such as when the user presses Stop. */
	stop(): void {
		for (const admission of this.pending) admission.stop();
		this.wake();
	}

	/** Nothing reaches a run of this session any more. Comes before the session is disposed of. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const admission of this.pending) admission.fail(closed());
		this.unsubscribe();
		this.wake();
	}

	private async enter(admission: Admission, text: string, options: PromptOptions): Promise<void> {
		try {
			await this.run(admission, () => this.prompt(admission, text, options));
			admission.returned();
		} catch (error) {
			if (admission.decided) {
				// Closing and stopping have told the sender already.
				if (!this.closed && !(error instanceof Stopped)) this.onError(error);
			} else admission.fail(error);
		}
	}

	/** pi's prompt(), which every message of the user's or an extension's goes through. */
	private prompt(admission: Admission, text: string, options: PromptOptions | undefined): Promise<void> {
		return this.pi.prompt(text, {
			...options,
			preflightResult: (outcome) => {
				if (outcome === "handled") void admission.handled();
				// "started" comes just before the run does, which startRun sees happen.
				else if (outcome === "queued") admission.decide("queued");
				options?.preflightResult?.(outcome);
			},
		});
	}

	private sendCustomMessage(...[message, options]: Parameters<AgentSession["sendCustomMessage"]>): Promise<void> {
		if (!options?.triggerTurn || options.deliverAs === "nextTurn") return this.pi.sendCustomMessage(message, options);
		return this.nested(new Admission(options.deliverAs === "followUp" ? "followUp" : "steer"), async (admission) => {
			await this.pi.sendCustomMessage(message, options);
			// Without a run of its own, it is in the queue of the one going.
			admission.decide("queued");
		});
	}

	/** A message an extension sends, perhaps while it deals with one of the host's. */
	private async nested(admission: Admission, call: (admission: Admission) => Promise<void>): Promise<void> {
		admission.enter();
		admission.within(current.getStore());
		try {
			await this.run(admission, () => call(admission));
		} catch (error) {
			admission.fail(error);
			throw error;
		}
	}

	/** Calls into pi on an admission's behalf. */
	private async run(admission: Admission, call: () => Promise<void>): Promise<void> {
		this.working++;
		try {
			this.check(admission);
			const inside = () => current.run(admission, call);
			await (this.internals._isEmittingAgentSettled ? this.later(admission, inside) : inside());
		} finally {
			this.working--;
		}
	}

	/**
	 * Puts an extension's message off until a settled run's extensions have heard, as pi does, but so that one that
	 * fails tells its sender rather than that run's, and those put off after it still get their turn.
	 */
	private later(admission: Admission, call: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			this.internals._deferredSettledActions.push(async () => {
				try {
					this.check(admission);
					await call();
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	/**
	 * Starts a run, if by now it still should: what pi found before it waited for extensions and credentials may have
	 * changed. A message whose run would be a second one joins the first.
	 */
	private async startRun(trigger: RunTrigger, onStarted?: () => void): Promise<void> {
		const { session } = this;
		const admission = current.getStore();
		for (;;) {
			this.check(admission);
			if (session.isStreaming) return this.join(trigger, admission);
			const wait = this.notReady(false);
			if (!wait) break;
			await wait;
		}
		let prepared = false;
		try {
			await this.pi._startRun(trigger, () => {
				prepared = true;
				const before = session.agent.signal;
				onStarted?.();
				queueMicrotask(() => {
					if (this.closed) session.agent.abort();
					// Only now has the model's loop taken it.
					else if (session.agent.signal && session.agent.signal !== before) admission?.decide("started");
				});
			});
		} catch (error) {
			if (!prepared) this.resume();
			throw error;
		}
	}

	private async join(trigger: RunTrigger, admission: Admission | undefined): Promise<void> {
		const { agent } = this.session;
		const steer = admission?.mode === "steer";
		if (trigger.messageType === "custom") steer ? agent.steer(trigger.message) : agent.followUp(trigger.message);
		else await (steer ? this.pi._queueSteer : this.pi._queueFollowUp)(trigger.prompt, trigger.images);
		admission?.decide("queued");
	}

	/**
	 * A run that could not be prepared leaves what joined it in pi's queue, where it would wait for some other run.
	 * The first starts one, which takes the rest. Not after Stop: those wait for the user's next message.
	 */
	private resume(): void {
		const { session, internals } = this;
		if (this.closed || session.isStreaming || internals._agentRunAbortRequested) return;
		const queues = takeQueues(session.agent);
		const steer = queues.steering.length > 0;
		const message = (steer ? queues.steering : queues.followUp).shift();
		putQueues(session.agent, queues);
		if (!message) return;
		const text = message.role === "user" ? textOf(message.content) : undefined;
		// What pi shows as queued, which it keeps apart.
		const shown = () => (steer ? session.getSteeringMessages() : session.getFollowUpMessages()) as string[];
		const at = text === undefined ? -1 : shown().indexOf(text);
		if (at >= 0) shown().splice(at, 1);
		internals._emitQueueUpdate();
		const trigger: RunTrigger =
			text === undefined ? { messageType: "custom", message } : { messageType: "user", prompt: text, images: imagesOf((message as { content: unknown }).content) };
		let prepared = false;
		this.working++;
		current
			.run(new Admission(steer ? "steer" : "followUp"), () => this.pi._startRun(trigger, () => (prepared = true)))
			.catch((error: unknown) => {
				if (this.closed) return;
				if (!prepared) {
					// Back in front, for the next run. Trying again at once would fail again.
					const rest = takeQueues(session.agent);
					(steer ? rest.steering : rest.followUp).unshift(message);
					putQueues(session.agent, rest);
					if (at >= 0) shown().splice(at, 0, text!);
					internals._emitQueueUpdate();
				}
				this.onError(error);
			})
			.finally(() => this.working--);
	}

	/**
	 * What to wait for while pi takes no message: while a settled run's extensions hear of it, which can last as long
	 * as a menu one shows, and during /compact or while the conversation goes back. Commands run while pi compacts.
	 */
	private notReady(command: boolean): Promise<void> | undefined {
		const { session } = this;
		if (session.isStreaming) return undefined;
		if (this.internals._isEmittingAgentSettled) return this.change();
		if (session.isCompacting && !command) return Promise.race([session.waitForIdle(), this.change()]);
		return undefined;
	}

	/** Something those waiting wait for may have happened. */
	private change(): Promise<void> {
		return new Promise((resolve) => this.wakers.push(resolve));
	}

	private wake(): void {
		const wakers = this.wakers;
		this.wakers = [];
		for (const waker of wakers) waker();
	}

	private check(admission: Admission | undefined): void {
		if (this.closed) throw closed();
		if (admission?.stopped && !admission.decided) throw new Stopped();
	}

	/** Read from the text as pi reads it. Prompt templates and skills are messages, not commands. */
	private isCommand(text: string): boolean {
		return text.startsWith("/") && this.session.extensionRunner.getCommand(text.slice(1).split(" ")[0]!) !== undefined;
	}
}

interface Queues {
	steering: AgentMessage[];
	followUp: AgentMessage[];
}

/** Empties the queues and returns what they held, images and all. pi's own clearQueue() returns only the text. */
function takeQueues(agent: DispatchedSession["agent"]): Queues {
	const { steeringMode, followUpMode } = agent;
	agent.steeringMode = agent.followUpMode = "all";
	// This shows what steers, and what follows only when nothing does.
	const first = agent.peekQueuedMessages();
	agent.clearSteeringQueue();
	const followUp = agent.peekQueuedMessages();
	agent.clearFollowUpQueue();
	Object.assign(agent, { steeringMode, followUpMode });
	return { steering: first[0] === followUp[0] ? [] : [...first], followUp: [...followUp] };
}

function putQueues(agent: DispatchedSession["agent"], { steering, followUp }: Queues): void {
	for (const message of steering) agent.steer(message);
	for (const message of followUp) agent.followUp(message);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return (content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text : "")).join("");
}

function imagesOf(content: unknown): ImageContent[] | undefined {
	const images = Array.isArray(content) ? content.filter((part): part is ImageContent => part.type === "image") : [];
	return images.length ? images : undefined;
}

function closed(): Error {
	return new Error(t("This session is not open."));
}
