import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Lesson, localDate, MemoryStore, parseEntries } from "../src/main/memory.ts";

/** A store over a temporary agent folder and one project, with a secret gate that knows one key shape. */
function setup() {
	const root = mkdtempSync(join(tmpdir(), "trivium-memory-"));
	const agentDir = join(root, "agent");
	const project = join(root, "acme");
	mkdirSync(join(agentDir, "memory", "daily"), { recursive: true });
	mkdirSync(join(project, ".pi", "memory"), { recursive: true });
	const rules = {
		secrets: (text: string) => (/sk-[a-z0-9]{20,}/i.test(text) ? [{ label: "OpenAI API key", preview: "sk-abcde…" }] : []),
		recall: (lessons: Lesson[]) => lessons.filter((lesson) => lesson.category === "failure" || lesson.category === "correction"),
	};
	const store = new MemoryStore(agentDir, rules, async () => [project], {});
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	return { root, agentDir, project, store, cleanup, globalFile: join(agentDir, "memory", "MEMORY.md"), projectFile: join(project, ".pi", "memory", "MEMORY.md") };
}

test("entries are bullets, with pify's category and time, and those past the limit don't load", () => {
	const content = "# Long-term memory\n\n- [failure] npm ci fails behind the proxy\n- 14:05 [tool-quirk] seed with --reset\n- [unknown] kept as text\n- " + "x".repeat(40);
	// The third entry ends at character 124; the fourth runs past the limit.
	const { chars, entries } = parseEntries(content, 125);
	assert.equal(chars, content.length);
	assert.deepEqual(
		entries.map(({ line, category, text, time }) => ({ line, category, text: text.slice(0, 12), time })),
		[
			{ line: 2, category: "failure", text: "npm ci fails", time: undefined },
			{ line: 3, category: "tool-quirk", text: "seed with --", time: "14:05" },
			{ line: 4, category: undefined, text: "[unknown] ke", time: undefined },
			{ line: 5, category: undefined, text: "xxxxxxxxxxxx", time: undefined },
		],
	);
	assert.deepEqual(entries.map((entry) => entry.loaded), [true, true, true, false]);
});

test("adding writes pify's header and one line, and refuses a credential", async () => {
	const { store, globalFile, project, projectFile, cleanup } = setup();
	try {
		assert.deepEqual(await store.add({ kind: "global" }, "preference", "Short\nanswers"), {});
		assert.deepEqual(await store.add({ kind: "global" }, undefined, "Use pnpm"), {});
		assert.equal(readFileSync(globalFile, "utf8"), "# Long-term memory\n\n- [preference] Short answers\n- Use pnpm\n");
		const refused = await store.add({ kind: "project", cwd: project }, "convention", "Key sk-abcdefghijklmnopqrstuvwxyz");
		assert.match(refused.error ?? "", /credential \(OpenAI API key, sk-abcde…\)/);
		assert.throws(() => readFileSync(projectFile, "utf8"));
		await assert.rejects(store.add({ kind: "project", cwd: join(project, "..", "elsewhere") }, undefined, "x"), /no sessions in that folder/);
	} finally {
		cleanup();
	}
});

test("deleting keeps a recovery record pify can read, and Undo puts the entry back in place", async () => {
	const { store, globalFile, agentDir, cleanup } = setup();
	try {
		writeFileSync(globalFile, "# Memory\n\n<!-- 2026-10-26 12:23:09 [01a17672] -->\n- First\n- [failure] Second\n- Third\n");
		const [first, second] = (await store.file({ kind: "global" })).entries;
		const id = await store.delete({ kind: "global" }, first!);
		// The pi-memory stamp above the entry goes with it.
		assert.equal(readFileSync(globalFile, "utf8"), "# Memory\n\n- [failure] Second\n- Third\n");
		const record = JSON.parse(readFileSync(join(agentDir, "memory", "recovery", `${id}.json`), "utf8"));
		assert.deepEqual(record.removals, [
			{ file: globalFile, text: "<!-- 2026-10-26 12:23:09 [01a17672] -->" },
			{ file: globalFile, text: "- First" },
		]);
		assert.deepEqual(store.deleted().map((deletion) => deletion.items), [[{ where: "Everywhere", category: undefined, text: "First" }]]);
		// A page that read the file before the delete still finds Second where it moved to.
		await store.delete({ kind: "global" }, second!);
		assert.equal(readFileSync(globalFile, "utf8"), "# Memory\n\n- Third\n");
		store.restore(id);
		assert.equal(readFileSync(globalFile, "utf8"), "# Memory\n\n<!-- 2026-10-26 12:23:09 [01a17672] -->\n- First\n- Third\n");
		assert.equal(store.deleted().length, 1);
		// A record pify's memory_forget wrote has no position; its lines go back at the end, as pify restores them.
		const forgot = "0b7f5a52-6f0e-4d38-9a43-3d1f6a2c9e10";
		writeFileSync(join(agentDir, "memory", "recovery", `${forgot}.json`), JSON.stringify({ id: forgot, timestamp: 1, removals: [{ file: globalFile, text: "- [insight] Forgotten" }] }));
		store.restore(forgot);
		assert.equal(readFileSync(globalFile, "utf8"), "# Memory\n\n<!-- 2026-10-26 12:23:09 [01a17672] -->\n- First\n- Third\n- [insight] Forgotten\n");
	} finally {
		cleanup();
	}
});

