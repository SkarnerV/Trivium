import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AgentCountWatch,
	agentsOf,
	BackgroundRuns,
	CHANGES_WINDOW_MS,
	DETACHED_GRACE_MS,
	GONE_RECHECK_MS,
	hasLiveAgents,
	LAUNCH_GRACE_MS,
	markBackground,
	RESULT_GRACE_MS,
	readRunStatus,
	STALE_STATUS_MS,
	stateFromStatus,
} from "../src/main/background-runs.ts";
import { ChangeTracker } from "../src/main/changes.ts";
import { delegationHooks, noticeRunIds, noticeStatuses } from "../src/main/delegation-hooks.ts";
import { subagentOf } from "../src/main/subagents.ts";
import { agentCounts, agentSteps, supervisorQuestions } from "../src/shared/agent-counts.ts";
import type { AppId, Run } from "../src/shared/protocol.ts";

const NOW = 1_800_000_000_000;
const evidence = (extra: Partial<Parameters<typeof stateFromStatus>[1]> = {}) => ({ now: NOW, bootedAt: NOW - 3_600_000, alive: () => true, ...extra });

test("a background run counts as running only while its status shows it alive", () => {
	const running = { state: "running", pid: 42, lastUpdate: NOW - 1000 };
	assert.equal(stateFromStatus(running, evidence()), "running");
	assert.equal(stateFromStatus({ ...running, state: "queued" }, evidence()), "running");
	assert.equal(stateFromStatus(running, evidence({ alive: () => false })), "gone", "its runner exited without writing an end");
	assert.equal(stateFromStatus({ ...running, lastUpdate: NOW - STALE_STATUS_MS - 1 }, evidence()), "gone", "a stale status cannot vouch for its pid");
	assert.equal(stateFromStatus({ ...running, lastUpdate: NOW - 7_200_000 }, evidence()), "gone", "written before this boot");
	assert.equal(stateFromStatus({ state: "running" }, evidence()), "gone", "no time to judge it by");
	assert.equal(stateFromStatus({ state: "complete" }, evidence()), "done");
	assert.equal(stateFromStatus({ state: "failed" }, evidence()), "error");
	assert.equal(stateFromStatus({ state: "partial" }, evidence()), "error");
	assert.equal(stateFromStatus({ state: "stopped" }, evidence()), "stopped");
	assert.equal(stateFromStatus({ state: "something new" }, evidence()), "gone");
	// Paused: alive while its process is and it has not ended, or while a child of it waits for an answer.
	const paused = { ...running, state: "paused" };
	assert.equal(stateFromStatus(paused, evidence()), "running", "its runner is still winding down");
	assert.equal(stateFromStatus(paused, evidence({ alive: () => false })), "stopped");
	assert.equal(stateFromStatus({ ...paused, endedAt: NOW - 500 }, evidence()), "stopped", "an interrupted run ends paused");
	assert.equal(stateFromStatus({ ...paused, endedAt: NOW - 500, steps: [{ status: "paused", activityState: "needs_attention" }] }, evidence()), "running", "its child waits for an answer");
	assert.equal(stateFromStatus({ ...paused, steps: [{ status: "paused", activityState: "needs_attention" }] }, evidence({ alive: () => false })), "stopped");
	assert.equal(stateFromStatus({ ...paused, lastUpdate: NOW - STALE_STATUS_MS - 1 }, evidence()), "stopped");
	assert.equal(stateFromStatus({ state: "paused" }, evidence()), "stopped", "no evidence of life");
	for (const bad of [null, undefined, "running", [], 3]) assert.equal(stateFromStatus(bad, evidence()), "gone");
	// Its status may not be written yet just after this process launched it, and only then.
	assert.equal(stateFromStatus(null, evidence({ launchedAt: NOW - 1000 })), "running");
	assert.equal(stateFromStatus(null, evidence({ launchedAt: NOW - LAUNCH_GRACE_MS })), "gone");
});

