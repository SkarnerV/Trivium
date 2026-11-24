/**
 * Trivium's session host against the real pi-subagents package. Opt-in: `npm run test:real`. `npm test` leaves it out.
 *
 * The unit tests and dev/faux-extension.ts stand in for the package; this checks that what they stand in for is what it
 * does. It needs no account and no network: a scripted local model answers (model-server.ts), and everything is
 * written to throwaway folders (harness.ts). It takes a few minutes, and starts real runner processes.
 *
 * Run it after changing the pi-subagents version, or anything that reads what the package reports. See README.md here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SubagentChild } from "../../src/shared/protocol.ts";
import { agentCounts, agentSteps, supervisorQuestions } from "../../src/shared/agent-counts.ts";
import { type Real, startReal, until } from "./harness.ts";
import { messageText, type ModelMessage, type Step } from "./model-server.ts";

let real: Real;

before(async () => {
	real = await startReal();
});
after(async () => {
	await real?.close();
});

const call = (name: string, input: Record<string, unknown>): Step => () => ({ tools: [{ name, input }] });
const say = (text: string, delayMs?: number): Step => () => ({ text, delayMs });
const script = (name: string, ...steps: Step[]) => real.model.scripts.set(name, steps);
/** What a child must end with before the package runs its gate. */
const REPORT = `\`\`\`acceptance-report\n${JSON.stringify({ criteriaSatisfied: [], changedFiles: [], testsAddedOrUpdated: [], commandsRun: [], validationOutput: ["looked"], residualRisks: ["none"], noStagedFiles: true, diffSummary: "none", reviewFindings: ["no blockers"], manualNotes: "none" })}\n\`\`\``;
/** The request a child's question carries, once the main agent has been handed it. */
const requestIn = (messages: ModelMessage[]) => [...messages.map(messageText).join("\n").matchAll(/replyTo: \\?"([\w-]+)\\?"/g)].at(-1)?.[1];
/** Answers a question as soon as there is one; until then, or after, says where things stand. */
const replyWith = (message: string): Step => (messages) => {
	const id = requestIn(messages);
	const answered = JSON.stringify(messages).includes(`Replied to supervisor request ${id}`);
	return id && !answered ? { tools: [{ name: "subagent_supervisor", input: { action: "reply", replyTo: id, message } }] } : { text: "Noted." };
};
const childrenOf = async (path: string): Promise<SubagentChild[]> => agentSteps(await real.runs(path)).flatMap((step) => step.subagent!.children);
const notices = async (path: string) => (await real.runs(path)).flatMap((run) => (run.notice ? [run.notice] : []));
const ended = (path: string) => until("the completion notice", async () => (await notices(path)).some((notice) => notice.runIds?.length));
const toolText = (path: string) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { message?: { role: string; toolName?: string; content: unknown } })
		.filter((entry) => entry.message?.role === "toolResult")
		.map((entry) => ({ tool: entry.message!.toolName, text: messageText(entry.message as ModelMessage) }));
/** What the host does once a minute, and when settings change. */
const unloads = async (path: string) => {
	const host = real.host as unknown as { unloadIdle(): void; reloadApp(app: string): string[]; live: Map<string, { lastActive: number }>; settings: { update(patch: object): Promise<unknown> } };
	await host.settings.update({ idleMinutes: 1 });
	const live = host.live.get(path);
	if (live) live.lastActive = 0;
	host.unloadIdle();
	return !host.live.has(path) || host.reloadApp("code").includes(path);
};

