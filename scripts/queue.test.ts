import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { AttachmentInfo, EditResult, HostEvent, SendOutcome, SendResult, SessionStatus, SessionView } from "../src/shared/protocol.ts";

/** The renderer's store as the window runs it, with the host and the browser played by the test. */

interface Sent {
	path: string;
	text: string;
	mode: string;
	/** Answers as the host does once pi took the message; `status` is the session at that moment. */
	take: (outcome: SendOutcome, status: Partial<SessionStatus>) => Promise<void>;
	refuse: (message: string) => Promise<void>;
}

let rev = 0;
let sent: Sent[] = [];
let emit: (event: HostEvent) => void = () => {};
/** What openSession and editMessage answer. */
let onOpen: (path: string) => Promise<SessionView> = async (path) => view(path);
let onEdit: (path: string) => Promise<EditResult | undefined> = async () => undefined;
/** Attachments the window gave up. */
let dropped: string[] = [];
/** View transitions waiting for the browser to run them. */
let transitions: (() => void)[] = [];
let slowTransitions = false;

const idle = { compacting: false, queue: { steering: [], followUp: [] }, title: "Session" };

function status(path: string, running: boolean, rest: Partial<SessionStatus> = {}): SessionStatus {
	return { path, rev: ++rev, running, ...idle, ...rest };
}

function view(path: string, rest: Partial<SessionView> = {}): SessionView {
	return { path, rev: ++rev, id: path, cwd: "/project", chat: false, app: "code", runs: [], running: false, thinkingLevel: "off", changes: [], ...idle, ...rest };
}

const tell = (path: string, running: boolean, rest: Partial<SessionStatus> = {}) => emit({ type: "status", ...status(path, running, rest) });

/** Lets every promise already answered run on. */
const settle = () => new Promise((done) => setImmediate(done));

const host: Record<string, (...args: any[]) => unknown> = {
	onEvent: (listener: typeof emit) => {
		emit = listener;
	},
	openSession: (path: string) => onOpen(path),
	editMessage: (path: string) => onEdit(path),
	listSessions: async () => [],
	listModels: async () => [],
	services: async () => [],
	dropAttachments: async (ids: string[]) => void dropped.push(...ids),
	send: (path: string, text: string, mode: string) =>
		new Promise<SendResult>((resolve, reject) => {
			sent.push({
				path,
				text,
				mode,
				take: (outcome, rest) => {
					resolve({ outcome, status: status(path, false, rest) });
					return settle() as Promise<void>;
				},
				refuse: (message) => {
					reject(new Error(message));
					return settle() as Promise<void>;
				},
			});
		}),
};

Object.assign(globalThis, {
	window: { trivium: new Proxy(host, { get: (target, name: string) => target[name] ?? (async () => undefined) }) },
	matchMedia: () => ({ matches: false }),
	document: {
		documentElement: { dataset: {} },
		hidden: false,
		startViewTransition: (update: () => void) => {
			if (slowTransitions) transitions.push(update);
			else update();
			return { finished: Promise.resolve() };
		},
	},
});

const store = await import("../src/renderer/store.ts");
await store.init();

afterEach(() => {
	sent = [];
	dropped = [];
	transitions = [];
	slowTransitions = false;
	onOpen = async (path) => view(path);
	onEdit = async () => undefined;
	// Error notices dismiss themselves on timers that would keep the process up.
	for (const notice of store.getState().notices) store.dismissNotice(notice.id);
});

let sessions = 0;

/** A session open on screen, running or not. */
function open(running = false): string {
	const path = `/sessions/${++sessions}.jsonl`;
	emit({ type: "view", view: view(path, { running }) });
	return path;
}

const queue = (path: string, text: string) => store.queueMessage(path, { text, attachments: [] });
const rows = (path: string) => store.getState().queued[path] ?? [];
/** What waits in the queue, without what is on its way out. */
const texts = (path: string) => rows(path).flatMap((message) => (message.sending ? [] : [message.text]));
const file = (id: string): AttachmentInfo => ({ id, name: `${id}.txt`, kind: "file", size: 1 });
const draft = (path: string) => store.getState().drafts[path];
/** A message box: what it holds, taking drafts in as Composer does. */
const take = (path: string, box: { text: string; attachments: AttachmentInfo[] }) => {
	const waiting = draft(path);
	store.setState({ drafts: {} });
	return waiting ? store.placeDraft(box, waiting) : box;
};
const held = (path: string) => store.getState().held[path] ?? false;
const outbox = () => sent.map((message) => message.text);
/** Composer's Stop button. */
const stop = (path: string) => store.holdQueue(path);

