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

/** The same text as a Windows editor saves it. */
const crlf = (text: string) => text.replaceAll("\n", "\r\n");
const STAMP_LINE = "<!-- 2026-10-26 12:23:09 [01a17672] -->";

test("a file saved with CRLF has the same entries as with LF", () => {
	const content = `# Long-term memory\n\n${STAMP_LINE}\n- [failure] npm ci fails\n* 14:05 [tool-quirk] seed with --reset\n- [unknown] kept as text\n-   \nprose\n- last`;
	const lf = parseEntries(content, Infinity).entries;
	assert.equal(lf.length, 4);
	// Lines too, without the "\r", so a page that read one finds its entries in the other.
	assert.deepEqual(parseEntries(crlf(content), Infinity).entries, lf);
	assert.deepEqual(parseEntries(crlf(`${content}\n`), Infinity).entries, lf);
	// Both endings in one file, as when pify appends to one that Notepad saved.
	assert.deepEqual(parseEntries(`${crlf("# Memory\n\n- One\n")}- Two\n- Three\r\n`, Infinity).entries.map(({ line, raw, text }) => ({ line, raw, text })), [
		{ line: 2, raw: "- One", text: "One" },
		{ line: 3, raw: "- Two", text: "Two" },
		{ line: 4, raw: "- Three", text: "Three" },
	]);
});

test("the cut counts each \\r, as pify does, but not an entry's own line ending", () => {
	const content = crlf("\n# M\n\n- One\n- Two\n- Three\n");
	const trimmed = content.trim();
	const loaded = (limit: number) => parseEntries(content, limit).entries.map((entry) => entry.loaded);
	assert.equal(parseEntries(content, 100).chars, trimmed.length);
	for (const [i, text] of ["- One", "- Two", "- Three"].entries()) {
		const end = trimmed.indexOf(text) + text.length;
		assert.equal(loaded(end)[i], true, `${text} at ${end}`);
		assert.equal(loaded(end - 1)[i], false, `${text} at ${end - 1}`);
	}
	// Endings of both kinds are counted as they are.
	const mixed = "# M\r\n\n- One\r\n- Two\n- Three";
	const end = mixed.indexOf("- Three") + "- Three".length;
	assert.deepEqual([end, end - 1].map((limit) => parseEntries(mixed, limit).entries[2]!.loaded), [true, false]);
});

test("the Memory page counts and opens CRLF files of every kind", async () => {
	const { store, agentDir, project, projectFile, globalFile, cleanup } = setup();
	try {
		writeFileSync(globalFile, crlf("# Long-term memory\n\n- One\n- Two\n"));
		writeFileSync(projectFile, crlf("# Project memory\n\n- One\n"));
		writeFileSync(join(agentDir, "memory", "daily", "2026-10-20.md"), crlf("# Daily log\n\n- 10:00 [failure] Older\n- 11:00 Plain\n"));
		const overview = await store.overview();
		assert.deepEqual([overview.global.entries, overview.workspaces[0]?.entries, overview.days], [2, 1, 1]);
		assert.deepEqual((await store.file({ kind: "global" })).entries.map((entry) => [entry.text, entry.loaded]), [["One", true], ["Two", true]]);
		assert.deepEqual((await store.file({ kind: "project", cwd: project })).entries.map((entry) => entry.text), ["One"]);
		const [day] = store.days(new Date(2026, 9, 26, 12));
		assert.deepEqual(day!.file.entries.map(({ time, category, text, recalled }) => [time, category, text, recalled]), [
			["10:00", "failure", "Older", true],
			["11:00", undefined, "Plain", undefined],
		]);
	} finally {
		cleanup();
	}
});

test("adding to a CRLF file ends the entry with CRLF and takes line breaks out of the text", async () => {
	const { store, globalFile, cleanup } = setup();
	try {
		const add = async (before: string, text = "New") => {
			writeFileSync(globalFile, before);
			assert.deepEqual(await store.add({ kind: "global" }, undefined, text), {});
			return readFileSync(globalFile, "utf8");
		};
		assert.equal(await add("# M\r\n\r\n- One\r\n"), "# M\r\n\r\n- One\r\n- New\r\n");
		assert.equal(await add("# M\r\n\r\n- One"), "# M\r\n\r\n- One\r\n- New\r\n");
		// What pify appended keeps its ending.
		assert.equal(await add("# M\r\n\r\n- One\n"), "# M\r\n\r\n- One\n- New\r\n");
		// Half a line ending, left by pify's forget, is completed.
		assert.equal(await add("# M\r\n\r\n- One\r"), "# M\r\n\r\n- One\r\n- New\r\n");
		assert.equal(await add("# M\n\n- One\n"), "# M\n\n- One\n- New\n");
		assert.equal(await add("\r\n\r\n"), "# Long-term memory\n\n- New\n");
		assert.equal(await add("- One\r\n", "a\r\nb \r\n\r\n c\rd\r\n"), "- One\r\n- a b c d\r\n");
	} finally {
		cleanup();
	}
});