test("a run's status is read only from a folder named for it in the extension's async-run folder", async () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-async-root-")));
	try {
		const runs = join(root, "async-subagent-runs");
		mkdirSync(join(runs, "run-1"), { recursive: true });
		writeFileSync(join(runs, "run-1", "status.json"), JSON.stringify({ state: "running", pid: 1 }));
		mkdirSync(join(root, "elsewhere", "run-1"), { recursive: true });
		writeFileSync(join(root, "elsewhere", "run-1", "status.json"), "{}");
		const roots = { trees: [runs], temp: [] };
		assert.deepEqual(await readRunStatus(join(runs, "run-1"), "run-1", roots), { state: "running", pid: 1 });
		assert.equal(await readRunStatus(join(runs, "run-1"), "run-2", roots), null, "the folder must be the launch's own");
		assert.equal(await readRunStatus(join(root, "elsewhere", "run-1"), "run-1", roots), null);
		assert.equal(await readRunStatus("\\\\server\\share\\async-subagent-runs\\run-1", "run-1", roots), null);
		writeFileSync(join(runs, "run-1", "status.json"), "not json");
		assert.equal(await readRunStatus(join(runs, "run-1"), "run-1", roots), null);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

const launch = (asyncId: string, asyncDir = `/tmp/pi-subagents-x/async-subagent-runs/${asyncId}`) =>
	({ id: `step-${asyncId}`, tool: "subagent", status: "done", subagent: { background: true, asyncId, asyncDir, children: [{ agent: "scout", task: "Map it", status: "running", steps: [], tools: 0 }] } }) as const;

test("a launch whose run shows no evidence of life stops counting, and the session may be unloaded", async () => {
	let status: unknown = { state: "running", pid: 7, lastUpdate: NOW };
	let alive = true;
	const runs = new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => status, now: () => NOW, alive: () => alive, bootedAt: 0, poll: false });
	const history = [{ steps: [launch("run-1")] }] as unknown as Run[];
	await runs.restore(history);
	assert.equal(agentsOf(history, runs).running, 1, "a live runner keeps its child counted after a restart");
	assert.equal(runs.windowsOpen(), 0, "a session reopened from its file opens no Changes window");
	alive = false;
	assert.equal(await runs.refresh(), true);
	assert.equal(agentsOf(history, runs).running, 0);
	const child = agentSteps(markBackground(history, runs))[0]!.subagent!.children[0]!;
	assert.equal(child.status, "stopped");
	assert.equal(child.unreported, true);
	// Unknown to this process (no record, no folder): no evidence, not running.
	const other = [{ steps: [launch("run-9")] }] as unknown as Run[];
	assert.equal(agentsOf(other, new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => null, poll: false })).running, 0);
	status = null;
});

test("a notice pairs with its launch by run id, as pi-subagents sends it in details.runs[]", async () => {
	assert.deepEqual(noticeRunIds({ runs: [{ runId: "run-1", agent: "scout", status: "completed", asyncDir: "/x" }, { runId: "run-2" }] }), ["run-1", "run-2"]);
	assert.deepEqual(noticeRunIds({ runs: [null, { runId: 3 }, "x"] }), []);
	assert.deepEqual(noticeRunIds(undefined), []);
	const runs = new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => ({ state: "running", pid: 1, lastUpdate: NOW }), now: () => NOW, bootedAt: 0, poll: false });
	runs.launched("run-1", "/x");
	await runs.finished(noticeRunIds({ runs: [{ runId: "run-1" }] }));
	assert.equal(runs.state("run-1"), "done");
	assert.equal(runs.windowsOpen(), 0);
});

