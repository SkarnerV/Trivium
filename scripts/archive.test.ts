import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsStore } from "../src/main/settings.ts";

const home = mkdtempSync(join(tmpdir(), "trivium-archive-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
process.env.TRIVIUM_HOME = join(home, "trivium");
mkdirSync(process.env.TRIVIUM_HOME, { recursive: true });

// Reads the agent folder and Trivium's home when it loads, so it comes after they are set.
const { SessionHost } = await import("../src/main/host.ts");

function writeSession(id: string): string {
	const dir = join(home, "agent", "sessions", "--project--");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.jsonl`);
	const timestamp = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id, timestamp, cwd: join(home, "project") },
		{ type: "message", id: `${id}-1`, parentId: null, timestamp, message: { role: "user", content: `Hello from ${id}`, timestamp: Date.now() } },
	];
	writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

function hostFor(settings: SettingsStore) {
	return new SessionHost({
		emit: () => {},
		broker: { cancelAll: () => {} } as never,
		indexFile: join(home, "trivium", "session-apps.json"),
		settings,
		onDone: () => {},
		services: { stopSession: async () => {} } as never,
	});
}

const archivedIn = async (host: InstanceType<typeof SessionHost>) =>
	(await host.listSessions())
		.filter((session) => session.archived)
		.map((session) => session.id)
		.sort();

test.after(() => rmSync(home, { recursive: true, force: true }));

test("an archived session stays archived after a restart, until restored or deleted", async () => {
	const kept = writeSession("kept");
	const gone = writeSession("gone");
	writeSession("other");
	const file = join(home, "trivium", "settings.json");
	const host = hostFor(new SettingsStore(file));
	await host.listSessions();

	assert.deepEqual((await host.archiveSessions([kept, gone], true)).sort(), [gone, kept].sort());
	assert.deepEqual(await archivedIn(host), ["gone", "kept"]);

	const restarted = hostFor(new SettingsStore(file));
	assert.deepEqual(await archivedIn(restarted), ["gone", "kept"]);

	await restarted.archiveSessions([kept], false);
	assert.deepEqual(await archivedIn(restarted), ["gone"]);

	const trashed: string[] = [];
	await restarted.deleteSessions([gone], async (path) => {
		trashed.push(path);
		rmSync(path);
	});
	assert.deepEqual(trashed, [gone]);
	assert.deepEqual(await archivedIn(restarted), []);
	assert.deepEqual(new SettingsStore(file).get().archivedSessions, []);
});

test("a settings file from before archiving reads as nothing archived", () => {
	const file = join(home, "trivium", "old-settings.json");
	writeFileSync(file, JSON.stringify({ language: "system" }));
	assert.deepEqual(new SettingsStore(file).get().archivedSessions, []);
});
