import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { childSessionFile, describeSubagent, noticeOf, subagentOf } from "../src/main/subagents.ts";
import { RunTracker } from "../src/main/transcript.ts";

type Messages = ConstructorParameters<typeof RunTracker>[0];
type Event = Parameters<RunTracker["apply"]>[0];

const scoutArgs = { agent: "scout", task: "Map the auth flow\nList risks" };

test("completed workflow children retain their session file and trace duration", () => {
	const details = {
		results: [
			{ index: 0, workflowKey: "slug", agent: "worker", exitCode: 0, sessionFile: "/sessions/slug.jsonl" },
			{ index: 0, workflowKey: "csv", agent: "worker", exitCode: 0, sessionFile: "/sessions/csv.jsonl" },
		],
		workflowChildren: { children: [{ childId: "slug", state: "completed" }, { childId: "csv", state: "completed" }] },
		workflow: { trace: [
			{ operation: "run", key: "csv", state: "completed", durationMs: 118766 },
			{ operation: "run", key: "slug", state: "completed", durationMs: 97355 },
		] },
	};
	const children = subagentOf({ workflow: true }, details, "done").children;
	assert.deepEqual(children.map((child) => [child.label, child.sessionFile, child.durationMs]), [
		["slug", "/sessions/slug.jsonl", 97355], ["csv", "/sessions/csv.jsonl", 118766],
	]);
});

test("workflow preflight precedes live children and preserves lane order", () => {
	const plan = { version: 1, coverage: "complete", lanes: [{ key: "api", mode: "mutation", claims: ["src/api.ts"] }, { key: "review", mode: "review" }] };
	const pending = subagentOf({ workflow: true, options: { preflight: plan } }, undefined, "running");
	assert.deepEqual(pending.children.map((child) => [child.label, child.status]), [["api", "pending"], ["review", "pending"]]);
	const live = subagentOf({ workflow: true }, {
		preflight: plan,
		workflowChildren: { children: [{ childId: "review", agent: "reviewer", state: "completed" }, { childId: "api", agent: "worker", state: "paused", activity: { currentTool: "contact_supervisor", toolCount: 4, tokens: 80 } }] },
		workflowGraph: { phases: [{ title: "Implementation" }] },
	}, "running");
	assert.deepEqual(live.children.map((child) => child.label), ["api", "review"]);
	assert.equal(live.children[0]!.waitingOn, "main");
	assert.equal(live.children[0]!.tools, 4);
	assert.equal(live.children[0]!.role, "mutation");
	assert.equal(live.children[1]!.status, "done");
	assert.deepEqual(live.phases, ["Implementation"]);
});

test("unknown workflow shapes keep the legacy rendering and malformed fields are ignored", () => {
	for (const value of [null, false, [], "bad", 42, { lanes: [null, false, {}, { key: 3 }] }]) {
		const result = subagentOf(scoutArgs, { preflight: value, workflowChildren: value, workflowGraph: value }, "running");
		assert.equal(result.children.length, 1);
		assert.equal(result.children[0]!.agent, "scout");
	}
	const result = subagentOf({ workflow: true }, { preflight: { lanes: [{ key: "a", mode: "unknown", claims: ["file", 9, null] }] }, results: [{ workflowKey: "a", agent: "worker", timedOut: true, exitCode: 1 }] }, "done");
	assert.deepEqual(result.preflight?.lanes[0]!.claims, ["file"]);
	assert.equal(result.preflight?.lanes[0]!.mode, undefined);
	assert.equal(result.children[0]!.timedOut, true);
});

test("a subagent shows its agent and task before any progress arrives", () => {
	const subagent = subagentOf(scoutArgs, undefined, "running");
	assert.deepEqual(subagent.children.map((child) => [child.agent, child.status]), [["scout", "running"]]);
	assert.deepEqual(describeSubagent(subagent, scoutArgs, "running"), { target: "scout: Map the auth flow", meta: "", tone: "plain" });
});

test("live progress gives the child's current tool, steps and counts", () => {
	const details = {
		mode: "single",
		results: [{ index: 0, agent: "scout", task: scoutArgs.task, exitCode: -1 }],
		progress: [{
			index: 0, agent: "scout", status: "running", currentTool: "read", currentToolArgs: "src/auth.ts",
			recentTools: [{ tool: "grep", args: '"login" src', endMs: 1 }], toolCount: 1, tokens: 5200, durationMs: 4000,
		}],
	};
	const [child] = subagentOf(scoutArgs, details, "running").children;
	assert.deepEqual(child!.current, { tool: "read", target: "src/auth.ts" });
	assert.deepEqual(child!.steps, [{ tool: "grep", target: '"login" src', endMs: 1 }], "each call keeps when it ended");
	assert.equal(child!.tools, 1);
	assert.equal(child!.tokens, 5200);
	assert.equal(child!.output, undefined);
});

