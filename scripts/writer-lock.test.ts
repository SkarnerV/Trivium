import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackgroundRuns, LAUNCH_GRACE_MS } from "../src/main/background-runs.ts";
import { delegationHooks } from "../src/main/delegation-hooks.ts";
import { onlyReads } from "../src/main/permission-gate.ts";
import { subagentOf } from "../src/main/subagents.ts";
import { startsChild, writerLock, writerOf } from "../src/main/writer-lock.ts";
import type { PermissionModeId } from "../src/shared/permissions.ts";
import type { Run } from "../src/shared/protocol.ts";

const cwd = mkdtempSync(join(tmpdir(), "trivium-lock-"));
test.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const worker = { agent: "worker", task: "Do it", options: { context: "fork" } };
const scout = { agent: "scout", task: "Look" };

/** The lock and the host's hooks around one session's tool calls, in the order the host registers them. */
function session() {
	let orchestrator = true;
	let permission: PermissionModeId = "auto";
	let clock = 1_800_000_000_000;
	let status: unknown = { state: "running", pid: 1, lastUpdate: clock };
	let alive = true;
	const make = () =>
		new BackgroundRuns({
			closeWindow: async () => {},
			onChange: () => {},
			read: async () => status,
			now: () => clock,
			alive: () => alive,
			bootedAt: 0,
			poll: false,
			writerOf: (input) => writerOf("subagent", input, cwd),
		});
	const background = make();
	const changing = (event: { toolName: string; input: unknown }) => event.toolName === "bash" && !onlyReads((event.input as { command: string }).command);
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const pi = { on: (name: string, handler: (event: any, ctx: any) => any) => (handlers[name] ??= []).push(handler) } as never;
	writerLock({ orchestrator: () => orchestrator, permission: () => permission, background, changing })(pi);
	delegationHooks({
		app: "code",
		changes: { beforeCommand: async () => {}, afterCommand: async () => false, beforeSubagents: async () => {} },
		handoffs: { capture: async () => {} },
		background,
		changing,
		afterSubagents: async () => {},
		onChanges: async () => {},
		onNotice: async () => {},
	})(pi);
	let calls = 0;
	const emit = async (name: string, event: object) => {
		for (const handler of handlers[name] ?? []) {
			const answer = await handler(event, { cwd });
			if (answer?.block) return answer as { block: true; reason: string };
		}
		return undefined;
	};
	/** Starts a call; the answer is why it was refused. `end` finishes it. */
	const begin = async (toolName: string, input: Record<string, unknown>) => {
		const toolCallId = `call-${++calls}`;
		const refused = await emit("tool_call", { toolName, toolCallId, input });
		const end = async (details?: unknown) => {
			if (!refused) await emit("tool_result", { toolName, toolCallId, input, details, content: [] });
			await emit("tool_execution_end", { toolName, toolCallId });
		};
		if (refused) await end();
		return { refused: refused?.reason, end };
	};
	const call = async (toolName: string, input: Record<string, unknown>, details?: unknown) => {
		const { refused, end } = await begin(toolName, input);
		if (!refused) await end(details);
		return refused;
	};
	const launch = (input: Record<string, unknown>, id: string) => call("subagent", { ...input, async: true }, { asyncId: id, asyncDir: `/x/${id}` });
	return {
		begin,
		call,
		launch,
		emit,
		background,
		make,
		notice: (id: string, state = "completed") => emit("message_end", { message: { role: "custom", customType: "subagent-notify", details: { runs: [{ runId: id, status: state }] } } }),
		set: (next: { orchestrator?: boolean; permission?: PermissionModeId; status?: unknown; alive?: boolean; advance?: number }) => {
			if (next.orchestrator !== undefined) orchestrator = next.orchestrator;
			if (next.permission) permission = next.permission;
			if ("status" in next) status = next.status;
			if (next.alive !== undefined) alive = next.alive;
			clock += next.advance ?? 0;
		},
	};
}

