import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition, DefaultResourceLoader, getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type BackgroundEnd,
	COMMAND_ENDED,
	COMMAND_STOPPED,
	commandNotice,
	endedMessage,
	LONG_COMMANDS_NAME,
	LONG_COMMANDS_PATH,
	movedToBackground,
	withLongCommands,
} from "../src/main/long-commands.ts";
import { MARKER, type ProcessProbe, type ProcessRow, ServiceTracker, systemProbe } from "../src/main/services.ts";
import { noticeOf } from "../src/main/subagents.ts";
import { RunTracker } from "../src/main/transcript.ts";

function hasShell(): boolean {
	try {
		getShellConfig();
		return true;
	} catch {
		return false;
	}
}

const shell = { skip: !hasShell() && "no bash", timeout: 30_000 };

/** Reports the given rows until something kills them, and kills nothing real. */
function probe(rows: () => ProcessRow[], onKill: () => void = () => {}): ProcessProbe {
	return { list: async () => rows(), listening: async () => new Map(), kill: async () => onKill(), killSync: () => {} };
}

async function withTracker(
	options: { backgroundAfterMs?: number; backgroundLimitMs?: number; probe?: ProcessProbe },
	run: (tracker: ServiceTracker, ends: Promise<BackgroundEnd>, onBackgroundEnd: (end: BackgroundEnd) => void) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "trivium-long-"));
	const tracker = new ServiceTracker({ file: join(dir, "services.json"), emit: () => {}, probe: options.probe ?? probe(() => []), pollMs: 60_000, ...options });
	let resolve!: (end: BackgroundEnd) => void;
	const ends = new Promise<BackgroundEnd>((done) => (resolve = done));
	try {
		await run(tracker, ends, resolve);
	} finally {
		tracker.dispose();
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

test("a command past the limit returns, goes on, and reports how it ended", shell, async () => {
	await withTracker({ backgroundAfterMs: 300 }, async (tracker, ends, onBackgroundEnd) => {
		const ops = tracker.bashOperations(() => "s", { onBackgroundEnd });
		let printed = "";
		const result = await ops.exec("echo first-line; sleep 1; echo last-line; exit 3", tmpdir(), { onData: (data) => (printed += data) });
		assert.equal(result.exitCode, 0);
		assert.ok(movedToBackground(printed), printed);
		assert.ok(!printed.includes("last-line"));
		assert.equal(tracker.hasBackground("s"), true);
		const end = await ends;
		assert.equal(end.exitCode, 3);
		assert.equal(end.stopped, false);
		assert.equal(end.hitLimit, false);
		assert.match(end.output, /first-line[\s\S]*last-line/);
		assert.equal(tracker.hasBackground("s"), false);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.match(readFileSync(end.logPath, "utf8"), /first-line[\s\S]*last-line/);
	});
});

test("a command that ends in time neither logs nor reports", shell, async () => {
	await withTracker({ backgroundAfterMs: 5000 }, async (tracker) => {
		let reported = false;
		const ops = tracker.bashOperations(() => "s", { onBackgroundEnd: () => (reported = true) });
		assert.deepEqual(await ops.exec("exit 2", tmpdir(), { onData: () => {} }), { exitCode: 2 });
		assert.equal(reported, false);
		assert.equal(tracker.hasBackground("s"), false);
	});
});

test("with the extension off, a command holds its call however long it takes", shell, async () => {
	await withTracker({ backgroundAfterMs: 100 }, async (tracker) => {
		let printed = "";
		const result = await tracker.bashOperations(() => "s").exec("sleep 1; echo done; exit 7", tmpdir(), { onData: (data) => (printed += data) });
		assert.deepEqual(result, { exitCode: 7 });
		assert.match(printed, /done/);
		assert.equal(movedToBackground(printed), false);
		assert.equal(tracker.hasBackground("s"), false);
	});
});

test("with the extension off, a timeout kills the command", shell, async () => {
	await withTracker({ backgroundAfterMs: 5000 }, async (tracker) => {
		await assert.rejects(tracker.bashOperations(() => "s").exec("sleep 30", tmpdir(), { onData: () => {}, timeout: 0.5 }), /^Error: timeout:0.5$/);
	});
});

test("pi loads the extension at the path Settings turns off, and hides it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-long-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.create(dir, dir, { projectTrusted: false }),
			extensionFactories: [{ name: LONG_COMMANDS_NAME, builtin: true, factory: (pi) => pi.registerTool(createBashToolDefinition(dir)) }],
		});
		await loader.reload();
		const [extension] = loader.getExtensions().extensions.filter((entry) => entry.tools.has("bash"));
		assert.equal(extension?.path, LONG_COMMANDS_PATH);
		assert.equal(extension?.resolvedPath, LONG_COMMANDS_PATH);
		// Which is why Settings lists it by name.
		assert.equal(extension?.hidden, true);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a short timeout shortens the wait and kills nothing", shell, async () => {
	await withTracker({ backgroundAfterMs: 5000 }, async (tracker, ends, onBackgroundEnd) => {
		let printed = "";
		const started = Date.now();
		const result = await tracker.bashOperations(() => "s", { onBackgroundEnd }).exec("sleep 1; exit 6", tmpdir(), { onData: (data) => (printed += data), timeout: 0.2 });
		assert.ok(Date.now() - started < 900, "the call returned at the timeout");
		assert.equal(result.exitCode, 0);
		assert.ok(movedToBackground(printed), printed);
		const end = await ends;
		assert.equal(end.exitCode, 6, "the command ran to its end");
		assert.equal(end.hitLimit, false);
	});
});