test("a message queued during a run goes out when it ends, and the next when that one's run does", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	assert.deepEqual(outbox(), []);
	tell(path, false);
	assert.deepEqual(outbox(), ["one"]);
	assert.deepEqual(texts(path), ["two"]);
	await sent[0]!.take("started", { running: true });
	tell(path, true);
	assert.deepEqual(outbox(), ["one"], "one per run");
	tell(path, false);
	assert.deepEqual(outbox(), ["one", "two"]);
});

test("Stop with an empty queue holds nothing that is queued later", async () => {
	const path = open(true);
	stop(path);
	assert.equal(held(path), false);
	tell(path, false);
	// A background command's result starts a run the user did not send.
	tell(path, true);
	queue(path, "later");
	tell(path, false);
	assert.deepEqual(outbox(), ["later"]);
});

test("Stop, then Enter while the run is still ending, sends once it has", async () => {
	const path = open(true);
	stop(path);
	queue(path, "instead");
	assert.deepEqual(outbox(), []);
	tell(path, false);
	assert.deepEqual(outbox(), ["instead"]);
});

test("Stop keeps what was queued, and shows it, until the user sends again", async () => {
	const path = open(true);
	queue(path, "kept");
	stop(path);
	assert.equal(held(path), true);
	tell(path, false);
	tell(path, true);
	tell(path, false);
	assert.deepEqual(outbox(), [], "held over other runs too");
	const done = store.sendMessage(path, "typed", "prompt", []);
	assert.equal(held(path), false);
	tell(path, false);
	assert.deepEqual(outbox(), ["typed"], "the queue waits for the message on its way");
	await sent[0]!.take("started", { running: true });
	assert.equal(await done, true);
	tell(path, false);
	assert.deepEqual(outbox(), ["typed", "kept"]);
});

test("queueing another message ends a hold, and the queue goes out in order", async () => {
	const path = open(true);
	queue(path, "first");
	stop(path);
	queue(path, "second");
	assert.equal(held(path), false);
	tell(path, false);
	assert.deepEqual(outbox(), ["first"]);
	assert.deepEqual(texts(path), ["second"]);
});

test("a hold goes with the last message it was on", () => {
	for (const empty of [store.deleteQueued, store.unqueueMessage]) {
		const path = open(true);
		queue(path, "dropped");
		stop(path);
		empty(path, store.getState().queued[path]![0]!.id);
		assert.equal(held(path), false);
		queue(path, "new");
		tell(path, false);
		assert.equal(sent.at(-1)?.text, "new");
	}
});

test("sending a held message by hand lets the rest follow", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	stop(path);
	tell(path, false);
	void store.sendQueuedNow(path, store.getState().queued[path]![1]!.id);
	assert.deepEqual([outbox(), sent[0]!.mode], [["two"], "prompt"]);
	await sent[0]!.take("started", { running: true });
	tell(path, false);
	assert.deepEqual(outbox(), ["two", "one"]);
});

test("Stop, then a resent earlier message, then queueing during its run", async () => {
	const path = open(true);
	queue(path, "waiting");
	stop(path);
	tell(path, false);
	onEdit = async () => {
		// As the host does: the conversation goes back first, with nothing running yet.
		emit({ type: "view", view: view(path) });
		return { outcome: "started", status: status(path, true) };
	};
	assert.equal(await store.editMessage(path, 0, "better"), true);
	assert.equal(held(path), false);
	queue(path, "after");
	assert.deepEqual(outbox(), []);
	tell(path, false);
	assert.deepEqual(outbox(), ["waiting"]);
	await sent[0]!.take("started", { running: true });
	tell(path, false);
	assert.deepEqual(outbox(), ["waiting", "after"]);
});

test("the queue does not slip in between an edit going back and its message going out", async () => {
	const path = open();
	let answer: (result: SendResult) => void = () => {};
	onEdit = () => new Promise((resolve) => (answer = resolve));
	const done = store.editMessage(path, 0, "better");
	queue(path, "next");
	emit({ type: "view", view: view(path) });
	assert.deepEqual(outbox(), []);
	answer({ outcome: "started", status: status(path, true) });
	assert.equal(await done, true);
	assert.deepEqual(outbox(), []);
	tell(path, false);
	assert.deepEqual(outbox(), ["next"]);
});

