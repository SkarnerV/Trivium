import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { exportFileName, sessionMarkdown } from "../src/main/export.ts";

const at = new Date(2026, 9, 26, 15, 22).getTime();

test("an export lists each prompt, the tools called and the answers, without thinking", () => {
	const messages = [
		{ role: "user", content: '<file name="C:\\shop\\notes.txt">\nhello\n</file>\nFix the bug in total()', timestamp: at },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "The loop runs past the end." },
				{ type: "text", text: "Reading the cart." },
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/cart.ts" } },
			],
			timestamp: at,
		},
		{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "export function total() {}" }], isError: false, timestamp: at },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "2", name: "bash", arguments: { command: "npm test\n--watch" } },
				{ type: "text", text: "Fixed the off-by-one." },
			],
			timestamp: at,
		},
	] as unknown as AgentMessage[];
	const markdown = sessionMarkdown({ title: "Fix total", id: "01a1", cwd: "C:\\shop", messages }, new Date(at));
	assert.equal(
		markdown,
		[
			"# Fix total",
			"",
			"Session `01a1` · C:\\shop · exported 2026-10-26 15:22",
			"",
			"## You · 2026-10-26 15:22",
			"",
			"Fix the bug in total()",
			"",
			"Attached: notes.txt",
			"",
			"## Assistant · 2026-10-26 15:22",
			"",
			"Reading the cart.",
			"",
			"- `read` src/cart.ts",
			"",
			"- `bash` npm test",
			"",
			"Fixed the off-by-one.",
			"",
		].join("\n"),
	);
});

test("export file names drop characters file systems refuse", () => {
	assert.equal(exportFileName('Fix "total": a/b?'), "Fix total a b");
	assert.equal(exportFileName("  "), "Session");
	assert.equal(exportFileName("x".repeat(120)).length, 80);
});