test("a timeout of 0 means none", shell, async () => {
	await withTracker({}, async (tracker) => {
		assert.deepEqual(await tracker.bashOperations(() => "s").exec("exit 0", tmpdir(), { onData: () => {}, timeout: 0 }), { exitCode: 0 });
	});
});

test("a timeout longer than the wait doesn't hold the call up", shell, async () => {
	await withTracker({ backgroundAfterMs: 200 }, async (tracker, ends, onBackgroundEnd) => {
		const ops = tracker.bashOperations(() => "s", { onBackgroundEnd });
		let printed = "";
		// Longer than a timer can count, as a model confusing seconds and milliseconds might ask for.
		const huge = await ops.exec("sleep 1; exit 5", tmpdir(), { onData: (data) => (printed += data), timeout: 300_000_000 });
		assert.equal(huge.exitCode, 0);
		assert.ok(movedToBackground(printed), printed);
		assert.equal((await ends).exitCode, 5);
	});
});

test("Stop kills a command before it moves, and leaves it alone after", shell, async () => {
	await withTracker({ backgroundAfterMs: 2000 }, async (tracker) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		await assert.rejects(tracker.bashOperations(() => "s").exec("sleep 30", tmpdir(), { onData: () => {}, signal: controller.signal }), /aborted/);
	});
	await withTracker({ backgroundAfterMs: 200 }, async (tracker, ends, onBackgroundEnd) => {
		const controller = new AbortController();
		await tracker.bashOperations(() => "s", { onBackgroundEnd }).exec("sleep 1; exit 4", tmpdir(), { onData: () => {}, signal: controller.signal });
		controller.abort();
		assert.equal((await ends).exitCode, 4);
	});
});

test("a command that runs too long is ended", shell, async () => {
	await withTracker({ backgroundAfterMs: 100, backgroundLimitMs: 500 }, async (tracker, ends, onBackgroundEnd) => {
		await tracker.bashOperations(() => "s", { onBackgroundEnd }).exec("sleep 30", tmpdir(), { onData: () => {} });
		const end = await ends;
		assert.equal(end.hitLimit, true);
		assert.equal(endedMessage(end).message.details.status, "stopped");
	});
});

