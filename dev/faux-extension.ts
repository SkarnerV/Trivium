// Development only: a scripted model so the UI can be exercised without a real provider.
// Loaded into every session when TRIVIUM_DEV_FAUX=1.
//
// Each app gets its own story, picked from the system prompt the app adds:
// - Code fixes a bug in src/reader.ts: investigate, ask where the test goes, fix and test, explain.
// - Research writes notes/electron-vs-tauri.md with a comparison and cited sources, then extends it.
// - Write tightens two paragraphs of docs/rpc-integration.md and adds one.
// - A prompt that mentions "subagent", in any app, delegates: one child, three in parallel, then one in
//   the background whose result arrives later as its own run.
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

/** A scripted child: the tool calls it makes, one every `pace` ms, and what it answers. */
interface FauxChild {
	agent: string;
	task: string;
	label?: string;
	calls: [tool: string, args: string][];
	output: string;
	pace: number;
}

const SCOUT: FauxChild = {
	agent: "scout",
	task: "Map how sessions are created and refreshed in the auth flow. List entry points and risks.",
	calls: [
		["grep", '"createSession" src'],
		["read", "src/auth/session.ts"],
		["read", "src/auth/refresh.ts"],
		["grep", '"refreshTimer" src'],
		["read", "src/auth/logout.ts"],
		["bash", "git log --oneline -5 -- src/auth"],
		["read", "src/auth/store.ts"],
		["read", "test/auth.test.ts"],
	],
	output: [
		"Sessions start in `createSession()` (src/auth/session.ts) and refresh in `scheduleRefresh()` (src/auth/refresh.ts).",
		"",
		"- **Entry points:** `login()`, `restoreSession()` on startup, and the 401 retry in `fetchWithAuth()`",
		"- **Risk:** the refresh timer is never cleared on logout, so a signed-out user can get a new token",
	].join("\n"),
	pace: 700,
};

const REVIEWERS: FauxChild[] = [
	{
		agent: "reviewer",
		label: "correctness",
		task: "Review the logout fix for correctness.",
		calls: [["read", "src/auth/logout.ts"], ["grep", '"refreshTimer" src'], ["read", "src/auth/refresh.ts"], ["read", "src/auth/store.ts"], ["grep", '"clearTimeout" src']],
		output: "No correctness problems. `logout()` now clears the timer before dropping the token.",
		pace: 900,
	},
	{
		agent: "reviewer",
		label: "tests",
		task: "Check the logout fix is covered by tests.",
		calls: [["read", "test/auth.test.ts"], ["bash", "npm test -- auth"], ["read", "test/helpers.ts"], ["bash", "npm test -- auth --coverage"]],
		output: "Covered: the new test fails without the fix and passes with it.",
		pace: 1300,
	},
	{
		agent: "reviewer",
		label: "cleanup",
		task: "Look for leftover complexity in the change.",
		calls: [["read", "src/auth/logout.ts"], ["read", "src/auth/refresh.ts"]],
		output: "2 findings: an unused import, and `stopRefresh` could be inlined.",
		pace: 1100,
	},
];

const RESEARCHER: FauxChild = {
	agent: "researcher",
	task: "Compare Electron and Tauri cold-start times on macOS, with sources.",
	calls: [],
	output: "Electron cold-starts about 2.1× slower than Tauri on the test machine (420 ms vs 200 ms), mostly loading Chromium. Both are under half a second.",
	pace: 0,
};

const BACKGROUND_MS = 6000;

