import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, parseFrontmatter, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillDraft, SkillSource } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { unzip } from "./unzip.ts";

type Loaded = { skills: Skill[]; diagnostics: ResourceDiagnostic[] };

/** pi's limits for a skill's name and description, from the Agent Skills spec. */
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

function inside(root: string, path: string): boolean {
	return resolve(path).startsWith(resolve(root) + sep);
}

/**
 * The skills a session in an app loads: the app folder's own first, each replacing pi's skill of the same name,
 * then pi's. Skills the app turned off are left out, unless `keepDisabled` asks for all of them, as Settings does.
 */
export function appSkills(base: Loaded, dir: string, disabled: ReadonlySet<string>, keepDisabled = false): Loaded {
	const own = loadSkillsFromDir({ dir, source: "path" });
	const diagnostics = [...base.diagnostics, ...own.diagnostics];
	const byName = new Map<string, Skill>();
	for (const skill of [...own.skills, ...base.skills]) {
		const winner = byName.get(skill.name);
		if (!winner) {
			byName.set(skill.name, skill);
			continue;
		}
		// pi reports its own collisions already; these are the ones the app folder causes.
		if (inside(dir, winner.filePath)) {
			diagnostics.push({
				type: "collision",
				message: `name "${skill.name}" collision`,
				path: skill.filePath,
				collision: { resourceType: "skill", name: skill.name, winnerPath: winner.filePath, loserPath: skill.filePath },
			});
		}
	}
	const skills = [...byName.values()];
	return { skills: keepDisabled ? skills : skills.filter((skill) => !disabled.has(skill.filePath)), diagnostics };
}

/** `shipped` are the folders of the packages Trivium ships, whose skills an update replaces. */
export function skillSource(skill: Skill, dir: string, shipped: string[] = []): SkillSource {
	if (inside(dir, skill.filePath)) return "App";
	if (shipped.some((folder) => inside(folder, skill.filePath))) return "Trivium";
	if (skill.sourceInfo?.origin === "package") return "Package";
	if (skill.sourceInfo?.scope === "project") return "Project";
	return "Global";
}

/** Why pi would refuse or warn about a skill's name, or nothing when it's fine. */
export function nameProblem(name: string): string | undefined {
	if (!name) return t("Give the skill a name.");
	if (name.length > MAX_NAME) return t("A skill's name can be at most {n} characters.", { n: MAX_NAME });
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return t("Use lowercase letters, digits and single hyphens in a skill's name, such as release-notes.");
	return undefined;
}

function descriptionProblem(description: unknown): string | undefined {
	if (typeof description !== "string" || !description.trim()) return t("A skill needs a description: pi only loads skills that say when to use them.");
	if (description.length > MAX_DESCRIPTION) return t("A skill's description can be at most {n} characters.", { n: MAX_DESCRIPTION });
	return undefined;
}

/** A SKILL.md for a draft. JSON strings are valid YAML, so the description needs no escaping of its own. */
export function skillText(draft: SkillDraft): string {
	const body = draft.body.trim();
	return `---\nname: ${draft.name}\ndescription: ${JSON.stringify(draft.description.trim().replace(/\s*\n\s*/g, " "))}\n---\n\n${body ? `${body}\n` : ""}`;
}

/** Refuses text pi couldn't load as a skill, so a skill saved from Settings never quietly disappears. */
export function checkSkillText(text: string): void {
	let frontmatter: Record<string, unknown>;
	try {
		({ frontmatter } = parseFrontmatter(text));
	} catch (error) {
		throw new Error(t("The frontmatter between the --- lines isn't valid YAML: {error}", { error: error instanceof Error ? error.message : String(error) }));
	}
	const problem = descriptionProblem(frontmatter.description);
	if (problem) throw new Error(problem);
}

async function writeAtomic(file: string, text: string): Promise<void> {
	await writeFile(`${file}.tmp`, text);
	await rename(`${file}.tmp`, file);
}

/** Writes a new skill as <dir>/<name>/SKILL.md. Resolves with its path. */
export async function createSkill(dir: string, draft: SkillDraft): Promise<string> {
	const name = draft.name.trim();
	const problem = nameProblem(name) ?? descriptionProblem(draft.description);
	if (problem) throw new Error(problem);
	const folder = join(dir, name);
	if (existsSync(folder)) throw new Error(t("This mode already has a skill named {name}.", { name }));
	await mkdir(folder, { recursive: true });
	const file = join(folder, "SKILL.md");
	await writeAtomic(file, skillText({ ...draft, name }));
	return file;
}

