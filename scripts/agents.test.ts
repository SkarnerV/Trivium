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
