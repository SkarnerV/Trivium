import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryDay,
	type MemoryDeletion,
	type MemoryEntry,
	type MemoryFile,
	type MemoryOverview,
	type MemoryResult,
	type MemoryTarget,
	type MemoryWorkspace,
} from "../shared/protocol.ts";

const run = promisify(execFile);

/** pify's limits: each MEMORY.md is cut after this many characters, and today's and yesterday's logs after 3,000. */
export const MEMORY_LIMIT = 6000;
export const DAILY_LIMIT = 3000;

const BULLET = /^\s*[-*]\s+(?:(\d{1,2}:\d{2})\s+)?(.*)$/;
const TAGGED = /^\[([a-z-]+)\]\s*(.*)$/;
/** pi-memory, which Trivium shipped before, stamps each entry with a comment line above it. */
const STAMP = /^\s*<!--.*-->\s*$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** What pify's own code decides, passed in by the main process, which bundles it; tests pass their own. */
export interface MemoryRules {
	/** pify's secret gate: what in the text looks like a credential, safe to show. */
	secrets(text: string): { label: string; preview: string }[];
	/** pify's recall: which failures and corrections go into new sessions, newest first. */
	recall(lessons: Lesson[]): Lesson[];
}

/** pify's shape for a categorised entry. */
export interface Lesson {
	category: MemoryCategory;
	text: string;
	file: string;
	date: string | null;
}

/** pify's recovery record, with where the lines were so Trivium can put them back in place. */
interface RecoveryRecord {
	id: string;
	timestamp: number;
	removals: { file: string; text: string }[];
	replacements?: { file: string; content: string }[];
	trivium?: { line: number };
}

const isCategory = (value: string): value is MemoryCategory => (MEMORY_CATEGORIES as readonly string[]).includes(value);

const readText = (file: string): string | undefined => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};

const pad = (n: number) => String(n).padStart(2, "0");
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayBefore = (d = new Date()) => localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));

/** One entry per bullet. Other lines, such as headings, stay in the file but aren't entries. */
export function parseEntries(content: string, limit: number): { chars: number; entries: MemoryEntry[] } {
	const lead = content.length - content.trimStart().length;
	const entries: MemoryEntry[] = [];
	let offset = 0;
	content.split("\n").forEach((raw, line) => {
		const end = offset + raw.length;
		offset = end + 1;
		const bullet = BULLET.exec(raw);
		if (!bullet) return;
		const tagged = TAGGED.exec(bullet[2]!);
		const category = tagged && isCategory(tagged[1]!) ? tagged[1] : undefined;
		const text = (category ? tagged![2]! : bullet[2]!).trim();
		if (!text) return;
		entries.push({ line, raw, category, text, time: bullet[1], loaded: end - lead <= limit });
	});
	return { chars: content.trim().length, entries };
}

/** The stored form of an entry: one line, as pify writes it. */
export function formatEntry(category: MemoryCategory | undefined, text: string, time?: string): string {
	return `- ${time ? `${time} ` : ""}${category ? `[${category}] ` : ""}${text}`;
}

/** Memory is one line per entry; line breaks in what was typed become spaces. */
const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, " ").trim();

const normalizeCwd = (cwd: string) => cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

export class MemoryStore {
	readonly dir: string;
	private readonly consentFile: string;
	private readonly rules: MemoryRules;
	/** The projects Trivium has sessions in; the only ones whose memory it reads or writes. */
	private readonly projects: () => Promise<string[]>;

	constructor(agentDir: string, rules: MemoryRules, projects: () => Promise<string[]>, env: Record<string, string | undefined> = process.env) {
		this.rules = rules;
		this.projects = projects;
		this.dir = env.PI_MEMORY_DIR ?? join(agentDir, "memory");
		this.consentFile = join(agentDir, "pify-project-consent.json");
	}

	private get dailyDir() {
		return join(this.dir, "daily");
	}

	private get recoveryDir() {
		return join(this.dir, "recovery");
	}

