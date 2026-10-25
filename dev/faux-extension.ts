// Development only: a scripted model so the UI can be exercised without a real provider.
// Loaded into every session when TRIVIUM_DEV_FAUX=1.
import { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
					fauxThinking("The user wants a check of the project, so read the manifest and run a quick command."),
					fauxText("Let me look at the project first."),
					fauxToolCall("read", { path: "package.json" }),
					fauxToolCall("edit", {
						path: "src/reader.ts",
						edits: [
							{
								oldText: 'import { createInterface } from "node:readline";\nimport { spawn } from "node:child_process";',
								newText: 'import { RpcClient } from "@earendil-works/pi-coding-agent";',
							},
							{
								oldText:
									'const child = spawn("node", [piCliPath, "--mode", "rpc"]);\nconst lines = createInterface({ input: child.stdout });\nlines.on("line", (line) => onRecord(JSON.parse(line)));',
								newText:
									"const client = new RpcClient({ cliPath: piCliPath });\nclient.onEvent((event) => onRecord(event));\nawait client.start();",
							},
						],
					}),
					fauxToolCall("write", {
						path: "test/reader.test.ts",
						content:
							'import { test } from "node:test";\nimport assert from "node:assert/strict";\n\ntest("a prompt with U+2028 stays one record", () => {\n\tassert.equal("a\\u2028b".split("\\n").length, 1);\n});\n',
					}),
					fauxToolCall("bash", { command: "for i in 1 2 3; do echo step $i; sleep 1; done" }),
				],
				{ stopReason: "toolUse" },
			),
		() =>
			fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which test runner should I use?", options: ["node:test", "vitest", "Skip tests"] })], {
				stopReason: "toolUse",
			}),
		() =>
			fauxAssistantMessage(
				fauxText(
					"Done. The project builds with **esbuild** and runs in Electron.\n\n- `npm start` builds and launches\n- `npm run check` type-checks\n\n```sh\nnpm start\n```",
				),
			),
	];
	core.setResponses(Array.from({ length: 30 }, (_, index) => () => script[index % script.length]!()));

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
