import assert from "node:assert/strict";
import test from "node:test";
import { agentAttentionKey, agentCounts, agentSteps, currentStep, phaseOf } from "../src/renderer/agents.ts";
import type { Run, Subagent } from "../src/shared/protocol.ts";

test("workflow counts include all eight children and waiting is distinct from user attention", () => {
	const children = Array.from({ length: 8 }, (_, index) => ({ status: index === 0 ? "done" : "running", waitingOn: index === 1 ? "main" : undefined }));
	const runs = [{ steps: [{ status: "running", subagent: { children } }] }] as unknown as Run[];
	assert.deepEqual(agentCounts(runs), { running: 7, waiting: 1 });
	assert.equal(phaseOf({ children: [{ role: "mutation" }] } as Subagent), "Implementing");
});

test("background children stay active until their grouped run-id notification arrives", () => {
	const launch = { status: "done", subagent: { background: true, asyncId: "child-1", children: [{ status: "running", tools: 0, agent: "scout" }] } };
	const runs = [{ steps: [launch] }] as unknown as Run[];
	assert.equal(agentCounts(runs).running, 1);
	runs.push({ steps: [], notice: { runIds: ["unrelated"], status: "completed" } } as unknown as Run);
	assert.equal(agentCounts(runs).running, 1);
	runs.push({ steps: [], notice: { runIds: ["child-1"], status: "completed", text: "Mapped it" } } as unknown as Run);
	assert.equal(agentCounts(runs).running, 0);
	assert.equal(agentSteps(runs)[0]!.subagent!.children[0]!.output, "Mapped it");
	assert.equal(launch.subagent.children[0]!.status, "running", "display pairing does not mutate the stored launch");
});

test("the thread and Now line follow the current step and stop showing an old tool when the answer starts", () => {
	const run = { status: "running", answer: "", steps: [{ tool: "bash", target: "npm test", status: "running" }, { tool: "note", status: "done" }] } as unknown as Run;
	assert.equal(currentStep(run)?.target, "npm test");
	run.answer = "The tests passed";
	assert.equal(currentStep(run), undefined);
	run.status = "done";
	assert.equal(currentStep(run), undefined);
});

test("seeing live agents does not acknowledge a failure or kept worktree that arrives later", () => {
	const runs = [{ steps: [{ id: "phase", status: "running", subagent: { children: [{ status: "running" }] } }] }] as unknown as Run[];
	const before = agentAttentionKey(runs);
	runs[0]!.steps[0]!.status = "done";
	runs[0]!.steps[0]!.subagent!.children[0]!.status = "error";
	assert.notEqual(agentAttentionKey(runs), before);
	const failed = agentAttentionKey(runs);
	runs[0]!.steps[0]!.subagent!.keptWorktrees = [{ path: "/kept", branch: "branch", reason: "capture failed" }];
	assert.notEqual(agentAttentionKey(runs), failed);
});

test("the plan head counts writers by place and readers by kind, singular and plural apart", async () => {
	const { claimsOf, KINDS, listOf, middle, stateWord, teamOf } = await import("../src/renderer/agents.ts");
	const writer = (worktree: boolean) => ({ role: "mutation", worktree, agent: "worker" }) as never;
	const reviewer = { role: "review", agent: "reviewer" } as never;
	assert.equal(teamOf([writer(true), writer(true), reviewer]), "2 writers in their own worktrees, 1 reviewer");
	assert.equal(teamOf([writer(false)]), "1 writer");
	assert.equal(teamOf([writer(true), writer(true), reviewer], false), "2 writers, 1 reviewer", "the finished step leaves places out");
	assert.equal(teamOf([reviewer, reviewer, reviewer]), "3 reviewers");
	// Without a plan, kinds come from the agents' names, as the phase word does.
	assert.equal(teamOf([{ agent: "scout" }, { agent: "reviewer" }, { agent: "claude-code" }] as never), "1 reviewer, 1 scout, 1 agent");
	assert.equal(claimsOf(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]), "src/a.ts, src/b.ts, +2 more");
	assert.equal(claimsOf(["src/a.ts"]), "src/a.ts");
	assert.equal(listOf([]), "");
	assert.equal(stateWord({ status: "pending", queued: true } as never), "Queued");
	assert.equal(stateWord({ status: "running", waitingOn: "main" } as never), "Waiting");
	assert.equal(stateWord({ status: "error", timedOut: true } as never), "Timed out");
	const branch = "pi-sub/7f3a9c-orchestrator-api-refresh-handler";
	const short = middle(branch, 24);
	assert.equal(short.length, 24);
	assert.ok(short.endsWith("handler") && short.startsWith("pi-sub/"), short);
	assert.equal(middle("main"), "main");
	const { TABLES } = await import("../src/shared/i18n.ts");
	const { VERBS } = await import("../src/renderer/verbs.ts");
	const keys = [...Object.values(KINDS).flat(), ...Object.values(VERBS).flatMap((verb) => [verb.live, verb.now])];
	for (const [locale, table] of Object.entries(TABLES)) assert.deepEqual(keys.filter((key) => !(key in table)), [], locale);
});

test("the Now line says the current step in plain words, never the raw tool call", async () => {
	const { nowLine } = await import("../src/renderer/verbs.ts");
	const bash = { tool: "bash", target: "npm test", status: "running" };
	assert.equal(nowLine({ steps: [bash], answer: "" } as unknown as Run, bash as never), "Now: running npm test");
	const fanout = { tool: "subagent", status: "running", subagent: { children: [{ status: "running" }, { status: "running" }, { status: "pending" }] } };
	assert.equal(nowLine({ steps: [fanout] } as unknown as Run, fanout as never), "Now: waiting for 3 agents");
	const one = { ...fanout, subagent: { children: [{ status: "running" }] } };
	assert.equal(nowLine({ steps: [one] } as unknown as Run, one as never), "Now: waiting for 1 agent");
	assert.equal(nowLine({ steps: [], answer: "Done" } as unknown as Run, undefined), "Now: writing the answer");
	assert.equal(nowLine({ steps: [] } as unknown as Run, { tool: "mcp_call", target: "x" } as never), "Now: using mcp_call");
});