test("Stop while an edit is on its way holds the queue again", async () => {
	const path = open(true);
	queue(path, "waiting");
	stop(path);
	tell(path, false);
	onEdit = async () => {
		stop(path);
		return { outcome: "started", status: status(path, true) };
	};
	assert.equal(await store.editMessage(path, 0, "better"), true);
	tell(path, false);
	assert.deepEqual([outbox(), held(path)], [[], true]);
});

test("an edit that fails keeps the hold, and its text once the conversation went back", async () => {
	const path = `/sessions/${++sessions}.jsonl`;
	const runs = [{ prompt: "old", steps: [] }] as unknown as SessionView["runs"];
	emit({ type: "view", view: view(path, { runs, running: true }) });
	queue(path, "waiting");
	stop(path);
	tell(path, false);
	onEdit = async () => undefined;
	assert.equal(await store.editMessage(path, 0, "refused"), false);
	onEdit = async () => {
		throw new Error("Stop the run");
	};
	assert.equal(await store.editMessage(path, 0, "refused"), false);
	assert.equal(draft(path), undefined, "still in its editor");
	onEdit = async () => {
		emit({ type: "view", view: view(path) });
		return { outcome: "returned", status: status(path, false), error: "No model selected", draft: { text: "better", attachments: [file("notes")] } };
	};
	assert.equal(await store.editMessage(path, 0, "better"), false);
	assert.deepEqual(take(path, { text: "typed since", attachments: [file("new")] }), { text: "better\n\ntyped since", attachments: [file("notes"), file("new")] });
	assert.equal(store.getState().notices.at(-1)?.message, "No model selected");
	assert.equal(held(path), true);
	assert.deepEqual(outbox(), []);
});

test("a message queued just after the session went idle goes out at once", () => {
	const path = open();
	queue(path, "late");
	assert.deepEqual(outbox(), ["late"]);
	assert.deepEqual(texts(path), []);
});

test("a message the host refuses goes back in its place, held and shown", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	tell(path, false);
	await sent[0]!.refuse("No API key");
	assert.deepEqual(texts(path), ["one", "two"]);
	assert.equal(held(path), true);
	assert.equal(store.getState().notices.at(-1)?.message, "No API key");
	tell(path, false);
	assert.deepEqual(outbox(), ["one"], "it is not tried over and over");
});

test("a message refused because a run got in first goes out when that run ends", async () => {
	const path = open(true);
	queue(path, "/compact");
	tell(path, false);
	tell(path, true);
	await sent[0]!.refuse("Wait for the run to finish");
	assert.deepEqual([texts(path), held(path)], [["/compact"], false]);
	tell(path, false);
	assert.deepEqual(outbox(), ["/compact", "/compact"]);
});

test("a message typed in the box that fails puts a hold back and starts nothing", async () => {
	const path = open(true);
	queue(path, "kept");
	stop(path);
	tell(path, false);
	const done = store.sendMessage(path, "typed", "prompt", []);
	await sent[0]!.refuse("offline");
	assert.equal(await done, false);
	assert.equal(held(path), true);
	assert.deepEqual(outbox(), ["typed"]);
	assert.equal(take(path, { text: "", attachments: [] }).text, "typed");
});

test("Stop while a message is on its way keeps the rest held once it is taken", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	tell(path, false);
	stop(path);
	await sent[0]!.take("started", { running: true });
	tell(path, false);
	assert.deepEqual([outbox(), held(path)], [["one"], true]);
});

test("a message that starts no run lets the next go, with no event and no wait", async () => {
	const path = open(true);
	for (const text of ["/name New", "intercepted", "last"]) queue(path, text);
	tell(path, false);
	await sent[0]!.take("handled", { running: false });
	await sent[1]!.take("handled", { running: false });
	assert.deepEqual(outbox(), ["/name New", "intercepted", "last"]);
});

test("a command that takes its time holds the queue until it is done", async () => {
	const path = open(true);
	queue(path, "/slow");
	queue(path, "next");
	tell(path, false);
	tell(path, false);
	await new Promise((done) => setTimeout(done, 1200));
	assert.deepEqual(outbox(), ["/slow"]);
	await sent[0]!.take("handled", { running: false });
	assert.deepEqual(outbox(), ["/slow", "next"]);
});