/** A project, a Changes tracker for its session, and the host's hooks around the main agent's tool calls. */
function session(app: AppId = "code") {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-delegation-")));
	const project = join(root, "project");
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "src", "app.ts"), "one\n");
	const tracker = new ChangeTracker(join(root, "session.json"), project);
	let clock = NOW;
	let status: unknown = { state: "running", pid: 1, lastUpdate: NOW };
	const background = new BackgroundRuns({
		closeWindow: () => tracker.afterSubagents(),
		openWindow: () => tracker.beforeSubagents(),
		onChange: () => {},
		read: async () => status,
		now: () => clock,
		alive: () => true,
		bootedAt: 0,
		poll: false,
	});
	const handlers: Record<string, (event: any) => Promise<unknown>> = {};
	const pi = { on: (name: string, handler: (event: any) => Promise<unknown>) => (handlers[name] = handler) } as unknown as ExtensionAPI;
	delegationHooks({
		app,
		changes: tracker,
		handoffs: { capture: async () => {} },
		background,
		changing: (event) => event.toolName === "bash",
		afterSubagents: () => tracker.afterSubagents(),
		onChanges: async () => {},
		onNotice: async () => {},
	})(pi);
	let calls = 0;
	const call = async (toolName: string, input: Record<string, unknown>, details?: unknown, work?: () => void) => {
		const toolCallId = `call-${++calls}`;
		await handlers.tool_call!({ toolName, toolCallId, input });
		work?.();
		await handlers.tool_result!({ toolName, toolCallId, input, details });
	};
	const notice = (details: unknown) => handlers.message_end!({ message: { role: "custom", customType: "subagent-notify", details } });
	const write = (rel: string, text: string) => writeFileSync(join(project, rel), text);
	const listed = async () => (await tracker.list()).map((change) => change.rel.replaceAll("\\", "/")).sort();
	return {
		tracker,
		background,
		call,
		notice,
		message: (message: unknown) => handlers.message_end!({ message }),
		write,
		listed,
		setStatus: (value: unknown) => (status = value),
		advance: (ms: number) => (clock += ms),
		cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
	};
}

const scout = { agent: "worker", task: "Change the app" };

test("a foreground launch is detected by the host's hooks and its children's edits are adopted when it ends", async () => {
	const s = session();
	try {
		await s.call("subagent", scout, { results: [] }, () => s.write("src/app.ts", "child\n"));
		assert.deepEqual(await s.listed(), ["src/app.ts"]);
		// They may be the user's, made while the child worked: reverting all leaves them, and the file can be named.
		await s.tracker.revert();
		assert.deepEqual(await s.listed(), ["src/app.ts"]);
		await s.tracker.revert((await s.tracker.list()).map((change) => change.path));
		assert.equal((await s.listed()).length, 0);
	} finally {
		s.cleanup();
	}
});

test("a background launch's edits are adopted when its notice arrives, and later user edits are not", async () => {
	const s = session();
	try {
		await s.call("subagent", { ...scout, async: true }, { asyncId: "run-1", asyncDir: "/x" });
		assert.equal(s.background.windowsOpen(), 1);
		s.write("src/app.ts", "child\n");
		await s.notice({ runs: [{ runId: "run-1", status: "completed" }] });
		assert.equal(s.background.windowsOpen(), 0);
		assert.deepEqual(await s.listed(), ["src/app.ts"]);
		s.write("src/user.ts", "the user's own file\n");
		await s.call("bash", { command: "npm run format" }, {}, () => {});
		assert.deepEqual(await s.listed(), ["src/app.ts"], "the user's file is not the session's");
	} finally {
		s.cleanup();
	}
});

test("a background launch that never reports back closes its Changes window when its run ends", async () => {
	const s = session();
	try {
		await s.call("subagent", { ...scout, async: true }, { asyncId: "run-1", asyncDir: "/x" });
		s.write("src/app.ts", "child\n");
		await s.background.refresh();
		assert.equal(s.background.windowsOpen(), 1, "still running: the window stays open");
		s.setStatus({ state: "complete" });
		await s.background.refresh();
		assert.equal(s.background.windowsOpen(), 0);
		assert.deepEqual(await s.listed(), ["src/app.ts"]);
		// After the window closed, a user edit followed by any command is left to the user, and Revert keeps it.
		s.write("src/user.ts", "mine\n");
		await s.call("bash", { command: "npm test -- --update" }, {}, () => {});
		assert.deepEqual(await s.listed(), ["src/app.ts"]);
		await s.tracker.revert((await s.tracker.list()).map((change) => change.path));
		assert.equal((await s.listed()).length, 0);
	} finally {
		s.cleanup();
	}
});