/** What the main agent may and may not do while a writer lives. */
async function assertHeld(s: ReturnType<typeof session>, message?: string) {
	for (const [tool, input] of [["edit", { path: "a.ts" }], ["write", { path: "a.ts" }], ["bash", { command: "npm test" }], ["bash", { command: "git apply x.patch" }]] as const) {
		assert.match((await s.call(tool, input)) ?? "", /only one writer works at a time/, `${message ?? ""} ${tool} ${JSON.stringify(input)}`);
	}
	assert.match((await s.launch(worker, "other")) ?? "", /already making changes/, message);
	for (const [tool, input] of [["read", { path: "a.ts" }], ["grep", { pattern: "x" }], ["bash", { command: "git status" }], ["subagent_supervisor", { action: "reply", message: "Yes" }], ["subagent", { action: "status" }], ["subagent", { action: "stop", id: "run-1" }]] as const) {
		assert.equal(await s.call(tool, input), undefined, `${message ?? ""} ${tool} ${JSON.stringify(input)}`);
	}
	assert.equal(await s.call("subagent", scout, { results: [] }), undefined, "scouts may run meanwhile");
}

async function assertFree(s: ReturnType<typeof session>, message?: string) {
	assert.equal(await s.call("edit", { path: "a.ts" }), undefined, message);
	assert.equal(await s.call("bash", { command: "npm test" }), undefined, message);
}

test("the agents that only read are the package's own; anything else may write", () => {
	for (const agent of ["scout", "reviewer", "researcher", "oracle", "advisor", "evidence-auditor"]) assert.equal(writerOf("subagent", { agent, task: "x" }, cwd), undefined, agent);
	for (const agent of ["worker", "delegate", "developer", "claude-code", "codex-exec-writer", "my-own-agent", ""]) assert.ok(writerOf("subagent", { agent, task: "x" }, cwd), agent);
	for (const input of [{ workflow: true }, { workflow: "./w.js" }, { workflow: "release" }, { options: { workflow: "./w.js" } }, { tasks: [{ agent: "scout", task: "x" }] }, { action: "resume", id: "r" }, { action: "schedule.create", workflow: "w" }, { action: " schedule.run " }]) {
		assert.ok(writerOf("subagent", input, cwd), JSON.stringify(input));
	}
	for (const input of [{ action: "status" }, { action: "stop", id: "r" }, { action: "list" }, { action: "steer", id: "r", message: "x" }, {}]) assert.equal(writerOf("subagent", input, cwd), undefined, JSON.stringify(input));
	assert.equal(startsChild("bash", { agent: "worker" }), false);
	// A project may define its own agent by a reader's name.
	mkdirSync(join(cwd, "custom", ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, "custom", ".pi", "agents", "mine.md"), "---\nname: scout\ntools: read, edit, bash\n---\nEdit.\n");
	assert.equal(writerOf("subagent", scout, join(cwd, "custom")), "scout");
});

test("a background writer holds the lock until its completion notice", async () => {
	const s = session();
	assert.equal(await s.launch(worker, "run-1"), undefined);
	await assertHeld(s);
	await s.notice("run-1");
	await assertFree(s);
	assert.equal(await s.launch(worker, "run-2"), undefined, "and the next writer may start");
});

test("a writer that fails, is stopped or crashes releases it, at the next call that asks", async () => {
	for (const [name, change] of [
		["failed", { status: { state: "failed" } }],
		["stopped", { status: { state: "stopped" } }],
		["crashed", { alive: false }],
		["gone", { status: null, advance: LAUNCH_GRACE_MS + 1 }],
	] as const) {
		const s = session();
		await s.launch(worker, "run-1");
		await assertHeld(s, name);
		s.set(change);
		await assertFree(s, name);
	}
});

test("a foreground writer holds it while its call runs, and one left running by its question after", async () => {
	const s = session();
	const { refused, end } = await s.begin("subagent", { ...worker, async: false });
	assert.equal(refused, undefined);
	await assertHeld(s, "running");
	await end({ mode: "single", runId: "run-1", timeoutMs: 60_000, results: [{ index: 0, agent: "worker", exitCode: -2, detached: true }] });
	await assertHeld(s, "detached");
	await s.notice("run-1", "paused");
	await assertFree(s);
	// A call that fails, or that the user's permission answer refuses, leaves nothing behind.
	const failed = await s.begin("subagent", { ...worker, async: false });
	await failed.end();
	await assertFree(s, "failed");
	await s.begin("subagent", { ...worker, async: false });
	await s.emit("agent_end", {});
	await assertFree(s, "the run that made the call ended");
});