/** The details pi-subagents streams while its children work, shaped closely enough for Trivium to read. */
function fauxDetails(children: FauxChild[], elapsed: number, mode: string) {
	const views = children.map((child, index) => {
		const done = Math.min(child.calls.length, Math.floor(elapsed / child.pace));
		const finished = elapsed >= child.pace * (child.calls.length + 1);
		const current = finished ? undefined : child.calls[done];
		const durationMs = finished ? child.pace * (child.calls.length + 1) : elapsed;
		return {
			result: {
				index,
				agent: child.agent,
				task: child.task,
				workflowKey: child.label,
				exitCode: finished ? 0 : -1,
				model: "scripted",
				context: "fresh",
				usage: { input: 2400 * (done + 1), output: 180 * (done + 1), cacheRead: 0, cacheWrite: 0, cost: 0, turns: done + 1 },
				finalOutput: finished ? child.output : "",
			},
			progress: {
				index,
				agent: child.agent,
				task: child.task,
				status: finished ? "completed" : "running",
				currentTool: current?.[0],
				currentToolArgs: current?.[1],
				recentTools: child.calls.slice(0, done).map(([tool, args]) => ({ tool, args, endMs: 0 })),
				recentOutput: [],
				toolCount: done,
				tokens: 2580 * (done + 1),
				durationMs,
			},
			finished,
		};
	});
	return {
		finished: views.every((view) => view.finished),
		details: {
			mode,
			results: views.map((view) => ({ ...view.result, progress: view.progress })),
			progress: views.map((view) => view.progress),
		},
	};
}

/** Delegates three times: one child, three reviewers at once, then one in the background. */
const SUBAGENT_STORY: Step[] = [
	() =>
		fauxAssistantMessage(
			[
				fauxThinking("Before touching auth, get a map of how sessions are made and refreshed."),
				fauxText("I'll have scout map the auth flow first."),
				fauxToolCall("subagent", { agent: SCOUT.agent, task: SCOUT.task, async: false }),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			[
				fauxText("Now three reviewers in parallel on the logout fix."),
				fauxToolCall("subagent", { workflow: true, async: false }),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			[
				fauxText("While that settles, a researcher can look into startup times in the background."),
				fauxToolCall("subagent", { agent: RESEARCHER.agent, task: RESEARCHER.task }),
			],
			{ stopReason: "toolUse" },
		),
	() =>
		fauxAssistantMessage(
			fauxText(
				"Logout now clears the refresh timer, so a signed-out user can't get a new token. The three reviewers found no correctness problems and two small cleanups. The researcher is still running and will report back.",
			),
		),
];

const NOTICE_REPLY: Step = () =>
	fauxAssistantMessage(
		fauxText("The researcher is back: Electron starts about **2.1× slower** than Tauri here (420 ms vs 200 ms), but both stay under half a second, so it isn't a reason to switch."),
	);

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
		// pi hands a custom message to the model as a user message.
		const prompt = textOf(context.messages[lastUser]?.content);
		if (prompt.includes("Background task completed")) return NOTICE_REPLY();
		const story = /subagent/i.test(prompt) ? SUBAGENT_STORY : scripts[app]!;
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

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate a task to a child agent.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String()),
			task: Type.Optional(Type.String()),
			workflow: Type.Optional(Type.Boolean()),
			async: Type.Optional(Type.Boolean()),
		}),
		execute: async (_id, params, signal, update) => {
			if (params.agent === RESEARCHER.agent) {
				setTimeout(() => {
					pi.sendMessage(
						{
							customType: "subagent-notify",
							content: `Background task completed: **${RESEARCHER.agent}**\n\n${RESEARCHER.output}\n\nSession file: /tmp/faux-researcher.jsonl\n\nParent action: Report the result.`,
							display: false,
							details: { runs: [{ agent: RESEARCHER.agent, status: "completed", durationMs: BACKGROUND_MS }] },
						},
						{ triggerTurn: true },
					);
				}, BACKGROUND_MS);
				return {
					content: [{ type: "text", text: `Started ${RESEARCHER.agent} in the background.` }],
					details: { mode: "single", asyncId: "faux-researcher", background: true, results: [] },
				};
			}
			const children = params.workflow ? REVIEWERS : [SCOUT];
			const mode = params.workflow ? "workflow" : "single";
			const started = Date.now();
			for (;;) {
				if (signal?.aborted) throw new Error("Stopped");
				const { finished, details } = fauxDetails(children, Date.now() - started, mode);
				const text = details.results.map((result) => result.finalOutput).filter(Boolean).join("\n\n");
				if (finished) return { content: [{ type: "text", text }], details };
				update?.({ content: [{ type: "text", text: text || "(running...)" }], details });
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		},
	});
}