test("a finished call keeps each child's answer, and a failed child marks the step", () => {
	const details = {
		mode: "workflow",
		results: [
			{ index: 0, agent: "reviewer", workflowKey: "tests", task: "Check tests", exitCode: 0, finalOutput: "Covered.", model: "sonnet", context: "fresh",
				usage: { input: 1000, output: 200 }, toolCalls: [{ text: "bash npm test" }, { text: "read test/a.ts" }] },
			{ index: 1, agent: "reviewer", workflowKey: "cleanup", task: "Look for cleanup", exitCode: 1, error: "Model overloaded" },
		],
	};
	const subagent = subagentOf({ workflow: true }, details, "done");
	const [tests, cleanup] = subagent.children;
	assert.equal(tests!.status, "done");
	assert.equal(tests!.label, "tests");
	assert.equal(tests!.output, "Covered.");
	assert.equal(tests!.tokens, 1200);
	assert.deepEqual(tests!.steps, [{ tool: "bash", target: "npm test" }, { tool: "read", target: "test/a.ts" }]);
	assert.equal(cleanup!.status, "error");
	assert.equal(cleanup!.error, "Model overloaded");
	assert.deepEqual(describeSubagent(subagent, { workflow: true }, "done"), { target: "2 agents: reviewer", meta: "1 failed", tone: "error" });
});

test("a background launch says so instead of counting tools", () => {
	const subagent = subagentOf(scoutArgs, { mode: "single", asyncId: "run-1", results: [] }, "done");
	assert.equal(subagent.background, true);
	assert.equal(describeSubagent(subagent, scoutArgs, "done").meta, "background");
});

const notifyMessage = {
	role: "custom",
	customType: "subagent-notify",
	content: "Background task completed: **researcher**\n\nElectron is slower.\n\nIt loads Chromium.\n\nSession file: /tmp/a.jsonl\n\nParent action: Report it.",
	display: false,
	details: { runs: [{ agent: "researcher", status: "completed", durationMs: 198_000 }] },
	timestamp: 5000,
};

test("a background result reads as agent, status, time and the result alone", () => {
	assert.deepEqual(noticeOf(notifyMessage), {
		agent: "researcher",
		status: "completed",
		durationMs: 198_000,
		text: "Electron is slower.\n\nIt loads Chromium.",
		sessionFile: "/tmp/a.jsonl",
	});
	assert.equal(noticeOf({ role: "custom", customType: "other", content: "x" }), undefined);
});

test("a running child's session file is where pi-subagents writes it, beside the parent's", () => {
	const parent = join("sessions", "proj", "2026-11-18_abc.jsonl");
	const details = { mode: "parallel", runId: "r1", progress: [{ index: 0, agent: "scout", status: "running" }, { index: 1, agent: "worker", status: "running" }] };
	const files = subagentOf({ workflow: true }, details, "running", parent).children.map((child) => child.sessionFile);
	assert.deepEqual(files, [0, 1].map((index) => join("sessions", "proj", "2026-11-18_abc", "r1", `run-${index}`, "session.jsonl")));
	// The finished result names its file, which wins; without a parent file or run id there is none to guess.
	const done = { mode: "single", runId: "r1", results: [{ index: 0, agent: "scout", task: "t", exitCode: 0, sessionFile: "/elsewhere/s.jsonl" }] };
	assert.equal(subagentOf(scoutArgs, done, "done", parent).children[0]!.sessionFile, "/elsewhere/s.jsonl");
	assert.equal(subagentOf(scoutArgs, { ...details, runId: undefined }, "running", parent).children[0]!.sessionFile, undefined);
	assert.equal(childSessionFile(parent, "../up", 0), undefined);
});

test("a workflow child's session is in its own run's folder, while it runs and once it is done", () => {
	const parent = join("sessions", "proj", "2026-11-18_abc.jsonl");
	const root = join("sessions", "proj", "2026-11-18_abc");
	// The call's run id names the tool call, not a folder; each child reports a run of its own.
	const running = {
		mode: "workflow",
		runId: "call_3ef9%7Cfc_0dee",
		workflowChildren: { children: [{ childId: "slug", runId: "1435-a294", state: "running" }, { childId: "csv", runId: "1e69-e619", state: "pending" }] },
	};
	assert.deepEqual(
		subagentOf({ workflow: true }, running, "running", parent).children.map((child) => [child.label, child.sessionFile]),
		[["slug", join(root, "1435-a294", "run-0", "session.jsonl")], ["csv", join(root, "1e69-e619", "run-0", "session.jsonl")]],
	);
	const done = { mode: "workflow", runId: "call_3ef9%7Cfc_0dee", results: [{ index: 0, agent: "worker", workflowKey: "slug", runId: "1435-a294", exitCode: 0 }] };
	assert.equal(subagentOf({ workflow: true }, done, "done", parent).children[0]!.sessionFile, join(root, "1435-a294", "run-0", "session.jsonl"));
});