test("a command the user stops says so, and doesn't start a run", shell, async () => {
	let rows: ProcessRow[] = [];
	const stopping = probe(
		() => rows,
		() => (rows = []),
	);
	await withTracker({ backgroundAfterMs: 200, probe: stopping }, async (tracker, ends, onBackgroundEnd) => {
		let printed = "";
		await tracker.bashOperations(() => "s", { onBackgroundEnd }).exec(`echo id=$${MARKER}; sleep 1`, tmpdir(), {
			onData: (data) => {
				printed += data;
				const id = /id=(\w+)/.exec(printed)?.[1];
				if (id) rows = [{ pid: 999_999, ppid: 1, name: "sleep", marker: id }];
			},
		});
		await tracker.refresh();
		const [service] = tracker.list().s!;
		await tracker.stop(service!.id);
		const end = await ends;
		assert.equal(end.stopped, true);
		const { message, options } = endedMessage(end);
		assert.equal(message.customType, COMMAND_STOPPED);
		assert.deepEqual(options, { deliverAs: "nextTurn" });
		assert.equal(noticeOf({ role: "custom", ...message }), undefined);
	});
});

test("a real command in the background shows as a service, and stopping it there ends it", shell, async () => {
	await withTracker({ backgroundAfterMs: 200, probe: systemProbe }, async (tracker, ends, onBackgroundEnd) => {
		await tracker.bashOperations(() => "real", { onBackgroundEnd }).exec("sleep 60; echo done", tmpdir(), { onData: () => {} });
		await tracker.refresh();
		// The shell stays, with the program it is waiting on: one command, one service.
		const services = tracker.list().real ?? [];
		assert.equal(services.length, 1, JSON.stringify(services));
		assert.equal(tracker.count(), 1);
		const [service] = services;
		assert.equal(service!.command, "sleep 60; echo done");
		await tracker.stop(service!.id);
		const end = await ends;
		assert.equal(end.stopped, true);
		assert.equal(tracker.count(), 0);
		assert.equal(tracker.hasBackground("real"), false);
	});
});

const end: BackgroundEnd = { command: "npm test, then lint", exitCode: 1, durationMs: 843_000, logPath: "/logs/a.log", output: "1 failing\n", stopped: false, hitLimit: false };

test("a command's end wakes the session with what it needs", () => {
	const { message, options } = endedMessage(end);
	assert.equal(message.customType, COMMAND_ENDED);
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(message.content, /^Background command exited with code 1 after 14m 3s: npm test, then lint\nFull output: \/logs\/a\.log\n\nLast output:\n1 failing$/);
	assert.deepEqual(commandNotice({ role: "custom", ...message }), { agent: "", command: "npm test, then lint", status: "failed", durationMs: 843_000, text: "1 failing" });
	assert.equal(endedMessage({ ...end, exitCode: 0 }).message.details.status, "completed");
	assert.equal(commandNotice({ role: "custom", customType: "other" }), undefined);
});

test("pi's bash tool tells the model how long commands go", () => {
	const plain = createBashToolDefinition(tmpdir());
	const tool = withLongCommands(plain);
	const { timeout, command } = (tool.parameters as unknown as { properties: Record<string, { description: string }> }).properties;
	assert.match(timeout!.description, /does not kill/);
	assert.doesNotMatch(timeout!.description, /no default/);
	assert.equal(command!.description, "Shell command to execute");
	assert.ok(tool.promptGuidelines!.length > (plain.promptGuidelines?.length ?? 0));
	assert.equal(tool.execute, plain.execute);
});

test("the transcript says when a command timed out or moved to the background", () => {
	const metaFor = (text: string, isError: boolean) => {
		const tracker = new RunTracker([]);
		const apply = (event: unknown) => tracker.apply(event as Parameters<RunTracker["apply"]>[0]);
		apply({ type: "message_start", message: { role: "user", content: "go" } });
		apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } }] } });
		apply({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "npm test" } });
		apply({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", isError, result: { content: [{ type: "text", text }] }, durationMs: 1 });
		return tracker.all().at(-1)!.steps[0]!.meta;
	};
	assert.equal(metaFor("partial\n\nCommand timed out after 5 seconds", true), "timed out");
	assert.equal(metaFor("partial\n\nCommand exited with code 2", true), "exit 2");
	assert.equal(metaFor("partial\n\n[Still running after 10m 0s, so this command moved to the background", false), "in background");
	assert.equal(metaFor("done", false), "exit 0");
});