test("editing keeps a log entry's time, and a changed entry is refused", async () => {
	const { store, agentDir, cleanup } = setup();
	try {
		const file = join(agentDir, "memory", "daily", "2026-10-20.md");
		writeFileSync(file, "# Daily log 2026-10-20\n\n- 09:15 [insight] Old\n");
		const [entry] = (await store.file({ kind: "daily", date: "2026-10-20" })).entries;
		assert.deepEqual(await store.edit({ kind: "daily", date: "2026-10-20" }, entry!, "correction", "New"), {});
		assert.equal(readFileSync(file, "utf8"), "# Daily log 2026-10-20\n\n- 09:15 [correction] New\n");
		await assert.rejects(store.edit({ kind: "daily", date: "2026-10-20" }, entry!, undefined, "Again"), /changed since the page loaded/);
		await assert.rejects(store.file({ kind: "daily", date: "../MEMORY" }), /Invalid date/);
	} finally {
		cleanup();
	}
});

test("moving to the top puts an entry first, so it is the last to be cut", async () => {
	const { store, project, projectFile, cleanup } = setup();
	try {
		writeFileSync(projectFile, "# Project memory\n\n- One\n- Two\n- Three\n");
		const entries = (await store.file({ kind: "project", cwd: project })).entries;
		await store.moveToTop({ kind: "project", cwd: project }, entries[2]!);
		assert.equal(readFileSync(projectFile, "utf8"), "# Project memory\n\n- Three\n- One\n- Two\n");
	} finally {
		cleanup();
	}
});

test("only today's and yesterday's logs load, and older failures pify recalls are marked", async () => {
	const { store, agentDir, cleanup } = setup();
	try {
		const now = new Date(2026, 9, 26, 12);
		const daily = join(agentDir, "memory", "daily");
		writeFileSync(join(daily, `${localDate(now)}.md`), "- 10:00 [failure] Today\n");
		writeFileSync(join(daily, "2026-10-25.md"), "- 10:00 Yesterday\n");
		writeFileSync(join(daily, "2026-10-20.md"), "- 10:00 [failure] Older\n- 11:00 Plain\n");
		const days = store.days(now);
		assert.deepEqual(days.map((day) => [day.date, day.file.loads]), [["2026-10-26", true], ["2026-10-25", true], ["2026-10-20", false]]);
		assert.deepEqual(days[2]!.file.entries.map((entry) => [entry.loaded, entry.recalled]), [[false, true], [false, undefined]]);
		assert.equal(days[0]!.file.entries[0]!.recalled, undefined);
	} finally {
		cleanup();
	}
});

test("the load switch answers pify's consent question and keeps its other answers", async () => {
	const { store, agentDir, project, projectFile, cleanup } = setup();
	try {
		const consent = join(agentDir, "pify-project-consent.json");
		writeFileSync(consent, JSON.stringify({ "c:/other": { memory: true }, [project.replaceAll("\\", "/").toLowerCase()]: { agents: true } }));
		writeFileSync(projectFile, "- One\n");
		await store.setConsent(project, false);
		const saved = JSON.parse(readFileSync(consent, "utf8"));
		assert.deepEqual(saved["c:/other"], { memory: true });
		assert.deepEqual(saved[project.replaceAll("\\", "/").toLowerCase()], { agents: true, memory: false });
		const [workspace] = await store.workspaces();
		assert.equal(workspace?.consent, false);
		assert.equal(workspace?.entries, 1);
		assert.deepEqual(readdirSync(join(agentDir, "memory")).sort(), ["daily"]);
	} finally {
		cleanup();
	}
});