	private async fileOf(target: MemoryTarget): Promise<string> {
		if (target.kind === "global") return join(this.dir, "MEMORY.md");
		if (target.kind === "daily") {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(target.date)) throw new Error("Invalid date.");
			return join(this.dailyDir, `${target.date}.md`);
		}
		if (!(await this.projects()).includes(target.cwd)) throw new Error("Trivium has no sessions in that folder.");
		return projectFile(target.cwd);
	}

	async overview(): Promise<MemoryOverview> {
		const global = this.read(join(this.dir, "MEMORY.md"), MEMORY_LIMIT, true);
		return {
			global: { path: global.path, entries: global.entries.length },
			workspaces: await this.workspaces(),
			days: this.dayFiles().length,
			deleted: this.records().length,
		};
	}

	/** Projects with a memory file, by name. */
	async workspaces(): Promise<MemoryWorkspace[]> {
		const consent = this.readConsent();
		const found = (await this.projects()).filter((cwd) => existsSync(projectFile(cwd)));
		const list = await Promise.all(
			found.map(async (cwd) => ({
				cwd,
				name: basename(cwd),
				path: projectFile(cwd),
				entries: this.read(projectFile(cwd), MEMORY_LIMIT, true).entries.length,
				consent: consent[normalizeCwd(cwd)]?.memory,
				git: await gitState(cwd),
			})),
		);
		return list.sort((a, b) => a.name.localeCompare(b.name));
	}

	async file(target: MemoryTarget): Promise<MemoryFile> {
		const file = await this.fileOf(target);
		if (target.kind !== "daily") return this.read(file, MEMORY_LIMIT, true);
		return this.days().find((day) => day.date === target.date)?.file ?? this.read(file, DAILY_LIMIT, false);
	}

	private read(path: string, limit: number, loads: boolean): MemoryFile {
		const content = readText(path);
		const { chars, entries } = parseEntries(content ?? "", limit);
		if (!loads) for (const entry of entries) entry.loaded = false;
		return { path, exists: content !== undefined, chars, limit, loads, entries };
	}

	private dayFiles(): string[] {
		try {
			return readdirSync(this.dailyDir)
				.filter((name) => DAY_FILE.test(name))
				.sort()
				.reverse();
		} catch {
			return [];
		}
	}

	/** Every daily log, newest first. Only today's and yesterday's load; older failures and corrections may be recalled. */
	days(now = new Date()): MemoryDay[] {
		const loading = new Set([localDate(now), dayBefore(now)]);
		const days = this.dayFiles().map((name) => {
			const date = DAY_FILE.exec(name)![1]!;
			return { date, file: this.read(join(this.dailyDir, name), DAILY_LIMIT, loading.has(date)) };
		});
		const lessons = days.flatMap((day) =>
			day.file.entries.flatMap((entry) =>
				entry.category ? [{ category: entry.category, text: entry.text, file: day.file.path, date: day.date }] : [],
			),
		);
		const recalled = new Set(this.rules.recall(lessons).map((lesson) => `${lesson.file}\n${lesson.text}`));
		for (const day of days) {
			if (day.file.loads) continue;
			for (const entry of day.file.entries) if (recalled.has(`${day.file.path}\n${entry.text}`)) entry.recalled = true;
		}
		return days;
	}

	/** Refuses text that looks like a credential, the same way pify's memory_write does. */
	private check(text: string): string | undefined {
		if (!text) return "Write something to remember.";
		const [match] = this.rules.secrets(text);
		if (!match) return undefined;
		return `That looks like a credential (${match.label}, ${match.preview}), so it isn't saved: memory goes to the model with every request. Save where it lives instead, such as the name of the variable in .env.`;
	}

	async add(target: MemoryTarget, category: MemoryCategory | undefined, text: string): Promise<MemoryResult> {
		if (target.kind === "daily") throw new Error("The daily log is written by the agent.");
		const clean = oneLine(text);
		const error = this.check(clean);
		if (error) return { error };
		const file = await this.fileOf(target);
		mkdirSync(dirname(file), { recursive: true });
		const entry = formatEntry(category, clean);
		const existing = readText(file);
		// The header pify writes on a new file. Appending, as pify does, keeps an entry another session saves meanwhile.
		if (!existing?.trim()) writeFileSync(file, `${target.kind === "project" ? "# Project memory" : "# Long-term memory"}\n\n${entry}\n`);
		else appendFileSync(file, `${existing.endsWith("\n") ? "" : "\n"}${entry}\n`);
		return {};
	}

	async edit(target: MemoryTarget, at: Pick<MemoryEntry, "line" | "raw">, category: MemoryCategory | undefined, text: string): Promise<MemoryResult> {
		const clean = oneLine(text);
		const error = this.check(clean);
		if (error) return { error };
		const file = await this.fileOf(target);
		const lines = this.lines(file);
		const line = locate(lines, at);
		lines[line] = formatEntry(category, clean, BULLET.exec(at.raw)?.[1]);
		writeFileSync(file, lines.join("\n"));
		return {};
	}

	/** Moves an entry above the others. pify loads each file from the top, so what comes first is cut last. */
	async moveToTop(target: MemoryTarget, at: Pick<MemoryEntry, "line" | "raw">): Promise<void> {
		const file = await this.fileOf(target);
		const lines = this.lines(file);
		const line = locate(lines, at);
		const first = lines.findIndex((text) => BULLET.exec(text) || STAMP.test(text));
		if (first < 0 || first >= line) return;
		const start = line > 0 && STAMP.test(lines[line - 1]!) ? line - 1 : line;
		const moved = lines.splice(start, line - start + 1);
		lines.splice(first, 0, ...moved);
		writeFileSync(file, lines.join("\n"));
	}

	/** Deletes an entry, and pi-memory's stamp above it, after writing pify's recovery record. Resolves with its id. */
	async delete(target: MemoryTarget, at: Pick<MemoryEntry, "line" | "raw">): Promise<string> {
		const file = await this.fileOf(target);
		const lines = this.lines(file);
		const line = locate(lines, at);
		const start = line > 0 && STAMP.test(lines[line - 1]!) ? line - 1 : line;
		const removed = lines.slice(start, line + 1);
		const record: RecoveryRecord = {
			id: randomUUID(),
			timestamp: Date.now(),
			removals: removed.map((text) => ({ file, text })),
			trivium: { line: start },
		};
		// As pify does: the record first, so a failed rewrite never loses the entry.
		mkdirSync(this.recoveryDir, { recursive: true });
		writeFileSync(join(this.recoveryDir, `${record.id}.json`), JSON.stringify(record, null, 2));
		lines.splice(start, removed.length);
		writeFileSync(file, lines.join("\n"));
		return record.id;
	}

	/** Puts a deletion back, where it was when Trivium deleted it, then drops its record. */
	restore(id: string): void {
		if (!/^[\da-f-]{36}$/i.test(id)) throw new Error("Invalid recovery id.");
		const path = join(this.recoveryDir, `${id}.json`);
		const record = JSON.parse(readFileSync(path, "utf8")) as RecoveryRecord;
		for (const { file, content } of record.replacements ?? []) writeFileSync(file, content);
		const files = new Set(record.removals.map((removal) => removal.file));
		const [only] = files;
		if (record.trivium && files.size === 1 && only) {
			const lines = (readText(only) ?? "").split("\n");
			lines.splice(Math.min(record.trivium.line, lines.length), 0, ...record.removals.map((removal) => removal.text));
			writeFileSync(only, lines.join("\n"));
		} else {
			// pify's own forget removes matches from several files; it restores them by appending.
			for (const { file, text } of record.removals) {
				const existing = readText(file) ?? "";
				appendFileSync(file, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${text}\n`);
			}
		}
		unlinkSync(path);
	}

	private records(): RecoveryRecord[] {
		let names: string[] = [];
		try {
			names = readdirSync(this.recoveryDir).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
		return names.flatMap((name) => {
			try {
				const record = JSON.parse(readFileSync(join(this.recoveryDir, name), "utf8")) as RecoveryRecord;
				return record.id && Array.isArray(record.removals) ? [record] : [];
			} catch {
				return [];
			}
		});
	}

	/** Deleted entries and replaced files that can be put back, newest first. */
	deleted(): MemoryDeletion[] {
		return this.records()
			.map((record) => ({
				id: record.id,
				timestamp: record.timestamp,
				kind: record.replacements?.length ? ("replaced" as const) : ("deleted" as const),
				items: [
					...record.removals.flatMap((removal) =>
						parseEntries(removal.text, Infinity).entries.map(({ category, text }) => ({ where: this.where(removal.file), category, text })),
					),
					...(record.replacements ?? []).map((replacement) => ({ where: this.where(replacement.file), text: "The whole file, before it was tidied" })),
				],
			}))
			.sort((a, b) => b.timestamp - a.timestamp);
	}

	/** "Everywhere", a day's date, or the project's folder name. */
	private where(file: string): string {
		const inside = relative(this.dir, resolve(file));
		if (inside === "MEMORY.md") return "Everywhere";
		const day = inside.startsWith(`daily${sep}`) ? DAY_FILE.exec(basename(inside))?.[1] : undefined;
		return day ?? basename(dirname(dirname(dirname(resolve(file)))));
	}

	private lines(file: string): string[] {
		const content = readText(file);
		if (content === undefined) throw new Error("That memory file is gone.");
		return content.split("\n");
	}

	private readConsent(): Record<string, Record<string, boolean>> {
		try {
			const data = JSON.parse(readFileSync(this.consentFile, "utf8")) as unknown;
			return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, Record<string, boolean>>) : {};
		} catch {
			return {};
		}
	}

	/** Answers pify's "Load this project's memory?" in its own consent file, keeping the other answers there. */
	async setConsent(cwd: string, allowed: boolean): Promise<void> {
		await this.fileOf({ kind: "project", cwd });
		const consent = this.readConsent();
		const key = normalizeCwd(cwd);
		consent[key] = { ...(consent[key] ?? {}), memory: allowed };
		writeFileSync(this.consentFile, `${JSON.stringify(consent, null, 2)}\n`);
	}

	/** Leaves the memory file out of git on this computer, without changing the project's .gitignore. */
	async keepLocal(cwd: string): Promise<void> {
		await this.fileOf({ kind: "project", cwd });
		const git = (...args: string[]) => run("git", args, { cwd }).then((result) => result.stdout.trim());
		const exclude = resolve(cwd, await git("rev-parse", "--git-path", "info/exclude"));
		const pattern = `/${(await git("rev-parse", "--show-prefix")).replaceAll("\\", "/")}.pi/memory/`;
		const existing = readText(exclude) ?? "";
		if (existing.split(/\r?\n/).includes(pattern)) return;
		mkdirSync(dirname(exclude), { recursive: true });
		appendFileSync(exclude, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}${pattern}\n`);
	}
}

const projectFile = (cwd: string) => join(cwd, ".pi", "memory", "MEMORY.md");

/** The entry's line now: where it was, or where the same line moved to. Refuses one that changed. */
function locate(lines: string[], at: Pick<MemoryEntry, "line" | "raw">): number {
	if (lines[at.line] === at.raw) return at.line;
	const moved = lines.indexOf(at.raw);
	if (moved < 0) throw new Error("This memory changed since the page loaded. Showing it as it is now.");
	return moved;
}

/** Whether git shares the project's memory file with everyone who clones the repository. */
export async function gitState(cwd: string): Promise<MemoryWorkspace["git"]> {
	const file = ".pi/memory/MEMORY.md";
	const ok = (args: string[]) =>
		run("git", args, { cwd }).then(
			() => true,
			() => false,
		);
	if (!(await ok(["rev-parse", "--git-dir"]))) return "none";
	if (await ok(["ls-files", "--error-unmatch", "--", file])) return "tracked";
	if (await ok(["check-ignore", "-q", "--", file])) return "ignored";
	return "untracked";
}
