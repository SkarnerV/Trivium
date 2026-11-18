import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWithChildGate, CHILD_GATE_ID } from "../src/main/session-binding.ts";
import { WorkModeIndex } from "../src/main/work-modes.ts";
import type { AppId } from "../src/shared/protocol.ts";

/** The host's work-mode steps, in the order SessionHost takes them, on a real index file. */
test("a new session takes the setting, a fork inherits, an unsaved session keeps its mode, deleting removes it", async () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-wiring-"));
	try {
		const file = join(root, "session-work-modes.json");
		const modes = new WorkModeIndex(file);
		// newSession: Settings → Code says Orchestrator.
		await modes.created("code-project", "code", true, "orchestrator");
		await modes.created("code-chat", "code", false, "orchestrator");
		await modes.created("research", "research", true, "orchestrator");
		await modes.created("bad-setting", "code", true, "turbo");
		assert.equal(modes.get("code-project"), "orchestrator");
		assert.equal(modes.get("code-chat"), "default", "a chat has no project to split work over");
		assert.equal(modes.get("research"), "default");
		assert.equal(modes.get("bad-setting"), "default");
		// fork: the new session works as its source does, and changing one later leaves the other.
		await modes.forked("code-project", "fork");
		assert.equal(new WorkModeIndex(file).get("fork"), "orchestrator");
		await modes.set("fork", "default");
		assert.equal(modes.get("code-project"), "orchestrator");
		// unload before the first message, then open again under the id pi gives the reopened session.
		const kept = modes.unsaved("code-project", "code");
		assert.equal(modes.unsaved("research", "research"), undefined);
		await modes.reopened("reopened-id", kept);
		assert.equal(new WorkModeIndex(file).get("reopened-id"), "orchestrator");
		await modes.reopened("other", undefined);
		assert.equal(modes.get("other"), "default");
		// deleteSessions
		await modes.delete("reopened-id");
		assert.equal(new WorkModeIndex(file).get("reopened-id"), "default");
		assert.equal(new WorkModeIndex(file).get("code-project"), "orchestrator", "deleting one leaves the others");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function binder() {
	const registered: { sessionId: string; extensions: { id: string; path: string }[]; requireForAllRunners?: boolean }[] = [];
	let released = 0;
	const register = ((input: (typeof registered)[number]) => {
		registered.push(input);
		return { dispose: () => released++ };
	}) as unknown as Parameters<typeof bindWithChildGate>[0]["register"];
	return { registered, released: () => released, register };
}

test("a Code session requires the child permission gate, for native children only; Research and Write register nothing", async () => {
	const code = binder();
	let bound = false;
	const release = await bindWithChildGate({
		app: "code",
		sessionId: "s1",
		gatePath: "/app/dist/child-permissions.mjs",
		register: code.register,
		bind: async () => {
			// session_start may revive detached children: the gate must already be required when extensions bind.
			assert.equal(code.registered.length, 1);
			bound = true;
		},
		undo: () => assert.fail("nothing to undo"),
	});
	assert.equal(bound, true);
	assert.deepEqual(code.registered, [{ sessionId: "s1", extensions: [{ id: CHILD_GATE_ID, path: "/app/dist/child-permissions.mjs" }] }]);
	assert.equal(code.registered[0]!.requireForAllRunners, undefined, "external CLI agents must keep launching");
	release();
	assert.equal(code.released(), 1);
	for (const app of ["research", "write"] as AppId[]) {
		const other = binder();
		const done = await bindWithChildGate({ app, sessionId: "s2", gatePath: "/x", register: other.register, bind: async () => {}, undo: () => {} });
		assert.equal(other.registered.length, 0, app);
		done();
	}
});

test("a failure to register or to bind leaves no half-built session and no registration behind", async () => {
	const failing = binder();
	let undone = 0;
	let bound = false;
	await assert.rejects(
		bindWithChildGate({
			app: "code",
			sessionId: "s1",
			gatePath: "/missing.mjs",
			register: (() => {
				throw new Error("Required child extension file does not exist");
			}) as unknown as typeof failing.register,
			bind: async () => {
				bound = true;
			},
			undo: () => undone++,
		}),
		/does not exist/,
	);
	assert.equal(bound, false, "nothing binds without the gate");
	assert.equal(undone, 1);
	const bindFails = binder();
	await assert.rejects(
		bindWithChildGate({
			app: "code",
			sessionId: "s1",
			gatePath: "/gate.mjs",
			register: bindFails.register,
			bind: async () => {
				throw new Error("extension failed");
			},
			undo: () => undone++,
		}),
		/extension failed/,
	);
	assert.equal(bindFails.released(), 1, "the registration is released");
	assert.equal(undone, 2);
});