test("a command that leaves a run going holds the queue until that run ends", async () => {
	const path = open(true);
	queue(path, "/plan");
	queue(path, "next");
	tell(path, false);
	await sent[0]!.take("handled", { running: true });
	assert.deepEqual(outbox(), ["/plan"]);
	tell(path, false);
	assert.deepEqual(outbox(), ["/plan", "next"]);
});

test("compaction before a queued message's run does not let the next one out", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	tell(path, false);
	tell(path, true, { compacting: true });
	tell(path, true);
	// Even were the host to call itself idle here, the first message has no outcome yet.
	tell(path, false);
	assert.deepEqual(outbox(), ["one"]);
	await sent[0]!.take("started", { running: true });
	assert.deepEqual(outbox(), ["one"]);
});

test("a reply that reaches the window after its run ended does not bring the run back", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	tell(path, false);
	const early = status(path, true);
	tell(path, true);
	tell(path, false);
	await sent[0]!.take("started", early);
	assert.equal(store.getState().views[path]!.running, false);
	assert.deepEqual(outbox(), ["one", "two"]);
});

test("a queued message sent by hand while only compacting goes first once that is done", async () => {
	const path = open();
	tell(path, false, { compacting: true });
	queue(path, "one");
	queue(path, "two");
	await store.sendQueuedNow(path, store.getState().queued[path]![1]!.id);
	assert.deepEqual([outbox(), texts(path)], [[], ["two", "one"]]);
	tell(path, false);
	assert.deepEqual(outbox(), ["two"]);
});

test("a message steered by hand is not overtaken by the queue, also when its run ends first", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	void store.sendQueuedNow(path, rows(path)[0]!.id);
	assert.equal(sent[0]!.mode, "steer");
	tell(path, false);
	assert.deepEqual(outbox(), ["one"], "an extension may still look at it");
	await sent[0]!.take("started", { running: true });
	assert.deepEqual(outbox(), ["one"], "it started the next run");
	tell(path, false);
	assert.deepEqual(outbox(), ["one", "two"]);

	// So with one steered from the message box.
	const other = open(true);
	queue(other, "queued");
	void store.sendMessage(other, "steered", "steer", []);
	tell(other, false);
	assert.deepEqual(outbox().slice(2), ["steered"]);
	await sent[2]!.take("queued", { running: false });
	assert.deepEqual(outbox().slice(2), ["steered", "queued"]);
});

test("messages sent by hand keep their places until each has gone out", async () => {
	const path = open(true);
	for (const text of ["A", "B", "C"]) queue(path, text);
	void store.sendQueuedNow(path, rows(path)[0]!.id);
	void store.sendQueuedNow(path, rows(path)[1]!.id);
	assert.deepEqual(rows(path).map((message) => [message.text, message.sending ?? false]), [["A", true], ["B", true], ["C", false]]);
	await sent[0]!.refuse("no");
	await sent[1]!.refuse("no");
	assert.deepEqual(texts(path), ["A", "B", "C"]);

	// Whichever comes back first, and with one between them gone.
	for (const text of ["A", "B", "C"]) void store.sendQueuedNow(path, rows(path).find((message) => message.text === text)!.id);
	await sent[4]!.refuse("no");
	await sent[3]!.take("queued", { running: true });
	await sent[2]!.refuse("no");
	assert.deepEqual(texts(path), ["A", "C"]);
});

test("a message on its way can be neither taken back, deleted nor sent again", async () => {
	const path = open(true);
	store.queueMessage(path, { text: "one", attachments: [file("one")] });
	const { id } = rows(path)[0]!;
	void store.sendQueuedNow(path, id);
	assert.equal(store.unqueueMessage(path, id), undefined);
	store.deleteQueued(path, id);
	void store.sendQueuedNow(path, id);
	assert.deepEqual([outbox(), dropped, rows(path).length], [["one"], [], 1]);
	await sent[0]!.take("queued", { running: true });
	assert.equal(path in store.getState().queued, false);
});

test("one the host was stopped from sending stays queued, held and without an error", async () => {
	const path = open(true);
	queue(path, "one");
	queue(path, "two");
	void store.sendQueuedNow(path, rows(path)[0]!.id);
	stop(path);
	// The stopped run's extensions still hear of it.
	await sent[0]!.take("stopped", { running: true });
	assert.deepEqual([texts(path), held(path), store.getState().notices.length], [["one", "two"], true, 0]);
	tell(path, false);
	assert.deepEqual(outbox(), ["one"]);
});

