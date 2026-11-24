import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ORCHESTRATOR_PROMPT, WorkModeIndex, workModeExtension, workModePrompt } from "../src/main/work-modes.ts";
import type { WorkModeId } from "../src/shared/work-modes.ts";

test("Default keeps the system prompt byte-identical and the extension reads the mode on every run", () => {
	const prompt = "Existing pi prompt\r\n\nUnicode: 日本語 中文\t  ";
	assert.equal(workModePrompt(prompt, "default"), prompt);
	let mode: WorkModeId = "default";
	let handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined = () => undefined;
	workModeExtension(() => mode)({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as unknown as ExtensionAPI);
	assert.equal(handler({ systemPrompt: prompt }), undefined, "Default supplies no override at all");
	mode = "orchestrator";
	assert.equal(handler({ systemPrompt: prompt })?.systemPrompt, `${prompt}\n\n${ORCHESTRATOR_PROMPT}`);
	mode = "default";
	assert.equal(handler({ systemPrompt: prompt }), undefined);
});

test("the Orchestrator prompt asks for one forked writer, single calls and a verified answer", () => {
	// The writer has the user's words, not a retelling of them, or the main agent does the work.
	assert.match(ORCHESTRATOR_PROMPT, /subagent\(\{agent: "worker", task, async: \w+, options: \{[^}]*context: "fork"[^}]*\}\}\)/);
	assert.match(ORCHESTRATOR_PROMPT, /one writer at a time/);
	// In the background with a time limit, so the user can keep talking and a child's question can be answered.
	const calls = [...ORCHESTRATOR_PROMPT.matchAll(/subagent\(\{[^)]*\}\)/g)].map(([text]) => text);
	assert.equal(calls.length, 2);
	for (const text of calls) assert.match(text, /async: true, options: \{[^}]*timeoutMs: \d+\}/);
	assert.doesNotMatch(ORCHESTRATOR_PROMPT, /async: false/);
	assert.match(ORCHESTRATOR_PROMPT, /end your turn; do not wait, poll or repeat it/);
	assert.match(ORCHESTRATOR_PROMPT, /answer it with subagent_supervisor/);
	assert.match(ORCHESTRATOR_PROMPT, /If the fork is refused or unavailable, make the changes yourself/);
	// No scripts, plans of them or patch handling, and nothing that reviews beside a writer.
	for (const gone of [/runs\.(?:all|run)/, /preflight/i, /\bworkflow\b/, /worktree/, /git apply/, /results\.map/, /\.js\b/, /globalConcurrencyLimit/, /parallel/i]) assert.doesNotMatch(ORCHESTRATOR_PROMPT, gone);
	assert.match(ORCHESTRATOR_PROMPT, /reviewer only once the writer has ended/);
	assert.match(ORCHESTRATOR_PROMPT, /only after its patch is verified and applied/);
	assert.match(ORCHESTRATOR_PROMPT, /never commit, stash or discard/);
	// What a child says is not a pass, and neither is a command still running.
	assert.match(ORCHESTRATOR_PROMPT, /name the command you ran and its exit code, or say plainly that the work is unverified/);
	assert.match(ORCHESTRATOR_PROMPT, /moved to background has not ended and is never a pass/);
	assert.match(ORCHESTRATOR_PROMPT, /your answer cannot give it a permission/);
});

test("session modes persist, fork by session id and delete without affecting another session", async () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-modes-"));
	try {
		const file = join(root, "session-work-modes.json");
		const index = new WorkModeIndex(file);
		assert.equal(index.get("old-session"), "default");
		await index.set("parent", "orchestrator");
		const reopened = new WorkModeIndex(file);
		assert.equal(reopened.get("parent"), "orchestrator");
		await reopened.set("fork", reopened.get("parent"));
		await reopened.delete("parent");
		assert.equal(new WorkModeIndex(file).get("fork"), "orchestrator");
		assert.equal(new WorkModeIndex(file).get("parent"), "default");
		assert.equal("parent" in JSON.parse(readFileSync(file, "utf8")), false);
		writeFileSync(file, '{"invalid":"other","valid":"orchestrator"}');
		assert.equal(new WorkModeIndex(file).get("invalid"), "default");
	} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