test("a background run that keeps running still closes its Changes window in bounded time", async () => {
	const s = session();
	try {
		await s.call("subagent", { ...scout, async: true }, { asyncId: "run-1", asyncDir: "/x" });
		s.advance(CHANGES_WINDOW_MS - 1);
		await s.background.refresh();
		assert.equal(s.background.windowsOpen(), 1);
		s.advance(1);
		s.setStatus({ state: "running", pid: 1, lastUpdate: NOW + CHANGES_WINDOW_MS });
		await s.background.refresh();
		assert.equal(s.background.windowsOpen(), 0);
		assert.equal(s.background.state("run-1"), "running", "the child itself still counts as running");
		s.write("src/user.ts", "mine\n");
		await s.call("bash", { command: "make" }, {}, () => {});
		assert.deepEqual(await s.listed(), []);
	} finally {
		s.cleanup();
	}
});

test("Research and Write do not treat a subagent call as a launch to snapshot around", async () => {
	for (const app of ["research", "write"] as const) {
		const s = session(app);
		try {
			await s.call("subagent", { ...scout, async: true }, { asyncId: "run-1", asyncDir: "/x" });
			assert.equal(s.background.windowsOpen(), 0, app);
		} finally {
			s.cleanup();
		}
	}
});

test("the session list refreshes when a session's agent counts change, not on every update", () => {
	const watch = new AgentCountWatch();
	assert.equal(watch.changed({ running: 0, waiting: 0 }), false);
	assert.equal(watch.changed({ running: 2, waiting: 0 }), true, "children started");
	assert.equal(watch.changed({ running: 2, waiting: 0 }), false, "progress alone");
	assert.equal(watch.changed({ running: 2, waiting: 1 }), true, "one began waiting");
	assert.equal(watch.changed({ running: 0, waiting: 0 }), true, "they finished");
});

test("a status that is late past the grace period brings a run back, and one that never comes stays gone", async () => {
	let status: unknown = null;
	let clock = NOW;
	let closed = 0;
	let opened = 0;
	const runs = new BackgroundRuns({
		closeWindow: async () => closed++,
		openWindow: async () => opened++,
		onChange: () => {},
		read: async () => status,
		now: () => clock,
		alive: (pid) => pid === 7,
		bootedAt: 0,
		poll: false,
	});
	runs.launched("late", "/x/late");
	clock += LAUNCH_GRACE_MS + 1;
	await runs.refresh();
	assert.equal(runs.state("late"), "gone");
	assert.equal(closed, 1);
	status = { state: "running", pid: 7, lastUpdate: clock };
	assert.equal(await runs.refresh(), true);
	assert.equal(runs.state("late"), "running", "gone is not for good while a live status can still appear");
	assert.equal(runs.windowsOpen(), 1, "what it edits from here on is its own again");
	assert.equal(opened, 1);
	// A status caught between two writes is no different.
	status = null;
	await runs.refresh();
	assert.equal(runs.state("late"), "gone");
	status = { state: "complete" };
	await runs.refresh();
	assert.equal(runs.state("late"), "done");
	assert.equal(runs.windowsOpen(), 0);
	// Truly dead: no status, or one whose process is gone.
	for (const dead of [null, { state: "running", pid: 8, lastUpdate: clock }]) {
		status = dead;
		runs.launched("dead", "/x/dead");
		clock += LAUNCH_GRACE_MS + 1;
		await runs.refresh();
		await runs.refresh();
		assert.equal(runs.state("dead"), "gone");
		clock += GONE_RECHECK_MS;
		status = { state: "running", pid: 7, lastUpdate: clock };
		assert.equal(await runs.refresh(), false);
		assert.equal(runs.state("dead"), "gone", "settled: it is not looked at for ever");
	}
	assert.equal(runs.liveRuns(), 0);
});

/** The result of a single foreground child that asked its supervisor something, as pi-subagents 0.82.1 returns it. */
const detachedDetails = (runId: string) => ({
	mode: "single",
	runId,
	timeoutMs: 1_800_000,
	results: [{ index: 0, agent: "worker", task: "Do it", exitCode: -2, detached: true, detachedReason: "intercom coordination", finalOutput: "Detached for intercom coordination before task completion.", progressSummary: { toolCount: 1, tokens: 20, durationMs: 248 } }],
});
const detachedHistory = (runId: string) => [{ steps: [{ id: "s", tool: "subagent", status: "done", subagent: subagentOf({ agent: "worker", task: "Do it" }, detachedDetails(runId), "done") }] }] as unknown as Run[];

