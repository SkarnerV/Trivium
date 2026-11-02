import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { addSkill, appSkills, checkSkillText, createSkill, findSkill, nameProblem, saveSkill, skillSource, skillTarget } from "../src/main/skills.ts";
import { unzip } from "../src/main/unzip.ts";

function folders() {
	const root = mkdtempSync(join(tmpdir(), "trivium-skills-"));
	const global = join(root, "global");
	const mode = join(root, "mode");
	mkdirSync(global);
	mkdirSync(mode);
	return { global, mode };
}

function writeSkill(dir: string, name: string, description: string): string {
	mkdirSync(join(dir, name), { recursive: true });
	const file = join(dir, name, "SKILL.md");
	writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`);
	return file;
}

test("a mode's own skill replaces pi's skill of the same name, and says which", () => {
	const { global, mode } = folders();
	const shared = writeSkill(global, "review", "Global review");
	writeSkill(global, "deploy", "Global deploy");
	const own = writeSkill(mode, "review", "Mode review");
	const result = appSkills(loadSkillsFromDir({ dir: global, source: "user" }), mode, new Set());
	assert.deepEqual(result.skills.map((skill) => [skill.name, skill.description]).sort(), [["deploy", "Global deploy"], ["review", "Mode review"]]);
	const collision = result.diagnostics.find((d) => d.type === "collision");
	assert.equal(collision?.collision?.winnerPath, own);
	assert.equal(collision?.collision?.loserPath, shared);
	assert.equal(skillSource(result.skills.find((skill) => skill.name === "review")!, mode), "App");
	assert.equal(skillSource(result.skills.find((skill) => skill.name === "deploy")!, mode), "Global");
	assert.equal(skillSource(result.skills.find((skill) => skill.name === "deploy")!, mode, [global]), "Trivium");
});

test("skills turned off in a mode are left out of its sessions but still listed in Settings", () => {
	const { global, mode } = folders();
	const off = writeSkill(global, "deploy", "Global deploy");
	writeSkill(mode, "notes", "Mode notes");
	const base = loadSkillsFromDir({ dir: global, source: "user" });
	assert.deepEqual(appSkills(base, mode, new Set([off])).skills.map((skill) => skill.name), ["notes"]);
	assert.deepEqual(appSkills(base, mode, new Set([off]), true).skills.map((skill) => skill.name).sort(), ["deploy", "notes"]);
});

test("a skill created in Settings is one pi loads", async () => {
	const { mode } = folders();
	const file = await createSkill(mode, { name: "release-notes", description: 'Drafts notes: "what changed"\nper release.', body: "# Steps\n\n1. Read the log.\n" });
	assert.equal(file, join(mode, "release-notes", "SKILL.md"));
	const [skill] = loadSkillsFromDir({ dir: mode, source: "path" }).skills;
	assert.equal(skill?.name, "release-notes");
	assert.equal(skill?.description, 'Drafts notes: "what changed" per release.');
	assert.match(readFileSync(file, "utf8"), /\n# Steps\n\n1\. Read the log\.\n$/);
	await assert.rejects(createSkill(mode, { name: "release-notes", description: "Again", body: "" }), /already has a skill named release-notes/);
});

test("names and descriptions pi would refuse are caught before anything is written", async () => {
	const { mode } = folders();
	assert.equal(nameProblem("release-notes"), undefined);
	for (const name of ["", "Release", "-notes", "notes-", "a--b", "a_b", "x".repeat(65)]) assert.ok(nameProblem(name), name);
	await assert.rejects(createSkill(mode, { name: "notes", description: "  ", body: "" }), /needs a description/);
});

test("saving a skill keeps it loadable", async () => {
	const { mode } = folders();
	const file = writeSkill(mode, "notes", "Mode notes");
	await assert.rejects(saveSkill(file, "---\nname: notes\n---\nNo description."), /needs a description/);
	assert.throws(() => checkSkillText("---\ndescription: [unclosed\n---\n"), /isn't valid YAML/);
	await saveSkill(file, "---\nname: notes\ndescription: Better notes\nlicense: MIT\n---\n\nNew body.\n");
	assert.equal(loadSkillsFromDir({ dir: mode, source: "path" }).skills[0]?.description, "Better notes");
});

test("deleting a skill removes its folder, or a lone file, and only in the mode's folder", () => {
	const { global, mode } = folders();
	const file = writeSkill(mode, "notes", "Mode notes");
	assert.equal(skillTarget(file, mode), join(mode, "notes"));
	const loose = join(mode, "quick.md");
	writeFileSync(loose, "---\ndescription: Quick\n---\n");
	assert.equal(skillTarget(loose, mode), loose);
	assert.throws(() => skillTarget(writeSkill(global, "deploy", "Global deploy"), mode), /this mode's own folder/);
});

/** A zip archive of the given files, written the way zip tools do: deflated, with a central directory. */
function zipOf(entries: Record<string, string>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, text] of Object.entries(entries)) {
		const raw = Buffer.from(text);
		const data = deflateRawSync(raw);
		const file = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(raw), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(file.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(crc32(raw), 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(file.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, file, data);
		centrals.push(central, file);
		offset += local.length + file.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(centrals.length / 2, 8);
	end.writeUInt16LE(centrals.length / 2, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`;

test("an uploaded skill folder is copied whole, without node_modules or .git", async () => {
	const { global, mode } = folders();
	const source = join(global, "pdf-tools");
	mkdirSync(join(source, "scripts"), { recursive: true });
	mkdirSync(join(source, "node_modules", "dep"), { recursive: true });
	mkdirSync(join(source, ".git"));
	writeFileSync(join(source, "SKILL.md"), skillMd("pdf-tools", "Works with PDFs"));
	writeFileSync(join(source, "scripts", "split.py"), "print('split')");
	writeFileSync(join(source, "node_modules", "dep", "index.js"), "");
	writeFileSync(join(source, ".git", "HEAD"), "");
	const found = await findSkill(source);
	assert.deepEqual([found.name, found.description], ["pdf-tools", "Works with PDFs"]);
	await addSkill(mode, found);
	assert.ok(existsSync(join(mode, "pdf-tools", "scripts", "split.py")));
	assert.ok(!existsSync(join(mode, "pdf-tools", "node_modules")));
	assert.ok(!existsSync(join(mode, "pdf-tools", ".git")));
	await assert.rejects(addSkill(mode, found), /already has a skill named pdf-tools/);
	const replaced: string[] = [];
	await addSkill(mode, found, async (path) => {
		replaced.push(path);
		rmSync(path, { recursive: true });
	});
	assert.deepEqual(replaced, [join(mode, "pdf-tools")]);
	await assert.rejects(findSkill(join(mode, "pdf-tools")).then((again) => addSkill(mode, again)), /already in this mode's folder/);
});

test("a lone .md file becomes a skill folder named after the file when it names none", async () => {
	const { global, mode } = folders();
	const file = join(global, "Meeting Notes.md");
	writeFileSync(file, "---\ndescription: Summarizes meetings\n---\n\nSummarize.\n");
	const found = await findSkill(file);
	assert.equal(found.name, "meeting-notes");
	await addSkill(mode, found);
	assert.equal(loadSkillsFromDir({ dir: mode, source: "path" }).skills[0]?.name, "meeting-notes");
	writeFileSync(join(global, "empty.md"), "Just text.");
	await assert.rejects(findSkill(join(global, "empty.md")), /needs a description/);
	writeFileSync(join(global, "notes.txt"), "");
	await assert.rejects(findSkill(join(global, "notes.txt")), /\.zip of it/);
});

test("a zip of a skill's folder, or of its files, uploads like the folder", async () => {
	const { global, mode } = folders();
	const nested = join(global, "nested.zip");
	writeFileSync(nested, zipOf({ "review/SKILL.md": skillMd("review", "Reviews code"), "review/checklist.md": "- tests", "__MACOSX/review/._SKILL.md": "junk" }));
	const flat = join(global, "triage.skill");
	writeFileSync(flat, zipOf({ "SKILL.md": "---\ndescription: Triages bugs\n---\n" }));
	for (const archive of [nested, flat]) {
		const found = await findSkill(archive);
		try {
			await addSkill(mode, found);
		} finally {
			await found.dispose();
		}
	}
	assert.equal(readFileSync(join(mode, "review", "checklist.md"), "utf8"), "- tests");
	assert.deepEqual(loadSkillsFromDir({ dir: mode, source: "path" }).skills.map((skill) => skill.name).sort(), ["review", "triage"]);
	const two = join(global, "two.zip");
	writeFileSync(two, zipOf({ "a/SKILL.md": skillMd("a", "A"), "b/SKILL.md": skillMd("b", "B") }));
	await assert.rejects(findSkill(two), /holds 2 skills/);
	const none = join(global, "none.zip");
	writeFileSync(none, zipOf({ "readme.txt": "hi" }));
	await assert.rejects(findSkill(none), /no SKILL\.md in none\.zip/);
});

test("an archive whose files point outside it is refused", async () => {
	const { global } = folders();
	const archive = join(global, "evil.zip");
	writeFileSync(archive, zipOf({ "../escaped.md": "x", "SKILL.md": skillMd("evil", "Evil") }));
	await assert.rejects(unzip(archive, join(global, "out")), /point outside it/);
	assert.ok(!existsSync(join(global, "escaped.md")));
	writeFileSync(join(global, "fake.zip"), "not a zip");
	await assert.rejects(findSkill(join(global, "fake.zip")), /isn't a zip archive/);
});