export function readSkill(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function saveSkill(path: string, text: string): Promise<void> {
	checkSkillText(text);
	await writeAtomic(path, text);
}

/** What deleting a skill removes: the folder of a SKILL.md, which holds its scripts and references, or the lone .md file. */
export function skillTarget(path: string, dir: string): string {
	if (!inside(dir, path)) throw new Error(t("Only skills in this mode's own folder can be deleted here."));
	const folder = dirname(path);
	return basename(path) === "SKILL.md" && resolve(folder) !== resolve(dir) ? folder : path;
}

/** A skill found in something the user picked or dropped, ready to copy into a mode's folder. */
export interface FoundSkill {
	name: string;
	description: string;
	/** The folder holding its SKILL.md, copied whole with its scripts and references; unset for a lone .md file. */
	folder?: string;
	file: string;
	/** Removes what an archive was extracted to. */
	dispose: () => Promise<void>;
}

/** A name pi accepts, made from a folder or file name. */
const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_NAME)
		.replace(/^-+|-+$/g, "");

const ARCHIVE = /\.(zip|skill)$/i;

/** The folder with the SKILL.md: this one, or its only subfolder that has one, as a zip of a skill's folder holds. */
async function skillFolder(dir: string): Promise<string | undefined> {
	if (existsSync(join(dir, "SKILL.md"))) return dir;
	const entries = await readdir(dir, { withFileTypes: true });
	const found = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(dir, entry.name, "SKILL.md")));
	if (found.length > 1) throw new Error(t("That holds {n} skills. Add them one at a time.", { n: found.length }));
	return found[0] && join(dir, found[0].name);
}

/** Finds the skill in a folder, a .md file, or a .zip or .skill archive, and checks that pi would load it. */
export async function findSkill(path: string): Promise<FoundSkill> {
	const info = await stat(path).catch(() => {
		throw new Error(t("There's no file at {path}.", { path }));
	});
	let dispose = async () => {};
	try {
		let folder: string | undefined;
		let fallback: string;
		if (info.isDirectory()) {
			folder = await skillFolder(path);
			fallback = basename(folder ?? path);
		} else if (ARCHIVE.test(path)) {
			const temp = await mkdtemp(join(tmpdir(), "trivium-skill-"));
			dispose = () => rm(temp, { recursive: true, force: true });
			await unzip(path, temp);
			folder = await skillFolder(temp);
			fallback = !folder || folder === temp ? basename(path).replace(ARCHIVE, "") : basename(folder);
		} else if (/\.md$/i.test(path)) {
			fallback = basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path).replace(/\.md$/i, "");
		} else {
			throw new Error(t("Add a skill's folder, its .md file, or a .zip of it."));
		}
		const lone = !info.isDirectory() && !ARCHIVE.test(path);
		if (!lone && !folder) throw new Error(t("There's no SKILL.md in {name}.", { name: basename(path) }));
		const file = folder ? join(folder, "SKILL.md") : path;
		const text = await readFile(file, "utf8");
		checkSkillText(text);
		const { frontmatter } = parseFrontmatter(text);
		const declared = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const name = declared && !nameProblem(declared) ? declared : slug(declared || fallback);
		const problem = nameProblem(name);
		if (problem) throw new Error(problem);
		return { name, description: String(frontmatter.description).trim(), folder, file, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}

/**
 * Copies a found skill into <dir>/<name>, leaving out node_modules and .git. A skill already there with that
 * name is refused, unless `replace` is given to move it out of the way first.
 */
export async function addSkill(dir: string, found: FoundSkill, replace?: (path: string) => Promise<void>): Promise<string> {
	if (inside(dir, found.file)) throw new Error(t("{name} is already in this mode's folder.", { name: found.name }));
	const target = join(dir, found.name);
	if (existsSync(target)) {
		if (!replace) throw new Error(t("This mode already has a skill named {name}.", { name: found.name }));
		await replace(target);
	}
	const { folder } = found;
	if (folder) {
		await cp(folder, target, {
			recursive: true,
			filter: (source) => !relative(folder, source).split(sep).some((part) => part === "node_modules" || part === ".git"),
		});
	} else {
		await mkdir(target, { recursive: true });
		await copyFile(found.file, join(target, "SKILL.md"));
	}
	return join(target, "SKILL.md");
}