test("a hold the user ended after Stop does not come back with the message that was stopped", async () => {
	const path = open(true);
	queue(path, "one");
	void store.sendQueuedNow(path, rows(path)[0]!.id);
	stop(path);
	queue(path, "instead");
	await sent[0]!.take("stopped", { running: false });
	assert.deepEqual([outbox(), texts(path)], [["one", "one"], ["instead"]], "in their order");
});

test("a message typed in the box that was stopped goes back to it and holds the queue", async () => {
	const path = open(true);
	queue(path, "queued");
	const done = store.sendMessage(path, "steered", "steer", [file("notes")]);
	stop(path);
	await sent[0]!.take("stopped", { running: false });
	assert.equal(await done, false);
	assert.deepEqual([held(path), outbox(), dropped], [true, ["steered"], []]);
	assert.deepEqual(take(path, { text: "", attachments: [] }), { text: "steered", attachments: [file("notes")] });
});

test("steering from the box ends a hold, as sending does, unless it fails or the user stops again", async () => {
	for (const ending of ["sent", "failed", "stopped again"] as const) {
		const path = open(true);
		queue(path, "kept");
		stop(path);
		tell(path, false);
		// A background command's result starts a run.
		tell(path, true);
		const from = sent.length;
		const done = store.sendMessage(path, "steered", "steer", []);
		if (ending === "stopped again") stop(path);
		if (ending === "failed") await sent[from]!.refuse("no");
		else await sent[from]!.take("queued", { running: true });
		await done;
		assert.equal(held(path), ending !== "sent", ending);
		tell(path, false);
		assert.deepEqual(outbox().slice(from), ending === "sent" ? ["steered", "kept"] : ["steered"]);
	}
});

test("a message that fails leaves what was written since alone", async () => {
	const path = open();
	const done = store.sendMessage(path, "first", "prompt", [file("a")]);
	await sent[0]!.refuse("offline");
	await done;
	assert.deepEqual(take(path, { text: "written since", attachments: [file("b")] }), { text: "first\n\nwritten since", attachments: [file("a"), file("b")] });
	assert.deepEqual(dropped, []);
});

test("one that fails after the user has gone elsewhere waits for its own session's box", async () => {
	const [path, other] = [open(), open()];
	const sends = [store.sendMessage(path, "first", "prompt", [file("a")]), store.sendMessage(path, "second", "prompt", [])];
	// The box goes off screen with something in it.
	store.keepUnsent(path, { text: "unsent", attachments: [file("b")] });
	await sent[1]!.refuse("offline");
	await sent[0]!.refuse("offline");
	await Promise.all(sends);
	assert.equal(draft(other), undefined);
	assert.deepEqual(take(path, { text: "", attachments: [] }), { text: "first\n\nsecond\n\nunsent", attachments: [file("a"), file("b")] });
});

test("a box that goes off screen just as a message comes back to it keeps both", async () => {
	const path = open();
	const done = store.sendMessage(path, "first", "prompt", []);
	await sent[0]!.refuse("offline");
	await done;
	store.keepUnsent(path, { text: "unsent", attachments: [file("b")] });
	assert.deepEqual(draft(path), { text: "first\n\nunsent", attachments: [file("b")] });
});

test("a message another session's window part could not send shows in its box", () => {
	const path = open();
	emit({ type: "returned", path, draft: { text: "hello", attachments: [] } });
	assert.equal(take(path, { text: "", attachments: [] }).text, "hello");
});

test("a message of a session deleted while it was on its way is dropped with its attachments", async () => {
	const path = open();
	const done = store.sendMessage(path, "first", "prompt", [file("a")]);
	host.deleteSessions = async () => [path];
	await store.deleteSessions([path]);
	await sent[0]!.refuse("This session is not open.");
	await done;
	assert.deepEqual([draft(path), dropped], [undefined, ["a"]]);
});

