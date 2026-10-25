import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { diffLines as lineParts, structuredPatch } from "diff";
import type { DiffLine, FileChange, FileReview, ReviewSegment } from "../shared/protocol.ts";

/** Files bigger than this are listed without a diff. */
const MAX_DIFF_BYTES = 512 * 1024;

/** Resolves a tool path the way pi's edit and write tools do: strip a leading @, expand ~, then resolve against cwd. */
export function resolveToolPath(path: string, cwd: string): string {
	let value = path.startsWith("@") ? path.slice(1) : path;
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}

async function readOrNull(path: string): Promise<string | null> {
	return existsSync(path) ? await readFile(path, "utf8") : null;
}

function diffLines(rel: string, before: string, after: string): DiffLine[] {
	const patch = structuredPatch(rel, rel, before, after, undefined, undefined, { context: 3 });
	const lines: DiffLine[] = [];
	for (const hunk of patch.hunks) {
		lines.push({ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		for (const raw of hunk.lines) {
			const mark = raw[0];
			const text = raw.slice(1);
			if (mark === "+") lines.push({ kind: "add", newNo: newNo++, text });
			else if (mark === "-") lines.push({ kind: "del", oldNo: oldNo++, text });
			else if (mark === " ") lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
		}
	}
	return lines;
}

/**
 * Remembers what each file looked like before the agent first edited or wrote it,
 * so the panel can show the net change and undo it. Baselines persist next to the
 * app's other state, keyed by session, and are dropped on Keep or Revert.
 *
 * Only edit and write are tracked. Changes made through bash are not seen.
 */
export class ChangeTracker {
	private baselines = new Map<string, string | null>();
	/** Folders that did not exist before the agent wrote a file into them, deepest first per file. */
	private createdDirs = new Map<string, string[]>();
	private readonly file: string;
	readonly cwd: string;
	private loaded: Promise<void>;
	private saving = Promise.resolve();

	constructor(file: string, cwd: string) {
		this.file = file;
		this.cwd = cwd;
		this.loaded = this.load();
	}

	private async load(): Promise<void> {
		if (!existsSync(this.file)) return;
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as {
				files: Record<string, string | null>;
				dirs: Record<string, string[]>;
			};
			for (const [path, content] of Object.entries(saved.files)) this.baselines.set(path, content);
			for (const [path, dirs] of Object.entries(saved.dirs)) this.createdDirs.set(path, dirs);
		} catch {
			// A damaged file only loses the undo point; the files themselves are untouched.
		}
	}

	private save(): Promise<void> {
		const contents = JSON.stringify({
			files: Object.fromEntries(this.baselines),
			dirs: Object.fromEntries(this.createdDirs),
		});
		this.saving = this.saving
			.catch(() => {})
			.then(async () => {
				if (this.baselines.size === 0) {
					await rm(this.file, { force: true });
					return;
				}
				await mkdir(dirname(this.file), { recursive: true });
				await writeFile(`${this.file}.tmp`, contents, { mode: 0o600 });
				await rename(`${this.file}.tmp`, this.file);
			});
		return this.saving;
	}

	/** Called before an edit or write runs. Records the file only the first time. */
	async capture(toolPath: string): Promise<void> {
		await this.loaded;
		const path = resolveToolPath(toolPath, this.cwd);
		if (this.baselines.has(path)) return;
		const before = await readOrNull(path);
		this.baselines.set(path, before);
		if (before === null) {
			const missing: string[] = [];
			for (let dir = dirname(path); !existsSync(dir) && dir !== dirname(dir); dir = dirname(dir)) missing.push(dir);
			if (missing.length) this.createdDirs.set(path, missing);
		}
		await this.save();
	}

	async list(): Promise<FileChange[]> {
		await this.loaded;
		const changes: FileChange[] = [];
		for (const [path, before] of this.baselines) {
			const after = await readOrNull(path);
			if (after === before) continue;
			const rel = relative(this.cwd, path);
			const status = before === null ? "added" : after === null ? "deleted" : "modified";
			const tooLarge = (before?.length ?? 0) + (after?.length ?? 0) > MAX_DIFF_BYTES;
			const lines = tooLarge ? [] : diffLines(rel, before ?? "", after ?? "");
			changes.push({
				path,
				rel: rel.startsWith("..") ? path : rel,
				status,
				adds: lines.filter((line) => line.kind === "add").length,
				dels: lines.filter((line) => line.kind === "del").length,
				lines,
				tooLarge,
			});
		}
		return changes.sort((a, b) => a.rel.localeCompare(b.rel));
	}

	has(path: string): boolean {
		return this.baselines.has(path);
	}

	/** The file split into unchanged text and changes, compared paragraph by paragraph with its baseline. */
	async review(path: string): Promise<FileReview> {
		const { segments } = await this.segments(path);
		return {
			path,
			rel: relative(this.cwd, path),
			segments,
			pending: segments.filter((segment) => segment.kind === "change").length,
		};
	}

	private async segments(path: string): Promise<{ segments: ReviewSegment[]; after: string | null }> {
		await this.loaded;
		if (!this.baselines.has(path)) throw new Error("This session did not change that file.");
		const before = this.baselines.get(path) ?? "";
		const after = await readOrNull(path);
		const segments: ReviewSegment[] = [];
		let id = 0;
		for (const part of lineParts(before, after ?? "")) {
			const last = segments.at(-1);
			if (!part.added && !part.removed) {
				segments.push({ kind: "same", text: part.value });
			} else if (last?.kind === "change" && !(part.removed && last.ins)) {
				// A removal followed by an addition is one replacement.
				if (part.added) last.ins += part.value;
				else last.del += part.value;
			} else {
				segments.push({ kind: "change", id: id++, del: part.removed ? part.value : "", ins: part.added ? part.value : "" });
			}
		}
		return { segments, after };
	}

	/**
	 * Accepting a change writes it into the baseline, so it stops showing as a change.
	 * Rejecting it puts the original text back in the file. Other changes are untouched.
	 */
	async resolve(path: string, id: number, action: "accept" | "reject", expect: { del: string; ins: string }): Promise<FileReview> {
		const { segments, after } = await this.segments(path);
		const change = segments.find((segment) => segment.kind === "change" && segment.id === id);
		if (!change || change.kind !== "change" || change.del !== expect.del || change.ins !== expect.ins) {
			throw new Error("The file changed since you opened it. Review it again.");
		}
		const build = (pick: (segment: Extract<ReviewSegment, { kind: "change" }>) => string) =>
			segments.map((segment) => (segment.kind === "same" ? segment.text : pick(segment))).join("");
		if (action === "accept") {
			this.baselines.set(path, build((segment) => (segment === change ? segment.ins : segment.del)));
			await this.save();
		} else {
			const text = build((segment) => (segment === change ? segment.del : segment.ins));
			if (after === null && !text) await rm(path, { force: true });
			else await writeFile(path, text);
		}
		return this.review(path);
	}

	/** Accepts the current content: forgets the baselines. */
	async keep(paths?: string[]): Promise<void> {
		await this.loaded;
		for (const path of paths ?? [...this.baselines.keys()]) {
			this.baselines.delete(path);
			this.createdDirs.delete(path);
		}
		await this.save();
	}

	/** Restores each file to its baseline, deleting files the agent created. */
	async revert(paths?: string[]): Promise<void> {
		await this.loaded;
		for (const path of paths ?? [...this.baselines.keys()]) {
			if (!this.baselines.has(path)) continue;
			const before = this.baselines.get(path)!;
			if (before === null) {
				await rm(path, { force: true });
				// Remove folders the agent created for this file, unless something else now lives there.
				for (const dir of this.createdDirs.get(path) ?? []) await rmdir(dir).catch(() => {});
			} else {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, before);
			}
			this.baselines.delete(path);
			this.createdDirs.delete(path);
		}
		await this.save();
	}
}
