import assert from "node:assert/strict";
import test from "node:test";
import { agentCounts, agentSteps, currentStep } from "../src/renderer/agents.ts";
import type { Run } from "../src/shared/protocol.ts";

test("workflow counts include all eight children and waiting is distinct from user attention", () => {
	const children = Array.from({ length: 8 }, (_, index) => ({ status: index === 0 ? "done" : "running", waitingOn: index === 1 ? "main" : undefined }));
	const runs = [{ steps: [{ status: "running", subagent: { children } }] }] as unknown as Run[];
	assert.deepEqual(agentCounts(runs), { running: 7, waiting: 1 });
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

test("the thread's live line follows the current step and stop showing an old tool when the answer starts", () => {
	const run = { status: "running", answer: "", steps: [{ tool: "bash", target: "npm test", status: "running" }, { tool: "note", status: "done" }] } as unknown as Run;
	assert.equal(currentStep(run)?.target, "npm test");
	run.answer = "The tests passed";
	assert.equal(currentStep(run), undefined);
	run.status = "done";
	assert.equal(currentStep(run), undefined);
});

test("a lane's claimed files read as a short list, and the live verbs are translated", async () => {
	const { claimsOf, listOf } = await import("../src/renderer/agents.ts");
	assert.equal(claimsOf(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]), "src/a.ts, src/b.ts, +2 more");
	assert.equal(claimsOf(["src/a.ts"]), "src/a.ts");
	assert.equal(listOf([]), "");
	const { TABLES } = await import("../src/shared/i18n.ts");
	const { VERBS } = await import("../src/renderer/verbs.ts");
	const keys = Object.values(VERBS);
	for (const [locale, table] of Object.entries(TABLES)) assert.deepEqual(keys.filter((key) => !(key in table)), [], locale);
});