test("gate: a command pi-subagents would run itself is asked about, and .env is blocked in every mode", async () => {
	const marker = join(real.project, "gate-ran.txt");
	script("gated", call("subagent", { agent: "scout", task: "@@quick@@", async: false, options: { gate: "git push" } }), say("Stopped."));
	script("quick", say("looked"));
	await real.setMode("auto");
	real.answer(() => "Deny");
	const path = await real.open(false);
	await real.prompt(path, "@@gated@@");
	await real.settled(path);
	assert.match(real.dialogs.at(-1)!.title, /Run this command when the subagent finishes\?\n\ngit push/);
	assert.ok(toolText(path).some((result) => result.tool === "subagent" && /denied/.test(result.text)));
	assert.equal(real.model.seen.some((request) => request.script === "quick"), false, "no child was started");

	// Why it matters: with no tool call of its own, the package runs a gate through a shell.
	script("harmless", call("subagent", { agent: "scout", task: "@@reported@@", async: false, options: { gate: `node -e "require('fs').writeFileSync('gate-ran.txt','1')"` } }), say("Ran."));
	script("reported", say(`looked\n\n${REPORT}`));
	const asked = real.dialogs.length;
	const ran = await real.open(false);
	await real.prompt(ran, "@@harmless@@");
	await real.settled(ran);
	assert.equal(existsSync(marker), true, `the package ran the gate in the project: ${JSON.stringify(toolText(ran))}`);
	assert.equal(real.dialogs.length, asked, "auto does not ask about it, as it would not for the shell tool");
	rmSync(marker, { force: true });

	await real.setMode("edits");
	const edits = await real.open(false);
	await real.prompt(edits, "@@harmless@@");
	await real.settled(edits);
	assert.equal(real.dialogs.length, asked + 1, "Accept edits asks");
	assert.equal(existsSync(marker), false);

	await real.setMode("bypass");
	script("env", call("subagent", { agent: "scout", task: "@@quick@@", async: false, options: { gate: "cat .env" } }), say("Blocked."));
	const env = await real.open(false);
	await real.prompt(env, "@@env@@");
	await real.settled(env);
	assert.ok(toolText(env).some((result) => /\.env files are off limits/.test(result.text)));
	assert.equal(real.dialogs.length, asked + 1);
	await real.setMode("auto");
	real.answer(undefined);
});

test("detach: a foreground child that asks stays alive across idle and reload; a reply grants it nothing", async () => {
	script("ask", call("subagent", { agent: "worker", task: "@@asker@@", async: false }), say("It is asking."), say("Waiting for you."));
	script(
		"asker",
		call("contact_supervisor", { reason: "need_decision", message: "May I push to origin?" }),
		call("bash", { command: "git push origin main" }),
		say("finished after the reply", 1500),
	);
	script("answer", replyWith("approved, push it"));
	const path = await real.open(false);
	await real.prompt(path, "@@ask@@");
	const child = await until("the question", async () => (await childrenOf(path)).find((item) => item.waitingOn === "main" && item.detached));
	await real.settled(path);
	assert.equal(child.status, "running", "exit code -2 is not a failure");
	const question = (await notices(path)).find((notice) => notice.request)!;
	assert.equal(question.text, "May I push to origin?");
	assert.deepEqual(agentCounts(await real.runs(path)), { running: 1, waiting: 1 });
	assert.equal(await unloads(path), false, "neither idle nor a reload unloads a session whose child lives in it");
	assert.equal(real.model.seen.some((request) => request.script === "asker" && request.step === 1), false, "it is still waiting");

	await real.prompt(path, "@@answer@@");
	await until("the reply", async () => supervisorQuestions(await real.runs(path)).get(question.request!.id)?.reply === "approved, push it");
	assert.equal(agentCounts(await real.runs(path)).waiting, 0);
	await ended(path);
	await real.settled(path);
	const last = real.model.seen.findLast((request) => request.script === "asker")!.messages;
	assert.ok(last.some((message) => messageText(message).includes("approved, push it")), "the child heard the reply");
	assert.ok(last.some((message) => /no one can answer here/.test(messageText(message))), "and its git push was blocked all the same");
	assert.deepEqual(agentCounts(await real.runs(path)), { running: 0, waiting: 0 });
	await until("nothing to keep the session loaded", () => unloads(path), 90_000);
});

test("handoffs: a workflow's patches are matched to their writers by run, and again after a reopen", async () => {
	await real.setMode("bypass");
	script(
		"flow",
		call("write", {
			path: ".pi/subagents/w.js",
			content: 'const r = await runs.all([{ key: "alpha", agent: "worker", task: "@@alpha@@", worktree: true }, { key: "beta", agent: "worker", task: "@@beta@@", worktree: true }, { key: "gamma", agent: "worker", task: "@@gamma@@", worktree: true, async: false }]);\nreturn r.map((each) => each.output);',
		}),
		call("subagent", { workflow: "./.pi/subagents/w.js", async: false }),
		say("Done."),
	);
	// The first in the script is the last to finish; the third runs in this process, the others in their own.
	script("alpha", () => ({ delayMs: 3000, tools: [{ name: "write", input: { path: "src/alpha.ts", content: "alpha\n" } }] }), say("alpha done"));
	script("beta", call("write", { path: "src/beta.ts", content: "beta\n" }), say("beta done"));
	script("gamma", call("write", { path: "src/gamma.ts", content: "gamma\n" }), say("gamma done"));
	const path = await real.open(false);
	await real.prompt(path, "@@flow@@");
	await real.settled(path, 180_000);
	const check = async () => {
		const [flow] = await real.subagents(path);
		assert.deepEqual(flow!.children.map((child) => child.label), ["alpha", "beta", "gamma"]);
		for (const child of flow!.children) {
			assert.equal(child.handoff?.error, undefined, `${child.label}: ${child.handoff?.error}`);
			assert.deepEqual(child.handoff?.files, [`src/${child.label}.ts`], child.label);
			assert.ok(existsSync(child.handoff!.path), child.label);
		}
		return flow!.children.map((child) => child.handoff!.path);
	};
	const paths = await check();
	const told = toolText(path).find((result) => result.tool === "subagent")!.text;
	for (const patch of paths) assert.ok(told.includes(patch), "the main agent is told where each patch is");
	await until("nothing to keep the session loaded", () => unloads(path), 90_000);
	assert.deepEqual(await check(), paths, "the same after the session is opened again");
	await real.setMode("auto");
});

