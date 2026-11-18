import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Run } from "../src/shared/protocol.ts";
import { readSubagentActivity } from "../src/main/subagent-activity.ts";
import { subagentOf } from "../src/main/subagents.ts";

const runsFor = (...sessionFiles: string[]) => [{ steps: [{ subagent: subagentOf({ workflow: true }, {
	results: sessionFiles.map((sessionFile, index) => ({ index: 0, agent: "worker", workflowKey: `part-${index}`, exitCode: 0, sessionFile })),
}, "done") }] }] as unknown as Run[];

function session(command: string, failed = false) {
	const messages: unknown[] = [{ role: "user", content: "Implement one module", timestamp: 1000 }];
	for (let index = 0; index < 8; index++) {
		messages.push({ role: "assistant", content: [
			{ type: "thinking", thinking: "Internal text is not tool activity" },
			{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: `${command} ${index}\nsecond line` } },
		], timestamp: 2000 + index * 100 });
		messages.push({ role: "toolResult", toolCallId: `call-${index}`, toolName: "bash", content: [{ type: "text", text: `result ${index}` }], isError: failed, timestamp: 2050 + index * 100 });
	}
	return messages.map((message) => JSON.stringify({ type: "message", message })).join("\n");
}

test("workflow details load every saved tool call with full input, output, status and end time", async () => {
	const root = await mkdtemp(join(tmpdir(), "trivium-child-activity-"));
	try {
		const first = join(root, "first.jsonl"), second = join(root, "second.jsonl");
		await writeFile(first, session("npm test"));
		await writeFile(second, session("npm run check", true));
		const runs = runsFor(first, second);
		const roots = { trees: [root], temp: [] };
		const steps = await readSubagentActivity(first, runs, roots);
		assert.equal(steps.length, 8, "the view can expand beyond six steps");
		assert.deepEqual(JSON.parse(steps[0]!.input!), { command: "npm test 0\nsecond line" });
		assert.equal(steps[7]!.output, "result 7");
		assert.equal(steps[0]!.status, "done");
		assert.equal(steps[0]!.endMs, 2050);
		const other = await readSubagentActivity(second, runs, roots);
		assert.equal(other[0]!.status, "error");
		assert.match(other[0]!.input!, /npm run check/);
		await assert.rejects(readSubagentActivity(first, runsFor(second), roots), /Unknown subagent session/);
		await assert.rejects(readSubagentActivity(first, runs, { trees: [], temp: [] }), /unavailable/);
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test("missing and oversized child sessions fail without reading arbitrary files", async () => {
	const root = await mkdtemp(join(tmpdir(), "trivium-child-activity-"));
	try {
		const file = join(root, "child.jsonl");
		const roots = { trees: [root], temp: [] };
		await assert.rejects(readSubagentActivity(file, runsFor(file), roots), /unavailable/);
		await writeFile(file, " ".repeat(8 * 1024 * 1024 + 1));
		await assert.rejects(readSubagentActivity(file, runsFor(file), roots), /display limit/);
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