test("a mention goes after what is in the box, and a draft in place of it", () => {
	const box = { text: "look at ", attachments: [file("a")] };
	assert.deepEqual(store.placeDraft(box, { text: "@x ", attachments: [], place: "after" }), { text: "look at\n@x ", attachments: [file("a")] });
	assert.deepEqual(store.placeDraft({ text: "", attachments: [] }, { text: "@x ", attachments: [], place: "after" }), { text: "@x ", attachments: [] });
	assert.deepEqual(store.placeDraft(box, { text: "forked", attachments: [] }), { text: "forked", attachments: [] });
});

test("a status older than the newest is passed over", () => {
	const path = open(true);
	store.setState({ sessions: [{ path, app: "code", running: true } as ReturnType<typeof store.getState>["sessions"][number]] });
	const stale = status(path, true);
	tell(path, false);
	emit({ type: "status", ...stale });
	assert.equal(store.getState().views[path]!.running, false);
	assert.equal(store.getState().sessions[0]!.running, false, "in the sidebar too");
});

test("a view read before a run ended does not bring the run back once the transition shows it", async () => {
	const path = open(true);
	queue(path, "next");
	slowTransitions = true;
	onOpen = async () => view(path, { running: true });
	await store.openSession(path);
	assert.equal(transitions.length, 1);
	tell(path, false);
	assert.deepEqual(outbox(), ["next"]);
	transitions[0]!();
	assert.equal(store.getState().views[path]!.running, false);
	assert.equal(store.getState().selected.code, path);
});

test("the same for a session opened beside another, and for one that was not loaded yet", async () => {
	const beside = open(true);
	store.setState({ app: "code", page: "main", selected: { code: open() }, split: {} });
	slowTransitions = true;
	store.setState((s) => ({ sessions: [...s.sessions, { path: beside, app: "code" } as (typeof s.sessions)[number]] }));
	await store.openInSplit(beside);
	tell(beside, false);
	transitions.shift()!();
	assert.equal(store.getState().views[beside]!.running, false);
	assert.ok(store.getState().split.code?.includes(beside));

	const fresh = `/sessions/${++sessions}.jsonl`;
	const late = `/sessions/${++sessions}.jsonl`;
	for (const path of [fresh, late]) {
		const snapshot = view(path, { running: true });
		onOpen = async () => {
			// The run ends after the host read the view and before the window has it.
			if (path === late) tell(path, false);
			return snapshot;
		};
		// Its place is on screen and empty, so only the transition puts it there.
		store.setState({ selected: { code: path }, split: {} });
		await store.openSession(path);
		assert.equal(store.getState().views[path], undefined);
		queue(path, "next");
		if (path === fresh) tell(path, false);
		assert.deepEqual(outbox(), [], "nothing goes to a session that is not here");
		transitions.shift()!();
		assert.equal(store.getState().views[path]!.running, false, path);
		assert.deepEqual(outbox(), ["next"]);
		sent = [];
	}
});

test("what a run wrote while its session was being switched to stays", async () => {
	const path = `/sessions/${++sessions}.jsonl`;
	store.setState({ selected: { code: open() }, split: {} });
	slowTransitions = true;
	onOpen = async () => view(path, { running: true, runs: [{ prompt: "hi", steps: [] }] as unknown as SessionView["runs"] });
	await store.openSession(path);
	emit({ type: "run", path, rev: ++rev, index: 0, run: { prompt: "hi", steps: [], reply: { at: 1 } } as unknown as SessionView["runs"][number] });
	transitions[0]!();
	assert.deepEqual(store.getState().views[path]!.runs[0]!.reply, { at: 1 });
});

type Runs = SessionView["runs"];
const run = (prompt: string) => ({ prompt, steps: [] }) as unknown as Runs[number];
const prompts = (path: string) => store.getState().views[path]!.runs.map((item) => item.prompt);

test("a session reloaded in its place shows what it did before the transition", async () => {
	const path = open();
	store.setState({ app: "code", page: "main", selected: { code: path }, split: {} });
	emit({ type: "unloaded", paths: [path] });
	slowTransitions = true;
	await settle();
	assert.deepEqual([transitions.length, store.getState().views[path]], [1, undefined]);
	tell(path, true);
	emit({ type: "run", path, rev: ++rev, index: 0, run: run("half") });
	emit({ type: "run", path, rev: ++rev, index: 0, run: run("whole") });
	const changes = [{ path: "/a.ts" }] as unknown as SessionView["changes"];
	emit({ type: "changes", path, rev: ++rev, changes });
	tell(path, false);
	transitions[0]!();
	assert.deepEqual([store.getState().views[path]!.running, prompts(path), store.getState().views[path]!.changes], [false, ["whole"], changes]);
});