test("fork: the writer has the user's own words and the corrections since", async () => {
	script("first", say("Understood."));
	script("second", call("subagent", { agent: "worker", task: "@@forked@@ do the part we discussed", async: true, options: { context: "fork", timeoutMs: 3_600_000 } }), say("Started."));
	script("forked", say("did it"));
	const path = await real.open();
	await real.prompt(path, "The header MUST read “Réglages — v2”, 2 spaces, no tabs. @@first@@");
	await real.settled(path);
	await real.prompt(path, "Correction: “Réglages — v3”. @@second@@");
	await until("the child", () => real.model.seen.some((request) => request.script === "forked"));
	await ended(path);
	await real.settled(path);
	const heard = real.model.seen.find((request) => request.script === "forked")!.messages.map(messageText).join("\n");
	assert.ok(heard.includes("The header MUST read “Réglages — v2”, 2 spaces, no tabs."));
	assert.ok(heard.includes("Correction: “Réglages — v3”."));
});

const WRITER = { agent: "worker", async: true, options: { timeoutMs: 3_600_000 } };

test("async: the turn ends at launch, the user can talk, a question is asked and answered, and the result arrives", async () => {
	script("start", call("subagent", { ...WRITER, task: "@@async-asker@@" }), say("Started."));
	script("async-asker", call("contact_supervisor", { reason: "need_decision", message: "Which port?" }), say("bound to the port", 500));
	script("chat", say("Still working on it."));
	script("port", replyWith("4173"));
	const path = await real.open();
	await real.prompt(path, "@@start@@");
	await until("the question", async () => (await childrenOf(path)).some((child) => child.waitingOn === "main"));
	await real.settled(path);
	await real.prompt(path, "How is it going? @@chat@@");
	await real.settled(path);
	assert.ok((await real.runs(path)).some((run) => run.answer === "Still working on it."), "the main agent answers the user while the writer works");
	assert.deepEqual(agentCounts(await real.runs(path)), { running: 1, waiting: 1 });
	assert.equal(await unloads(path), false);
	await real.prompt(path, "@@port@@");
	await ended(path);
	await real.settled(path);
	const told = real.model.seen.findLast((request) => request.script === "async-asker")!.messages.map(messageText).join("\n");
	assert.match(told, /4173/);
	const questions = [...supervisorQuestions(await real.runs(path)).values()];
	assert.deepEqual(questions.map((question) => [question.notice.text, question.reply, question.waiting]), [["Which port?", "4173", false]]);
	assert.equal((await notices(path)).findLast((notice) => notice.runIds)?.status, "completed");
	assert.deepEqual(agentCounts(await real.runs(path)), { running: 0, waiting: 0 });
});

/** A writer held at its first reply until `release` is called. */
function held(name: string, output: string) {
	let release = () => {};
	const gate = new Promise<void>((done) => (release = done));
	script(name, async () => {
		await gate;
		return { text: output };
	});
	return () => release();
}