test("a second writer in the same reply, or one beside the main agent's own edit, does not start", async () => {
	const s = session();
	const first = await s.begin("subagent", { ...worker, async: true });
	const second = await s.begin("subagent", { ...worker, async: true });
	assert.equal(first.refused, undefined);
	assert.match(second.refused ?? "", /already making changes/);
	assert.match((await s.begin("edit", { path: "a.ts" })).refused ?? "", /only one writer/);
	await first.end({ asyncId: "run-1", asyncDir: "/x/run-1" });
	await s.notice("run-1");
	const command = await s.begin("bash", { command: "npm test" });
	assert.match((await s.begin("subagent", worker)).refused ?? "", /in a reply of its own/);
	assert.equal((await s.begin("subagent", scout)).refused, undefined);
	await command.end();
	assert.equal((await s.begin("subagent", worker)).refused, undefined);
});

test("Always ask refuses a writer at once, since no one could approve what it does; scouts and the main agent go on", async () => {
	const s = session();
	s.set({ permission: "ask" });
	assert.match((await s.launch(worker, "run-1")) ?? "", /Always ask, and no one can answer for a subagent/);
	assert.match((await s.call("subagent", { workflow: "./w.js" })) ?? "", /Always ask/);
	assert.equal(await s.call("subagent", scout, { results: [] }), undefined);
	await assertFree(s);
	assert.equal(s.background.liveWriter(), undefined);
});

test("any other work mode has no lock, whatever is running", async () => {
	const s = session();
	s.set({ orchestrator: false, permission: "ask" });
	assert.equal(await s.launch(worker, "run-1"), undefined);
	assert.equal(await s.launch(worker, "run-2"), undefined);
	await assertFree(s);
	// Read on every call: switching to Orchestrator takes the runs there are into account.
	s.set({ orchestrator: true, permission: "auto" });
	await assertHeld(s);
});

test("a resumed run is a writer, and is followed as one", async () => {
	const s = session();
	assert.equal(await s.call("subagent", { action: "resume", id: "run-1", message: "Go on" }, { asyncId: "run-1b", asyncDir: "/x/run-1b" }), undefined);
	await assertHeld(s);
	await s.notice("run-1b");
	await assertFree(s);
});

test("a session opened again holds the lock only for a writer that still lives", async () => {
	const s = session();
	const step = (input: Record<string, unknown>, id: string) => ({
		id,
		tool: "subagent",
		status: "done",
		input: JSON.stringify(input),
		subagent: subagentOf(input, { mode: "single", asyncId: id, asyncDir: `/x/${id}`, results: [] }, "done"),
	});
	const history = (...steps: unknown[]) => [{ steps }] as unknown as Run[];
	const live = s.make();
	await live.restore(history(step(scout, "run-s"), step(worker, "run-w")));
	assert.equal(live.liveWriter(), "worker (run run-w)");
	s.set({ alive: false });
	await live.refresh();
	assert.equal(live.liveWriter(), undefined, "its process ended with the app that started it");
	s.set({ alive: true });
	const readers = s.make();
	await readers.restore(history(step(scout, "run-s")));
	assert.equal(readers.liveWriter(), undefined);
	// Left running by its question, it lived in the process that is gone.
	const detached = s.make();
	await detached.restore(history({ id: "d", tool: "subagent", status: "done", input: JSON.stringify(worker), subagent: subagentOf(worker, { runId: "run-d", results: [{ index: 0, agent: "worker", exitCode: -2, detached: true }] }, "done") }));
	assert.equal(detached.liveWriter(), undefined);
	const answered = s.make();
	await answered.restore([...history(step(worker, "run-w")), { steps: [], notice: { runIds: ["run-w"], status: "completed" } }] as unknown as Run[]);
	assert.equal(answered.liveWriter(), undefined);
});