test("what a session did after the host read its view and before the window had it is kept, and no more", async () => {
	const path = `/sessions/${++sessions}.jsonl`;
	onOpen = async () => {
		emit({ type: "run", path, rev: ++rev, index: 0, run: run("old") });
		const snapshot = view(path, { runs: [run("one")] });
		emit({ type: "run", path, rev: ++rev, index: 1, run: run("two") });
		return snapshot;
	};
	await store.openSession(path);
	assert.deepEqual(prompts(path), ["one", "two"]);
	// A view read later holds all of it: an edit went back to before the first run.
	onOpen = async () => view(path);
	await store.openSession(path);
	assert.deepEqual(prompts(path), []);
	emit({ type: "run", path, rev: rev - 1, index: 0, run: run("late") });
	assert.deepEqual(prompts(path), []);
});

test("a status does not make a view read before it any less new", async () => {
	const path = open();
	const snapshot = view(path, { workMode: "orchestrator", runs: [run("one")], running: true, title: "Old" });
	tell(path, false, { title: "New" });
	emit({ type: "view", view: snapshot });
	const shown = store.getState().views[path]!;
	assert.deepEqual([shown.workMode, shown.runs.length, shown.running, shown.title], ["orchestrator", 1, false, "New"]);
	// Nor does the view take the status with it.
	const stale = status(path, true);
	emit({ type: "view", view: view(path) });
	emit({ type: "status", ...stale });
	assert.equal(store.getState().views[path]!.running, false);
});

test("a reply from before a session was unloaded says nothing about it once it is open again", async () => {
	const path = open();
	store.setState({ selected: { code: open() }, split: {} });
	void store.sendMessage(path, "first", "prompt", []);
	const early = status(path, true);
	emit({ type: "unloaded", paths: [path] });
	await store.openSession(path);
	await sent[0]!.take("started", early);
	assert.equal(store.getState().views[path]!.running, false);
});

test("a session that goes again before it could show is opened once more", async () => {
	const path = `/sessions/${++sessions}.jsonl`;
	store.setState({ app: "code", page: "main", selected: { code: open() }, split: {} });
	slowTransitions = true;
	await store.openSession(path);
	emit({ type: "unloaded", paths: [path] });
	onOpen = async () => view(path, { title: "Again" });
	slowTransitions = false;
	transitions[0]!();
	await settle();
	assert.equal(store.getState().views[path]!.title, "Again");
});

test("the other half of a split that finished while it loaded goes on with its queue", async () => {
	const [left, right] = [open(), open(true)];
	store.setState({ app: "code", page: "main", selected: { code: left }, split: { code: [left, right] } });
	queue(right, "next");
	const stale = new Map([left, right].map((path) => [path, view(path, { running: path === right })]));
	onOpen = async (path) => stale.get(path)!;
	emit({ type: "unloaded", paths: [left, right] });
	emit({ type: "status", ...status(right, false) });
	assert.deepEqual(outbox(), []);
	await settle();
	assert.equal(store.getState().views[right]!.running, false);
	assert.deepEqual(outbox(), ["next"]);
});

test("a session opened again goes on with its queue when free, unless it is held", async () => {
	for (const hold of [false, true]) {
		const path = open(true);
		queue(path, "next");
		if (hold) stop(path);
		emit({ type: "unloaded", paths: [path] });
		tell(path, false);
		assert.deepEqual(outbox(), []);
		await store.openSession(path);
		await settle();
		assert.deepEqual(outbox(), hold ? [] : ["next"]);
		assert.equal(held(path), hold);
		sent = [];
	}
});

test("a deleted session takes its hold along", async () => {
	const path = open(true);
	queue(path, "kept");
	stop(path);
	tell(path, false);
	host.deleteSessions = async () => [path];
	await store.deleteSessions([path]);
	assert.equal(path in store.getState().held, false);
	assert.equal(path in store.getState().queued, false);
	// Nor is anything known of its place in the host's count.
	store.setState({ sessions: [{ path, app: "code", running: false } as ReturnType<typeof store.getState>["sessions"][number]] });
	emit({ type: "status", ...status(path, true, { rev: 1 }) });
	assert.equal(store.getState().sessions[0]!.running, true);
});
