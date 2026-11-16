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
