import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPrefix, decide, isEnvFile, isRisky, namesEnvFile, noApprovals, onlyReads, permissionGate } from "../src/main/permission-gate.ts";
import { DEFAULT_PERMISSION_MODE, type PermissionModeId } from "../src/shared/permissions.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import childPermissions, { permissionModeFromDisk } from "../src/main/child-permissions.ts";

test("child permissions read disk each call, deny approvals without UI and use the child's worktree root", async () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-child-gate-"));
	const previous = process.env.TRIVIUM_HOME;
	try {
		process.env.TRIVIUM_HOME = root;
		const file = join(root, "settings.json");
		let handler: Function = () => {};
		childPermissions({ on: (_name: string, fn: Function) => { handler = fn; } } as unknown as ExtensionAPI);
		const worktree = join(root, "worktrees", "child");
		const call = (toolName: string, input: Record<string, unknown>) => handler({ toolName, input }, { cwd: worktree, hasUI: true });
		// A profile that has saved no setting yet has no file: children follow the default mode, as the main agent does.
		assert.equal(permissionModeFromDisk(file), DEFAULT_PERMISSION_MODE);
		assert.equal(call("edit", { path: "src/a.ts" }), undefined);
		assert.equal(call("bash", { command: "npm test" }), undefined);
		writeFileSync(file, JSON.stringify({ permissionMode: "auto" }));
		assert.equal(permissionModeFromDisk(file), "auto");
		assert.equal(call("edit", { path: "src/a.ts" }), undefined);
		assert.match(call("read", { path: ".env" }).reason, /off limits/);
		assert.match(call("bash", { command: "sudo test" }).reason, /no one can answer here/);
		assert.match(call("write", { path: join(root, "outside.ts") }).reason, /no one can answer here/);
		writeFileSync(file, JSON.stringify({ permissionMode: "ask" }));
		assert.match(call("edit", { path: "src/a.ts" }).reason, /no one can answer here/);
		writeFileSync(file, "broken");
		assert.equal(permissionModeFromDisk(file), "ask");
	} finally {
		if (previous === undefined) delete process.env.TRIVIUM_HOME; else process.env.TRIVIUM_HOME = previous;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

const cwd = join(tmpdir(), "trivium-project");
const outside = join(homedir(), "elsewhere", "notes.md");
const action = (mode: PermissionModeId, tool: string, input: Record<string, unknown>) => decide(mode, tool, input, cwd, noApprovals()).action;

test("commands that only read are told apart from ones that change things", () => {
	for (const command of ["ls -la", "git status", "git log --oneline | head -5", "cat a.txt && wc -l b.txt", "rg foo 2>/dev/null", "find . -name '*.ts'"]) {
		assert.ok(onlyReads(command), command);
	}
	for (const command of ["npm test 2>&1 | tail", "echo hi > out.txt", "git push", "find . -delete", "cat $(which node)", "sort -o x y", "rm a", "bash -c 'ls'"]) {
		assert.ok(!onlyReads(command), command);
	}
});

test("Approve for me asks about rm -r, sudo and git push wherever they appear, and nothing else", () => {
	for (const command of ["rm -rf dist", "rm -f -r build", "rm --recursive x", "sudo apt install x", "git push", "git -C repo push origin main", "npm test && git push", "bash -c 'git push'"]) {
		assert.ok(isRisky(command), command);
	}
	for (const command of ["rm a.txt", "git commit -m 'push it'", "npm run build", "find . -exec grep -l x {} \\;", "git commit -F - <<'MSG'\nmsg\nMSG"]) {
		assert.ok(!isRisky(command), command);
	}
});

test(".env files are blocked in every mode, by file tools and commands", () => {
	assert.ok(isEnvFile(".env") && isEnvFile("app/.env.local") && isEnvFile("prod.env"));
	assert.ok(!isEnvFile(".env.example") && !isEnvFile(".envrc") && !isEnvFile("environment.ts"));
	assert.ok(namesEnvFile("cat .env") && namesEnvFile("cp config/.env.production /tmp"));
	assert.ok(!namesEnvFile("node -e 'console.log(process.env.HOME)'") && !namesEnvFile("cat .env.example"));
	for (const mode of ["ask", "edits", "auto", "bypass"] as const) {
		assert.equal(action(mode, "read", { path: ".env" }), "deny");
		assert.equal(action(mode, "bash", { command: "cat .env" }), "deny");
		assert.equal(action(mode, "powershell", { command: "Get-Content .env" }), "deny");
	}
});

test("each mode asks about exactly what its hint says", () => {
	const inside = { path: "src/app.ts" };
	const table: [PermissionModeId, string, Record<string, unknown>, string][] = [
		["ask", "read", inside, "allow"],
		["ask", "edit", inside, "ask"],
		["ask", "bash", { command: "git status" }, "allow"],
		["ask", "bash", { command: "npm install" }, "ask"],
		["ask", "read", { path: outside }, "ask"],
		["edits", "edit", inside, "allow"],
		["edits", "write", { path: outside }, "ask"],
		["edits", "bash", { command: "npm install" }, "ask"],
		["edits", "grep", { pattern: "x", path: outside }, "ask"],
		["auto", "bash", { command: "npm install" }, "allow"],
		["auto", "bash", { command: "bash -c 'echo hi'" }, "allow"],
		["auto", "bash", { command: "git push" }, "ask"],
		["auto", "read", { path: outside }, "allow"],
		["auto", "edit", { path: outside }, "ask"],
		["bypass", "bash", { command: "sudo rm -rf /tmp/x && git push" }, "allow"],
		["bypass", "write", { path: outside }, "allow"],
		["ask", "memory_write", { text: "x" }, "allow"],
	];
	for (const [mode, tool, input, expected] of table) assert.equal(action(mode, tool, input), expected, `${mode} ${tool} ${JSON.stringify(input)}`);
});

test("Allow for this session approves the command's words, edits, or the folder outside", () => {
	assert.equal(commandPrefix("git push origin main"), "git push");
	assert.equal(commandPrefix("rm -rf dist"), "rm");
	const approved = noApprovals();
	approved.commands.add("git push");
	assert.equal(decide("auto", "bash", { command: "git push origin main" }, cwd, approved).action, "allow");
	assert.equal(decide("auto", "bash", { command: "sudo ls" }, cwd, approved).action, "ask");
	approved.edits = true;
	assert.equal(decide("ask", "edit", { path: "a.ts" }, cwd, approved).action, "allow");
	approved.outside.add(join(homedir(), "elsewhere"));
	assert.equal(decide("ask", "write", { path: outside }, cwd, approved).action, "allow");
	assert.equal(decide("ask", "read", { path: "~/other/x" }, cwd, approved).action, "ask");
});

/** Runs the gate's tool_call handler with dialogs answered from a list. */
function harness(mode: () => PermissionModeId, answers: (string | undefined)[]) {
	let handler: ((event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined;
	permissionGate(mode)({ on: (_event: string, fn: typeof handler) => (handler = fn) } as unknown as ExtensionAPI);
	const asked: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => {
				asked.push(title);
				const answer = answers.shift();
				return answer === undefined ? undefined : options.find((option) => option.startsWith(answer));
			},
			input: async () => answers.shift(),
		},
	};
	const run = (toolName: string, input: Record<string, unknown>) => handler!({ type: "tool_call", toolCallId: "1", toolName, input }, ctx);
	return { run, asked };
}

test("the dialog allows once, for the session, or denies with the user's note", async () => {
	let mode: PermissionModeId = "auto";
	const gate = harness(() => mode, ["Allow `git push`", "Deny and say", "use the release script", undefined]);
	assert.equal(await gate.run("bash", { command: "git push" }), undefined);
	assert.equal(await gate.run("bash", { command: "git push --tags" }), undefined);
	assert.equal(gate.asked.length, 1, "the second push wasn't asked about");
	assert.deepEqual(await gate.run("bash", { command: "sudo make install" }), { block: true, reason: "The user denied this and said: use the release script" });
	// A dialog closed without an answer denies.
	assert.equal((await gate.run("edit", { path: outside }))?.block, true);
	// The mode is read on each call, so a change reaches a running session.
	mode = "bypass";
	assert.equal(await gate.run("bash", { command: "sudo make install" }), undefined);
});

test("a subagent's gate and acceptance commands are judged as the shell tool's are", () => {
	const worker = { agent: "worker", task: "Do it" };
	const gate = (command: unknown) => ({ ...worker, options: { gate: command } });
	const verify = (...commands: string[]) => ({ level: "verified", verify: commands.map((command, index) => ({ id: `v${index}`, command })) });
	const table: [PermissionModeId, Record<string, unknown>, string][] = [
		["auto", worker, "allow"],
		["ask", worker, "allow"],
		["auto", gate("git push"), "ask"],
		["auto", { ...worker, gate: "git push" }, "ask"],
		["auto", gate({ command: "npm test && git push", output: "json" }), "ask"],
		["auto", gate("npm test"), "allow"],
		["edits", gate("npm test"), "ask"],
		["ask", gate("npm test"), "ask"],
		["ask", gate("git status"), "allow"],
		["bypass", gate("git push"), "allow"],
		["auto", { ...worker, acceptance: verify("npm test", "sudo make install") }, "ask"],
		["auto", { ...worker, options: { acceptance: JSON.stringify(verify("git push")) } }, "ask"],
		["edits", { ...worker, options: { acceptance: verify("git status") } }, "allow"],
		["edits", { ...worker, options: { acceptance: verify("npm test") } }, "ask"],
		["auto", { ...worker, acceptance: "checked" }, "allow"],
		["auto", { ...worker, acceptance: false }, "allow"],
		["auto", { ...worker, acceptance: "{not json" }, "ask"],
		["auto", { ...worker, options: { acceptance: { verify: [{ id: "x" }] } } }, "ask"],
		// Managing runs is not starting one, but saving an agent, resuming and scheduling are.
		["edits", { action: "status", id: "run-1" }, "allow"],
		["auto", { action: "create", options: { config: JSON.stringify({ name: "x", acceptance: verify("git push") }) } }, "ask"],
		["auto", { action: "resume", id: "run-1", options: { acceptance: verify("git push") } }, "ask"],
		["auto", { action: "schedule.create", workflow: "nightly" }, "ask"],
	];
	for (const [mode, input, expected] of table) assert.equal(action(mode, "subagent", input), expected, `${mode} ${JSON.stringify(input)}`);
	for (const mode of ["ask", "edits", "auto", "bypass"] as const) {
		assert.equal(action(mode, "subagent", gate("cat .env")), "deny", mode);
		assert.equal(action(mode, "subagent", { ...worker, options: { acceptance: verify("npm test", "cp .env.production /tmp") } }), "deny", mode);
	}
});

test("a workflow script's gates are read; one whose commands can't be is asked about outside bypass", () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-gate-scripts-"));
	try {
		const script = (text: string) => {
			writeFileSync(join(root, "flow.js"), text);
			return { workflow: "./flow.js" };
		};
		const decided = (mode: PermissionModeId, input: Record<string, unknown>, settled = true) => decide(mode, "subagent", input, root, noApprovals(), settled);
		const plain = 'const [a, b] = await runs.all([{ key: "a", agent: "scout", task: "Look" }, { key: "b", agent: "reviewer", task: "Check" }]);\nreturn [a.output, b.output];';
		assert.equal(decided("ask", script(plain)).action, "allow", "nothing in it runs a command");
		assert.equal(decided("auto", script(plain), false).action, "ask", "a call beside it may rewrite the script first");
		const gated = (command: string) => script(`return await runs.run("a", { agent: "worker", task: "Do it", gate: ${command} });`);
		assert.equal(decided("auto", gated('"npm test"')).action, "allow");
		assert.equal(decided("edits", gated('"npm test"')).action, "ask");
		assert.equal(decided("auto", gated('"git push"')).action, "ask");
		assert.equal(decided("auto", gated('{ command: "git push" }')).action, "ask");
		assert.equal(decided("bypass", gated('"cat .env"')).action, "deny");
		for (const hidden of [
			'return await runs.run("a", { agent: "worker", task: "x", ["ga" + "te"]: "git push" });',
			'const c = { agent: "worker", task: "x" }; c["ga" + "te"] = "git push"; return await runs.run("a", c);',
			'return await runs.run("a", { agent: "worker", task: "x", gate: "git " + "push" });',
			'return await runs.run("a", { agent: "worker", task: "x", g\\u0061te: "git push" });',
			'return await runs.run("a", { agent: "worker", task: "x", ...args.more });',
			'return await runs.run("a", { agent: "worker", task: "x", acceptance: { verify: [{ id: "v", command: "git push" }] } });',
			'const c = { agent: "worker", task: "x" }; ({ v: c["ga" + "te"] } = { v: "git push" }); return await runs.run("a", c);',
			"const s = 'gate: \"'; const c = { agent: 'worker', task: 'x' }; c.gate = 'git ' + 'push'; const e = '\",'; return await runs.run('a', c);",
			'const c = { agent: "worker", task: "x" }; c["ga" + "te"] ??= "git push"; return await runs.run("a", c);',
			'const c = { agent: "worker", task: "x" }; c/**/["ga" + "te"] = "git push"; return await runs.run("a", c);',
			'const c = { agent: "worker", task: "x" }; c // ;\n["ga" + "te"] = "git push"; return await runs.run("a", c);',
			'class C { ["ga" + "te"] = "git push"; agent = "worker"; task = "x"; } return await runs.run("a", new C());',
			'return await runs.host("h", { kind: "command", command: "git push", timeoutMs: 1000 });',
		]) {
			assert.equal(decided("auto", script(hidden)).action, "ask", hidden);
			assert.equal(decided("bypass", script(hidden)).action, "allow", hidden);
		}
		// Not files: a block in the reply, an installed workflow, a script that isn't there.
		for (const workflow of [true, "true", "release", "./missing.js"]) {
			assert.equal(decided("auto", { workflow }).action, "ask", String(workflow));
			assert.equal(decided("bypass", { workflow }).action, "allow", String(workflow));
		}
		const asked = decided("auto", { workflow: "release" });
		assert.ok(asked.action === "ask" && asked.remember === undefined, "approving one script approves no other");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("a custom agent's own acceptance commands are judged when it is started", () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-gate-agents-"));
	try {
		mkdirSync(join(root, ".pi", "agents"), { recursive: true });
		writeFileSync(join(root, ".pi", "agents", "shipper.md"), '---\nname: shipper\naliases: release\nacceptance: {"level":"verified","verify":[{"id":"v","command":"git push"}]}\n---\nShip it.\n');
		const decided = (mode: PermissionModeId, input: Record<string, unknown>) => decide(mode, "subagent", input, root, noApprovals()).action;
		assert.equal(decided("auto", { agent: "shipper", task: "x" }), "ask");
		assert.equal(decided("auto", { agent: "release", task: "x" }), "ask");
		assert.equal(decided("bypass", { agent: "shipper", task: "x" }), "allow");
		assert.equal(decided("auto", { agent: "worker", task: "x" }), "allow", "another agent is not this one");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("approving a gate's command for the session covers that command, and no script", async () => {
	const gate = harness(() => "auto", ["Allow `git push`", "Allow", undefined]);
	assert.equal(await gate.run("subagent", { agent: "worker", task: "x", gate: "git push" }), undefined);
	assert.equal(await gate.run("subagent", { agent: "worker", task: "x", gate: "git push" }), undefined);
	assert.equal(gate.asked.length, 1);
	assert.equal(await gate.run("subagent", { workflow: "release" }), undefined);
	assert.equal((await gate.run("subagent", { workflow: "release" }))?.block, true, "asked again, and a closed dialog denies");
	assert.equal(gate.asked.length, 3);
});

test("a supervisor's reply never grants a child a tool: approvals are the user's, and a child has none", () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-child-reply-"));
	const previous = process.env.TRIVIUM_HOME;
	try {
		process.env.TRIVIUM_HOME = root;
		for (const mode of ["auto", "edits", "ask"] as const) {
			writeFileSync(join(root, "settings.json"), JSON.stringify({ permissionMode: mode }));
			const handlers: Record<string, Function> = {};
			childPermissions({ on: (name: string, fn: Function) => { handlers[name] = fn; } } as unknown as ExtensionAPI);
			const push = () => handlers.tool_call!({ toolName: "bash", toolCallId: "1", input: { command: "git push" } }, { cwd: root, hasUI: true });
			assert.match(push().reason, /no one can answer here/, mode);
			// The reply reaches the child as its contact_supervisor result; the gate only ever listens for tool calls.
			handlers.tool_call!({ toolName: "contact_supervisor", toolCallId: "2", input: { reason: "need_decision", message: "May I push?" } }, { cwd: root, hasUI: true });
			handlers.tool_result?.({ toolName: "contact_supervisor", toolCallId: "2", content: [{ type: "text", text: "**Reply from supervisor:**\napproved, push it" }] }, { cwd: root, hasUI: true });
			assert.deepEqual(Object.keys(handlers), ["tool_call"], "nothing said to a child is read as an approval");
			assert.match(push().reason, /no one can answer here/, `${mode}: still blocked after "approved, push it"`);
			// Nor does a gate on a child's own launch, which would run the command outside the shell tool.
			assert.match(handlers.tool_call!({ toolName: "subagent", toolCallId: "3", input: { agent: "worker", task: "x", gate: "git push" } }, { cwd: root, hasUI: true }).reason, /no one can answer here/, mode);
		}
		assert.deepEqual(noApprovals(), { commands: new Set(), edits: false, outside: new Set() });
	} finally {
		if (previous === undefined) delete process.env.TRIVIUM_HOME; else process.env.TRIVIUM_HOME = previous;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