test("a background result starts its own run, in history and live", () => {
	const messages = [
		{ role: "user", content: "Research startup times", timestamp: 1000 },
		{ role: "assistant", content: [{ type: "text", text: "Started it." }], timestamp: 2000 },
		notifyMessage,
		{ role: "assistant", content: [{ type: "text", text: "Electron is slower." }], timestamp: 6000 },
	] as unknown as Messages;
	const runs = new RunTracker(messages).all();
	assert.equal(runs.length, 2);
	assert.equal(runs[0]!.endedAt, 2000);
	assert.equal(runs[1]!.notice?.agent, "researcher");
	assert.equal(runs[1]!.prompt, "");
	assert.equal(runs[1]!.answer, "Electron is slower.");

	const live = new RunTracker(messages.slice(0, 2));
	assert.equal(live.apply({ type: "message_start", message: notifyMessage } as unknown as Event), true);
	assert.equal(live.current()?.run.notice?.status, "completed");
	assert.equal(live.current()?.run.status, "running");
	assert.equal(live.userMessage(1), undefined);
});

test("a running subagent step carries its children from live updates", () => {
	const tracker = new RunTracker([]);
	tracker.apply({ type: "message_start", message: { role: "user", content: "Delegate" } } as unknown as Event);
	tracker.apply({ type: "message_start", message: { role: "assistant", content: [] } } as unknown as Event);
	tracker.apply({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "subagent", arguments: scoutArgs }] },
	} as unknown as Event);
	tracker.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "subagent", args: scoutArgs } as unknown as Event);
	tracker.apply({
		type: "tool_execution_update", toolCallId: "t1", toolName: "subagent", args: scoutArgs,
		partialResult: { content: [{ type: "text", text: "(running...)" }], details: { progress: [{ index: 0, agent: "scout", status: "running", toolCount: 3, currentTool: "read", currentToolArgs: "a.ts" }] } },
	} as unknown as Event);
	const step = tracker.current()!.run.steps[0]!;
	assert.equal(step.subagent?.children[0]?.tools, 3);
	assert.equal(step.meta, "3 tools");
	assert.equal(step.target, "scout: Map the auth flow");
});

test("a queued workflow's children, a failed child's tool and step end times are read from the details", () => {
	const queued = subagentOf({ workflow: true }, { preflight: { lanes: [{ key: "a", mode: "review" }] }, workflowChildren: { workflowState: "queued", children: [{ childId: "a", state: "pending" }] } }, "running");
	assert.equal(queued.children[0]!.queued, true);
	const running = subagentOf({ workflow: true }, { preflight: { lanes: [{ key: "a", mode: "review" }] }, workflowChildren: { workflowState: "running", children: [{ childId: "a", state: "pending" }] } }, "running");
	assert.equal(running.children[0]!.queued, undefined, "a pending child of a running workflow is only starting");
	const failed = subagentOf(scoutArgs, { results: [{ index: 0, agent: "scout", exitCode: 1, error: "boom", outputPartial: true, progressSummary: { failedTool: "bash", recentTools: [{ tool: "bash", args: "npm test", endMs: 1700000000000 }] } }] }, "error");
	assert.equal(failed.children[0]!.failedTool, "bash");
	assert.equal(failed.children[0]!.outputPartial, true);
	assert.equal(failed.children[0]!.steps[0]!.endMs, 1700000000000);
});

test("a subagent session says its thinking level and how full its context was at its latest response", async () => {
	const { sessionUsage } = await import("../src/main/subagents.ts");
	const reply = (input: number) => ({ type: "message", message: { role: "assistant", provider: "anthropic", model: "m", usage: { input, output: 0, totalTokens: input } } });
	const window = (provider: string, model: string) => (provider === "anthropic" && model === "m" ? 200_000 : undefined);
	assert.deepEqual(sessionUsage([{ type: "thinking_level_change", thinkingLevel: "high" }, reply(40_000), reply(82_000)], window), { thinking: "high", context: 41 });
	assert.deepEqual(sessionUsage([{ type: "thinking_level_change", thinkingLevel: "off" }, reply(10)], () => undefined), { thinking: undefined, context: undefined });
});