test("editing a CRLF file changes only the entry's text", async () => {
	const { store, agentDir, globalFile, cleanup } = setup();
	try {
		const target = { kind: "daily", date: "2026-10-20" } as const;
		const file = join(agentDir, "memory", "daily", "2026-10-20.md");
		// The last two lines are as pify appends them.
		writeFileSync(file, "# Daily log 2026-10-20\r\n\r\n- 09:15 [insight] Old\r\n- 10:00 Two\n- 11:00 Three\n");
		const [first, second] = (await store.file(target)).entries;
		assert.deepEqual(await store.edit(target, first!, "correction", "New\r\ntext"), {});
		assert.deepEqual(await store.edit(target, second!, undefined, "Second"), {});
		assert.equal(readFileSync(file, "utf8"), "# Daily log 2026-10-20\r\n\r\n- 09:15 [correction] New text\r\n- 10:00 Second\n- 11:00 Three\n");
		await assert.rejects(store.edit(target, first!, undefined, "Again"), /changed since the page loaded/);
		// The last line, without an ending.
		writeFileSync(globalFile, "- One\r\n- Two");
		await store.edit({ kind: "global" }, (await store.file({ kind: "global" })).entries[1]!, undefined, "Last");
		assert.equal(readFileSync(globalFile, "utf8"), "- One\r\n- Last");
	} finally {
		cleanup();
	}
});

test("an entry is still found after an editor changes the file's line endings", async () => {
	const { store, globalFile, cleanup } = setup();
	try {
		const target = { kind: "global" } as const;
		const content = "# M\n\n- One\n- Two\n- Three\n";
		for (const [before, after] of [[content, crlf(content)], [crlf(content), content]] as const) {
			writeFileSync(globalFile, before);
			const entries = (await store.file(target)).entries;
			writeFileSync(globalFile, after);
			await store.edit(target, entries[0]!, undefined, "Changed");
			await store.delete(target, entries[1]!);
			await store.moveToTop(target, entries[2]!);
			const expected = "# M\n\n- Three\n- Changed\n";
			assert.equal(readFileSync(globalFile, "utf8"), after === content ? expected : crlf(expected));
		}
	} finally {
		cleanup();
	}
});

test("moving to the top of a CRLF file takes the stamp along and keeps line endings whole", async () => {
	const { store, globalFile, cleanup } = setup();
	try {
		const move = async (before: string) => {
			writeFileSync(globalFile, before);
			await store.moveToTop({ kind: "global" }, (await store.file({ kind: "global" })).entries.at(-1)!);
			return readFileSync(globalFile, "utf8");
		};
		assert.equal(await move(crlf("# M\n\n- One\n- Two\n- Three\n")), crlf("# M\n\n- Three\n- One\n- Two\n"));
		assert.equal(await move(crlf(`# M\n\n<!-- a -->\n- One\n${STAMP_LINE}\n- Two\n`)), crlf(`# M\n\n${STAMP_LINE}\n- Two\n<!-- a -->\n- One\n`));
		// The last line has no ending; the new last line has none either.
		assert.equal(await move(crlf("# M\n\n- One\n- Two")), crlf("# M\n\n- Two\n- One"));
		// Each line keeps its own ending.
		assert.equal(await move("# M\r\n\r\n- One\r\n- Two\n"), "# M\r\n\r\n- Two\n- One\r\n");
		assert.equal(await move(crlf("# M\n\n- One\n")), crlf("# M\n\n- One\n"));
	} finally {
		cleanup();
	}
});