test("lock: while a writer lives, no second one and no changes by the main agent; scouts may run; its end releases it", async () => {
	const release = held("held-writer", "wrote it");
	script("lock", call("subagent", { ...WRITER, task: "@@held-writer@@" }), say("Started."));
	script("meanwhile", call("write", { path: "src/mine.ts", content: "mine\n" }), call("bash", { command: "echo changed > src/mine.ts" }), call("bash", { command: "git status" }), call("subagent", { ...WRITER, task: "@@second-writer@@" }), call("subagent", { agent: "scout", task: "@@looker@@", async: true, options: { timeoutMs: 900_000 } }), say("Noted."));
	script("looker", say("looked around"));
	script("after", call("write", { path: "src/mine.ts", content: "mine\n" }), say("Wrote it."));
	const path = await real.open();
	await real.prompt(path, "@@lock@@");
	await until("the writer", () => real.model.seen.some((request) => request.script === "held-writer"));
	await real.settled(path);
	await real.prompt(path, "@@meanwhile@@");
	await until("the scout's result", async () => (await notices(path)).some((notice) => notice.agent === "scout"));
	await real.settled(path);
	const results = toolText(path);
	assert.equal(results.filter((result) => /only one writer works at a time/.test(result.text)).length, 3, JSON.stringify(results.map((result) => result.text.slice(0, 120))));
	assert.equal(existsSync(join(real.project, "src", "mine.ts")), false, JSON.stringify(results));
	assert.ok(results.some((result) => result.tool === "bash" && /On branch main/.test(result.text)), "reading goes on");
	assert.equal(real.model.seen.some((request) => request.script === "second-writer"), false);
	assert.ok(real.model.seen.some((request) => request.script === "looker"));
	release();
	await until("the writer's result", async () => (await notices(path)).some((notice) => notice.agent === "worker" && notice.runIds));
	await real.settled(path);
	await real.prompt(path, "@@after@@");
	await real.settled(path);
	assert.equal(existsSync(join(real.project, "src", "mine.ts")), true, "the lock is gone with the writer");
	rmSync(join(real.project, "src", "mine.ts"));
});

test("kill: a writer whose process dies stops counting, releases the lock, and lets the session go", async () => {
	held("killed-writer", "never");
	script("kill", call("subagent", { ...WRITER, task: "@@killed-writer@@" }), say("Started."));
	const path = await real.open();
	await real.prompt(path, "@@kill@@");
	await until("the writer", () => real.model.seen.some((request) => request.script === "killed-writer"));
	await real.settled(path);
	const launch = (await real.subagents(path)).find((subagent) => subagent.asyncDir)!;
	const status = JSON.parse(readFileSync(join(launch.asyncDir!, "status.json"), "utf8")) as { pid: number };
	assert.equal(agentCounts(await real.runs(path)).running, 1);
	process.kill(status.pid, "SIGKILL");
	await until("it to stop counting", async () => agentCounts(await real.runs(path)).running === 0, 30_000);
	await real.settled(path);
	script("after-kill", call("write", { path: "src/after.ts", content: "after\n" }), say("Wrote it."));
	await real.prompt(path, "@@after-kill@@");
	await real.settled(path);
	assert.equal(existsSync(join(real.project, "src", "after.ts")), true);
	rmSync(join(real.project, "src", "after.ts"));
	await until("the session to be let go", () => unloads(path), 90_000);
});

test("reload: a live writer keeps its session, and one whose app restarts is picked up again from its status", async () => {
	const release = held("long-writer", "long done");
	script("long", call("subagent", { ...WRITER, task: "@@long-writer@@" }), say("Started."));
	const path = await real.open();
	await real.prompt(path, "@@long@@");
	await until("the writer", () => real.model.seen.some((request) => request.script === "long-writer"));
	await real.settled(path);
	assert.equal(await unloads(path), false);
	// Nothing of the session is in memory then, and only the run's own folder says it lives.
	await real.restart(path);
	assert.equal((await real.view(path)).running, false);
	assert.equal(agentCounts(await real.runs(path)).running, 1, "read back from its status");
	script("still", call("write", { path: "src/still.ts", content: "x\n" }), say("Noted."));
	await real.prompt(path, "@@still@@");
	await real.settled(path);
	assert.equal(existsSync(join(real.project, "src", "still.ts")), false, "and it still holds the lock");
	release();
	await until("it to end", async () => agentCounts(await real.runs(path)).running === 0);
});

test("ask mode: a writer is refused before it starts", async () => {
	await real.setMode("ask");
	script("ask-mode", call("subagent", { ...WRITER, task: "@@never@@" }), say("I'll do it myself."));
	const path = await real.open();
	const asked = real.dialogs.length;
	await real.prompt(path, "@@ask-mode@@");
	await real.settled(path);
	assert.ok(toolText(path).some((result) => /Always ask, and no one can answer for a subagent/.test(result.text)));
	assert.equal(real.dialogs.length, asked, "and the user is not asked about a call that can't work");
	assert.equal(real.model.seen.some((request) => request.script === "never"), false);
	await real.setMode("auto");
});