test("a child detached by its question stays alive across idle and reload, until its completion notice", async () => {
	const s = session();
	try {
		await s.call("subagent", { ...scout, async: false }, detachedDetails("run-1"));
		assert.equal(s.background.windowsOpen(), 1, "its edits are still to come");
		const history = detachedHistory("run-1");
		const child = agentSteps(markBackground(history, s.background))[0]!.subagent!.children[0]!;
		assert.equal(child.status, "running", "not failed, though its exit code is -2");
		assert.deepEqual(agentsOf(detachedHistory("run-1"), s.background), { running: 1, waiting: 0 });
		assert.equal(hasLiveAgents(detachedHistory("run-1"), s.background), true, "unloading the session, idle or to reload it, would kill it");
		s.advance(20 * 60_000);
		await s.background.refresh();
		assert.equal(hasLiveAgents(detachedHistory("run-1"), s.background), true);
		// Counted by its run, even where no row shows it.
		assert.equal(hasLiveAgents([], s.background), true);
		s.write("src/app.ts", "child\n");
		// The notice of a detached child that ended says "paused" when its work was not accepted.
		await s.notice({ runs: [{ runId: "run-1", agent: "worker", status: "paused", source: "foreground" }] });
		assert.equal(s.background.windowsOpen(), 0);
		assert.deepEqual(await s.listed(), ["src/app.ts"]);
		assert.equal(hasLiveAgents(detachedHistory("run-1"), s.background), false);
		const ended = [...detachedHistory("run-1"), { steps: [], notice: { runIds: ["run-1"], status: "completed", text: "Did it" } }] as unknown as Run[];
		assert.equal(agentSteps(markBackground(ended, s.background))[0]!.subagent!.children[0]!.output, "Did it");
		assert.equal(agentSteps(ended)[0]!.subagent!.children[0]!.status, "done");
	} finally {
		s.cleanup();
	}
});

test("a session stays loaded until the result of a run that just ended has arrived, or will not", async () => {
	let clock = NOW;
	let status: unknown = { state: "running", pid: 1, lastUpdate: NOW };
	const make = () => new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => status, now: () => clock, alive: () => true, bootedAt: 0, poll: false });
	const runs = make();
	runs.launched("told", "/x/told");
	runs.launched("untold", "/x/untold");
	status = { state: "complete" };
	await runs.refresh();
	assert.deepEqual([runs.state("told"), runs.state("untold")], ["done", "done"]);
	assert.equal(hasLiveAgents([], runs), true, "both results are still on their way");
	await runs.finished(["told"]);
	assert.equal(runs.liveRuns(), 1);
	clock += RESULT_GRACE_MS;
	assert.equal(hasLiveAgents([], runs), false, "the other's never came");
	// One that ended before this session was opened has nothing to deliver here.
	const reopened = make();
	await reopened.restore([{ steps: [launch("run-1")] }] as unknown as Run[]);
	assert.equal(hasLiveAgents([], reopened), false);
});

test("a detached child that never reports back ends with its time limit, and none outlives its process", async () => {
	let clock = NOW;
	const runs = new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => null, now: () => clock, bootedAt: 0, poll: false });
	runs.detached("run-1", 60_000);
	clock += 60_000 + DETACHED_GRACE_MS - 1;
	await runs.refresh();
	assert.equal(runs.state("run-1"), "running");
	clock += 1;
	await runs.refresh();
	assert.equal(runs.state("run-1"), "gone");
	assert.equal(runs.windowsOpen(), 0);
	const reopened = new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => null, poll: false });
	await reopened.restore(detachedHistory("run-1"));
	const history = detachedHistory("run-1");
	assert.equal(hasLiveAgents(history, reopened), false);
	const child = agentSteps(markBackground(history, reopened))[0]!.subagent!.children[0]!;
	assert.equal(child.status, "stopped");
	assert.equal(child.unreported, true);
});

