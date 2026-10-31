import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPrefix, decide, isEnvFile, isRisky, namesEnvFile, noApprovals, onlyReads, permissionGate } from "../src/main/permission-gate.ts";
import type { PermissionModeId } from "../src/shared/permissions.ts";

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
