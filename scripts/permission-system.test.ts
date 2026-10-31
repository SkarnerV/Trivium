import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { packageDir, writePermissionLevel } from "../src/main/builtin-packages.ts";

// Commands pi-permission-system asks about whatever the policy allows: an inline shell, an exec wrapper, and a heredoc
// commit its parser can't read.
const FLOORED = ["bash -c 'echo hi'", "find . -name '*.tmp' -exec rm {} \\;", "git commit -F - <<'MSG' 2>&1 | tail -4\nmsg\nMSG"];

/** Runs the shipped extension headless against a config Trivium wrote, and answers what each bash call does. */
async function permissionSystem(agentDir: string, cwd: string) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const result = await loadExtensions([join(packageDir("@gotgenes/pi-permission-system")!, "src", "index.ts")], cwd);
	assert.deepEqual(result.errors, []);
	Object.assign(result.runtime, {
		getAllTools: () => [{ name: "bash", description: "", parameters: {} }],
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	});
	const handlers = result.extensions[0]!.handlers;
	// With no UI an ask blocks, naming the approval it needed.
	const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} }, isProjectTrusted: () => true, sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "" };
	const emit = async (type: string, event: object) => {
		for (const handler of handlers.get(type) ?? []) {
			const answer = (await handler({ type, ...event }, ctx as never)) as { block?: boolean; reason?: string } | undefined;
			if (answer?.block) return answer.reason;
		}
	};
	await emit("session_start", { reason: "startup" });
	return {
		turn: () => emit("before_agent_start", { prompt: "go", systemPrompt: "" }),
		bash: async (command: string) => {
			const reason = await emit("tool_call", { toolName: "bash", toolCallId: "1", input: { command } });
			return !reason ? "allow" : /requires approval/.test(reason) ? "ask" : "deny";
		},
		shutdown: () => emit("session_shutdown", {}),
	};
}

test("bypass runs every command without asking, in new sessions and ones already running", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trivium-perm-"));
	const cwd = mkdtempSync(join(tmpdir(), "trivium-proj-"));
	try {
		await writePermissionLevel(agentDir, "auto");
		const running = await permissionSystem(agentDir, cwd);
		await running.turn();
		for (const command of FLOORED) assert.equal(await running.bash(command), "ask", `auto asks for ${command}`);
		await writePermissionLevel(agentDir, "bypass");
		await running.turn();
		for (const command of FLOORED) assert.equal(await running.bash(command), "allow", `bypass runs ${command}`);
		assert.equal(await running.bash("cat .env"), "deny");
		await running.shutdown();

		const fresh = await permissionSystem(agentDir, cwd);
		await fresh.turn();
		for (const command of FLOORED) assert.equal(await fresh.bash(command), "allow", `bypass runs ${command}`);
		await fresh.shutdown();
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});
