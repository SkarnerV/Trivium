// Development only: a scripted model so the UI can be exercised without a real provider.
// Loaded into every session when TRIVIUM_DEV_FAUX=1.
//
// Each app gets its own story, picked from the system prompt the app adds:
// - Code fixes a bug in src/reader.ts: investigate, ask where the test goes, fix and test, explain.
// - Research writes notes/electron-vs-tauri.md with a comparison and cited sources, then extends it.
// - Write tightens two paragraphs of docs/rpc-integration.md and adds one.
// Every prompt replays the story from its first step.
import {
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";
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

const researchNote = [
	"# Electron vs Tauri for a pi desktop app",
	"",
	"**Recommendation:** Electron. Its main process is Node, so the pi SDK runs there directly [1], and a utility process can host it later if isolation matters [2].",
	"",
	"| | Electron | Tauri |",
	"| --- | --- | --- |",
	"| Runs pi | Main or utility process | Sidecar Node binary |",
	"| Talks to pi | SDK in process | RPC over stdio |",
	"| Download | Larger, ships Chromium | Small, uses the system webview |",
	"| Rendering | Same on every OS | Differs per webview |",
	"",
	"For one user on one machine the larger download costs little, and running pi without a second runtime removes a whole layer.",
	"",
	"## Sources",
	"",
	"1. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)",
	"2. [Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process)",
	"3. [Tauri sidecar binaries](https://v2.tauri.app/develop/sidecar/)",
	"",
].join("\n");

const securityNote = [
	"## Security",
	"",
	"Both sandbox the page. Electron needs `contextIsolation` and a narrow preload bridge [4]; Tauri limits commands per window through capabilities [5].",
	"",
	"4. [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)",
	"5. [Tauri capabilities](https://v2.tauri.app/security/capabilities/)",
	"",
].join("\n");

/** The first lines of docs/rpc-integration.md that the Write story edits. The test setup writes the same file. */
const writeEdits = [
	{
		oldText:
			"You start Pi with the --mode rpc flag and then you can send it commands by writing JSON objects to its standard input, one per line, and it will answer you on standard output.",
		newText: "Start Pi with `pi --mode rpc`. Write one JSON command per line to stdin; Pi answers on stdout.",
	},
	{
		oldText: "## Reading events",
		newText: 'To start a run, send `{"type": "prompt", "message": "..."}`.\n\n## Reading events',
	},
	{
		oldText: "Some line readers also split on U+2028, which breaks records that contain it.",
		newText:
			"Node's readline also splits on U+2028 and U+2029, which breaks records that contain them. Use pi's RpcClient, which splits on newlines only.",
	},
];

type Step = () => ReturnType<typeof fauxAssistantMessage>;

const RESEARCH: Step[] = [
	() =>
		fauxAssistantMessage(
			[
				fauxThinking("Compare where pi runs and how the app talks to it, then write it up with sources."),
				fauxText("I'll write the comparison as a note."),
				fauxToolCall("write", { path: "notes/electron-vs-tauri.md", content: researchNote }),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			[
				fauxText("Adding the security angle."),
				// Research has no edit tool, so it rewrites the note.
				fauxToolCall("write", {
					path: "notes/electron-vs-tauri.md",
					content: researchNote.replace("## Sources", `${securityNote}\n## Sources`),
				}),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			fauxText(
				"The note is in `notes/electron-vs-tauri.md`: **Electron**, because pi runs in its Node main process without a second runtime. It cites five sources; the panel on the right lists them.",
			),
		),
];

const WRITE: Step[] = [
	() =>
		fauxAssistantMessage(
			[
				fauxThinking("Tighten the wordy setup paragraph, fix the framing advice, and add how to start a run."),
				fauxToolCall("read", { path: "docs/rpc-integration.md" }),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			[
				fauxText("Making three small edits."),
				fauxToolCall("edit", { path: "docs/rpc-integration.md", edits: writeEdits }),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			fauxText("Three changes are ready to review on the right: a shorter setup paragraph, how to start a run, and the line-splitting advice. Accept or reject each one."),
		),
];

function textOf(message: unknown): string {
	return JSON.stringify(message);
}

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
	const scripts: Record<string, Step[]> = { code: script, research: RESEARCH, write: WRITE };
	// The step is the number of assistant turns since the user's last message, so every prompt
	// replays its app's story from the start.
	const respond: FauxResponseFactory = (context) => {
		const system = context.messages.filter((m) => (m.role as string) === "system").map(textOf).join("\n");
		const app = system.includes("research assistant") ? "research" : system.includes("writing assistant") ? "write" : "code";
		const lastUser = context.messages.findLastIndex((m) => m.role === "user");
		const step = context.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
		const story = scripts[app]!;
		return story[Math.min(step, story.length - 1)]!();
	};
	core.setResponses(Array.from({ length: 200 }, () => respond));

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