test("a background workflow counts as live before it lists a child, and a paused one while its child waits", async () => {
	let status: unknown = { state: "running", pid: 1, lastUpdate: NOW };
	let alive = true;
	const runs = new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => status, now: () => NOW, alive: () => alive, bootedAt: 0, poll: false });
	runs.launched("flow", "/x/flow");
	const launchOf = (children: unknown[]) => [{ steps: [{ id: "f", tool: "subagent", status: "done", subagent: { background: true, asyncId: "flow", asyncDir: "/x/flow", children } }] }] as unknown as Run[];
	assert.equal(agentsOf(launchOf([]), runs).running, 0, "no rows yet");
	assert.equal(hasLiveAgents(launchOf([]), runs), true, "but a run");
	status = { state: "paused", pid: 1, lastUpdate: NOW, endedAt: NOW, steps: [{ status: "paused", activityState: "needs_attention" }] };
	await runs.finished(["flow"], noticeStatuses({ runs: [{ runId: "flow", status: "paused" }] }));
	assert.equal(runs.state("flow"), "running", "the pause is not its end");
	const child = { agent: "worker", task: "x", status: "running", steps: [], tools: 0, label: "api" };
	const paused = [...launchOf([child]), { steps: [], notice: { runIds: ["flow"], status: "paused", text: "Paused" } }] as unknown as Run[];
	assert.equal(agentSteps(markBackground(paused, runs))[0]!.subagent!.children[0]!.status, "running");
	// Read back after a restart, the status still decides.
	const reopened = new BackgroundRuns({ closeWindow: async () => {}, onChange: () => {}, read: async () => status, now: () => NOW, alive: () => alive, bootedAt: 0, poll: false });
	await reopened.restore(paused);
	assert.equal(hasLiveAgents(paused, reopened), true);
	alive = false;
	await runs.refresh();
	assert.equal(runs.state("flow"), "stopped");
	assert.equal(agentSteps(markBackground(paused, runs))[0]!.subagent!.children[0]!.status, "stopped");
});

test("a child's question shows as waiting until the main agent's reply, a refused reply or the end of its run", async () => {
	const s = session();
	try {
		await s.call("subagent", { ...scout, async: false }, detachedDetails("run-1"));
		const asked = (id: string) => ({ steps: [], notice: { agent: "worker", status: "waiting", text: "May I push?", request: { id, runId: "run-1", childIndex: 0 } } });
		const replied = (id: string, status = "done") => ({ steps: [{ id: `r-${id}`, tool: "subagent_supervisor", status, reply: { request: id, message: "No, leave it." } }] });
		const counts = (...more: unknown[]) => agentCounts(markBackground([...detachedHistory("run-1"), ...more] as Run[], s.background));
		assert.deepEqual(counts(asked("q1")), { running: 1, waiting: 1 });
		const row = agentSteps(markBackground([...detachedHistory("run-1"), asked("q1")] as unknown as Run[], s.background))[0]!.subagent!.children[0]!;
		assert.equal(row.waitingOn, "main");
		assert.equal(row.current?.target, "May I push?");
		assert.deepEqual(counts(asked("q1"), replied("q1", "running")), { running: 1, waiting: 1 }, "a reply still on its way answers nothing");
		assert.deepEqual(counts(asked("q1"), replied("q1")), { running: 1, waiting: 0 });
		assert.deepEqual(counts(asked("q1"), replied("other")), { running: 1, waiting: 1 });
		assert.deepEqual(counts(asked("q1"), replied("q1"), asked("q2")), { running: 1, waiting: 1 }, "it asks again");
		assert.deepEqual(counts(asked("q1"), replied("q1", "error")), { running: 1, waiting: 0 }, "refused: the question had expired");
		const questions = supervisorQuestions([asked("q1"), replied("q1"), asked("q2")] as unknown as Run[]);
		assert.deepEqual([questions.get("q1")?.reply, questions.get("q1")?.waiting, questions.get("q2")?.waiting], ["No, leave it.", false, true]);
		assert.equal(supervisorQuestions([asked("q1"), { steps: [], notice: { runIds: ["run-1"], status: "completed" } }] as unknown as Run[]).get("q1")?.waiting, false);
	} finally {
		s.cleanup();
	}
});
