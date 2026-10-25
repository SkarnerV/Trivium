// Development only: a scripted model so the UI can be exercised without a real provider.
// Loaded into every session when TRIVIUM_DEV_FAUX=1.
//
// The script plays one bug fix in a project with src/reader.ts (see README, Development):
// investigate, ask where the test goes, fix and test, then explain. It repeats for later prompts.
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const fixedReader = [
	'import { RpcClient } from "@earendil-works/pi-coding-agent";',
	'import { piCliPath } from "./paths";',
	"",
	"// RpcClient splits records on \\n only. readline also splits on U+2028 and U+2029.",
	"const client = new RpcClient({ cliPath: piCliPath });",
	"client.onEvent((event) => onRecord(event));",
	"await client.start();",
].join("\n");

const regressionTest = [
	'import assert from "node:assert/strict";',
	'import { test } from "node:test";',
	"",
	'test("a prompt with U+2028 stays one record", () => {',
	'\tconst record = JSON.stringify({ text: "line one\\u2028line two" });',
	'\tassert.equal(record.split("\\n").length, 1);',
	"});",
	"",
].join("\n");

export default function (pi: ExtensionAPI) {
	const core = createFauxCore({
		provider: "trivium-faux",
		api: "trivium-faux",
		models: [{ id: "scripted", name: "Scripted", reasoning: true, contextWindow: 200_000, maxTokens: 8000 }],
		tokensPerSecond: 80,
	});
	const script = [
		() =>
			fauxAssistantMessage(
				[
					fauxThinking("The parse error only happens with pasted text, so look at how records are framed."),
					fauxText("Let me check how the reader splits records."),
					fauxToolCall("read", { path: "src/reader.ts" }),
					fauxToolCall("bash", { command: "grep -rn readline src" }),
				],
				{ stopReason: "toolUse" },
			),
		() =>
			fauxAssistantMessage(
				[
					fauxToolCall("ask_user", {
						question: "Where should the regression test live?",
						options: ["test/reader.test.ts (new file)", "Add it to an existing test", "Skip the test"],
					}),
				],
				{ stopReason: "toolUse" },
			),
		() =>
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/reader.ts",
						edits: [
							{
								oldText:
									'import { createInterface } from "node:readline";\nimport { spawn } from "node:child_process";\nimport { piCliPath } from "./paths";\n\nconst child = spawn("node", [piCliPath, "--mode", "rpc"]);\nconst lines = createInterface({ input: child.stdout });\nlines.on("line", (line) => onRecord(JSON.parse(line)));',
								newText: fixedReader,
							},
						],
					}),
					fauxToolCall("write", { path: "test/reader.test.ts", content: regressionTest }),
					fauxToolCall("bash", { command: "node --test test/reader.test.ts" }),
				],
				{ stopReason: "toolUse" },
			),
		() =>
			fauxAssistantMessage(
				fauxText(
					[
						"Found it. The reader used Node's `readline`, which also breaks lines at **U+2028** and **U+2029**. Text pasted from a PDF often contains those separators, so one JSON record was split into two invalid lines.",
						"",
						"- Switched to pi's `RpcClient`, which splits records on `\\n` only",
						"- Added `test/reader.test.ts`, which keeps a record with U+2028 in one piece",
						"",
						"The test passes. Review the diff on the right, then keep or revert it.",
					].join("\n"),
				),
			),
	];
	core.setResponses(Array.from({ length: 40 }, (_, index) => () => script[index % script.length]!()));

	pi.registerProvider("trivium-faux", {
		name: "Trivium dev",
		baseUrl: "http://localhost",
		apiKey: "faux",
		api: "trivium-faux",
		models: [
			{
				id: "scripted",
				name: "Scripted",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8000,
			},
		],
		streamSimple: (model, context, options) => core.streamSimple(model, context, options),
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description: "Ask the user to pick one option.",
		parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
		execute: async (_id, params, signal, _update, ctx) => {
			const choice = await ctx.ui.select(params.question, params.options, { signal });
			return { content: [{ type: "text", text: choice ? `User chose: ${choice}` : "User dismissed the question" }], details: {} };
		},
	});
}