test("deleting from a CRLF file records lines without \\r, and Undo puts back the file as it was", async () => {
	const { store, globalFile, agentDir, cleanup } = setup();
	try {
		const content = crlf(`# Memory\n\n${STAMP_LINE}\n- First\n- [failure] Second\n- Third`);
		writeFileSync(globalFile, content);
		const [first, , third] = (await store.file({ kind: "global" })).entries;
		const id = await store.delete({ kind: "global" }, first!);
		assert.equal(readFileSync(globalFile, "utf8"), crlf("# Memory\n\n- [failure] Second\n- Third"));
		const record = JSON.parse(readFileSync(join(agentDir, "memory", "recovery", `${id}.json`), "utf8"));
		assert.deepEqual(record.removals, [
			{ file: globalFile, text: STAMP_LINE },
			{ file: globalFile, text: "- First" },
		]);
		assert.deepEqual(store.deleted().map((deletion) => deletion.items), [[{ where: "Everywhere", category: undefined, text: "First" }]]);
		store.restore(id);
		assert.equal(readFileSync(globalFile, "utf8"), content);
		// The last line, without an ending, leaves no lone "\r" behind.
		const last = await store.delete({ kind: "global" }, third!);
		assert.equal(readFileSync(globalFile, "utf8"), crlf(`# Memory\n\n${STAMP_LINE}\n- First\n- [failure] Second`));
		store.restore(last);
		assert.equal(readFileSync(globalFile, "utf8"), content);
		// Undo follows a file saved with LF in between.
		const again = await store.delete({ kind: "global" }, first!);
		writeFileSync(globalFile, "# Memory\n\n- [failure] Second\n- Third\n");
		store.restore(again);
		assert.equal(readFileSync(globalFile, "utf8"), `# Memory\n\n${STAMP_LINE}\n- First\n- [failure] Second\n- Third\n`);
	} finally {
		cleanup();
	}
});

test("what pify's forget takes out of a CRLF file, with its \\r, is listed and restored", async () => {
	const { store, globalFile, projectFile, agentDir, cleanup } = setup();
	try {
		mkdirSync(join(agentDir, "memory", "recovery"), { recursive: true });
		const id = "0b7f5a52-6f0e-4d38-9a43-3d1f6a2c9e10";
		const forget = (removals: { file: string; text: string }[]) =>
			writeFileSync(join(agentDir, "memory", "recovery", `${id}.json`), JSON.stringify({ id, timestamp: 1, removals }));
		forget([
			{ file: globalFile, text: "- [insight] Forgotten\r" },
			{ file: projectFile, text: "- Also\r" },
		]);
		assert.deepEqual(store.deleted()[0]!.items, [
			{ where: "Everywhere", category: "insight", text: "Forgotten" },
			{ where: "acme", category: undefined, text: "Also" },
		]);
		writeFileSync(globalFile, "# M\r\n\r\n- One\r\n");
		writeFileSync(projectFile, "# P\n\n- One\n");
		store.restore(id);
		assert.equal(readFileSync(globalFile, "utf8"), "# M\r\n\r\n- One\r\n- [insight] Forgotten\r\n");
		assert.equal(readFileSync(projectFile, "utf8"), "# P\n\n- One\n- Also\n");
		// Forgetting the last line leaves half of the ending before it; the entry there still shows and can be changed.
		writeFileSync(globalFile, "# M\r\n\r\n- One\r\n- Two\r");
		const { entries } = await store.file({ kind: "global" });
		assert.deepEqual(entries.map((entry) => entry.raw), ["- One", "- Two"]);
		await store.moveToTop({ kind: "global" }, entries[1]!);
		assert.equal(readFileSync(globalFile, "utf8"), "# M\r\n\r\n- Two\r\n- One\r\n");
		writeFileSync(globalFile, "# M\r\n\r\n- One\r");
		forget([{ file: globalFile, text: "- Two" }]);
		store.restore(id);
		assert.equal(readFileSync(globalFile, "utf8"), "# M\r\n\r\n- One\r\n- Two\r\n");
	} finally {
		cleanup();
	}
});

test("restoring a whole-file snapshot writes its line endings as they were", () => {
	const { store, globalFile, agentDir, cleanup } = setup();
	try {
		mkdirSync(join(agentDir, "memory", "recovery"), { recursive: true });
		const id = "0b7f5a52-6f0e-4d38-9a43-3d1f6a2c9e11";
		const content = "# M\r\n\r\n- One\r\n- Two\n";
		writeFileSync(join(agentDir, "memory", "recovery", `${id}.json`), JSON.stringify({ id, timestamp: 1, removals: [], replacements: [{ file: globalFile, content }] }));
		writeFileSync(globalFile, "# M\n\n- Tidied\n");
		store.restore(id);
		assert.equal(readFileSync(globalFile, "utf8"), content);
	} finally {
		cleanup();
	}
});
