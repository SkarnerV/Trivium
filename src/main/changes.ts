import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { diffLines as lineParts, structuredPatch } from "diff";
import type { DiffLine, FileChange, FileReview, ReviewSegment } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { committedSince, type Dirty, readDirty, readHead } from "./git.ts";
import { ShadowRepo } from "./snapshots.ts";

/** Files bigger than this are listed without a diff. */
const MAX_DIFF_BYTES = 512 * 1024;

/** A command's change to a text file no bigger than this is kept in the session's record; anything else as a file beside it. */
const MAX_INLINE_BYTES = 1024 * 1024;

/** The most files one command adds to the session's list. One that rewrites more leaves the rest to git. */
const MAX_COMMAND_FILES = 2000;

/** Bytes checked for a NUL byte, as git does, to tell binary from text. */
const BINARY_PROBE = 8000;

/**
 * What a file held before the session changed it: its text, nothing because it did not exist, or bytes kept in a
 * file of their own, for a file that is binary, not UTF-8 or large.
 */
type Baseline = string | null | { blob: string; binary: boolean };

const isBlob = (baseline: Baseline | undefined): baseline is { blob: string; binary: boolean } => typeof baseline === "object" && baseline !== null;

/** Resolves a tool path the way pi's edit and write tools do: strip a leading @, expand ~, then resolve against cwd. */
export function resolveToolPath(path: string, cwd: string): string {
	let value = path.startsWith("@") ? path.slice(1) : path;
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(cwd, value);
}

/** The file's text, or null when there is no file there: it is gone, or a folder took its place. */
async function readOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** A path to compare by: git, the tools and Windows may write the same one with other slashes or case. */
function pathKey(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	return process.platform === "win32" ? slashed.toLowerCase() : slashed;
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
 * Remembers what each file looked like before the agent first changed it, so the panel can show the net change
 * and undo it. Baselines persist next to the app's other state, keyed by session, and are dropped on Keep or
 * Revert, or once the file is committed.
 *
 * An edit or write is recorded as it is made. A command is not known to change anything until it has, so the
 * files are snapshotted before it runs and compared after: see `beforeCommand` and `afterCommand`. That leaves
 * out what git ignores, files over the snapshot's size limit, and anything outside the project.
 */
export class ChangeTracker {
	private baselines = new Map<string, Baseline>();
	/** Folders that did not exist before the agent wrote a file into them, deepest first per file. */
	private createdDirs = new Map<string, string[]>();
	/** Where HEAD was when the first of the baselines was taken, or last checked: commits after it are the session's to clear. */
	private since: string | null = null;
	private readonly file: string;
	/** Where the bytes of baselines too awkward for the record are kept, named by their hash. */
	private readonly blobs: string;
	readonly cwd: string;
	private loaded: Promise<void>;
	private saving = Promise.resolve();
	private readonly shadow: ShadowRepo;
	/** One command's snapshot or comparison at a time. */
	private commands: Promise<unknown> = Promise.resolve();
	/** What git had uncommitted at the last snapshot, and when that was. */
	private before: { dirty: Dirty | null; at: number } = { dirty: null, at: 0 };
	private readonly onOff?: () => void;
	private told = false;

	/** `onOff` is called once if the project turns out too large to snapshot, which the user should hear. */
	constructor(file: string, cwd: string, onOff?: () => void) {
		this.file = file;
		this.cwd = cwd;
		this.onOff = onOff;
		const stem = file.replace(/\.json$/, "");
		this.blobs = `${stem}.blobs`;
		this.shadow = new ShadowRepo(`${stem}.git`, cwd);
		this.loaded = this.load();
	}

	private async load(): Promise<void> {
		if (!existsSync(this.file)) return;
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as {
				files: Record<string, Baseline>;
				dirs: Record<string, string[]>;
				since?: string | null;
			};
			this.since = saved.since ?? null;
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
			since: this.since,
		});
		this.saving = this.saving
			.catch(() => {})
			.then(async () => {
				if (this.baselines.size === 0) {
					await rm(this.file, { force: true });
					await rm(this.blobs, { recursive: true, force: true });
					return;
				}
				await mkdir(dirname(this.file), { recursive: true });
				await writeFile(`${this.file}.tmp`, contents, { mode: 0o600 });
				await rename(`${this.file}.tmp`, this.file);
				// Kept bytes that no baseline names any more.
				const named = new Set([...this.baselines.values()].filter(isBlob).map((baseline) => baseline.blob));
				for (const name of await readdir(this.blobs).catch(() => [])) {
					if (!named.has(name)) await rm(join(this.blobs, name), { force: true });
				}
			});
		return this.saving;
	}

	/** Called before an edit or write runs. Records the file only the first time. */
	async capture(toolPath: string): Promise<void> {
		await this.loaded;
		const path = resolveToolPath(toolPath, this.cwd);
		if (this.baselines.has(path)) return;
		if (!this.baselines.size) this.since = await readHead(this.cwd);
		const before = await readOrNull(path);
		this.baselines.set(path, before);
		if (before === null) {
			const missing: string[] = [];
			for (let dir = dirname(path); !existsSync(dir) && dir !== dirname(dir); dir = dirname(dir)) missing.push(dir);
			if (missing.length) this.createdDirs.set(path, missing);
		}
		await this.save();
	}

	/**
	 * Called before a command that may change files runs: snapshots the project, and notes what git has uncommitted.
	 * Never fails; a project that cannot be snapshotted only goes without.
	 */
	beforeCommand(): Promise<void> {
		const step = this.commands.then(async () => {
			await this.loaded;
			const [, dirty] = await Promise.all([this.shadow.sync(), readDirty(this.cwd)]);
			this.before = { dirty, at: Date.now() };
			if (this.shadow.off === "size" && !this.told) {
				this.told = true;
				this.onOff?.();
			}
		});
		this.commands = step.catch(() => {});
		return this.commands.then(() => {});
	}

	/**
	 * Called after it: records each file that differs from the snapshot and is not recorded yet, with what the
	 * snapshot held as its baseline. Says whether it recorded any.
	 *
	 * In a repository, a file git had clean before the command and has clean after it is left out: a checkout, pull
	 * or commit moved it with HEAD, and git holds both versions. A file that was dirty is kept even when the command
	 * left it clean, since that is uncommitted work the command threw away.
	 */
	afterCommand(): Promise<boolean> {
		const step = this.commands.then(() => this.adopt());
		this.commands = step.catch(() => {});
		return step.catch(() => false);
	}

	private async adopt(): Promise<boolean> {
		const [changed, after] = await Promise.all([this.shadow.changed(), readDirty(this.cwd)]);
		if (!changed?.length) return false;
		const { dirty: before, at } = this.before;
		const known = new Set([...this.baselines.keys()].map(pathKey));
		const dirtyBefore = before && new Set([...before.files].map(pathKey));
		const dirtyAfter = after && new Set([...after.files].map(pathKey));
		const mine = changed
			.filter((change) => !known.has(pathKey(change.path)))
			.filter((change) => !dirtyBefore || !dirtyAfter || dirtyBefore.has(pathKey(change.rel)) || dirtyAfter.has(pathKey(change.rel)))
			.slice(0, MAX_COMMAND_FILES);
		if (!mine.length) return false;
		const contents = await this.shadow.contents(mine.filter((change) => change.status !== "added").map((change) => change.rel));
		const top = pathKey(resolve(this.cwd));
		let recorded = 0;
		for (const change of mine) {
			let baseline: Baseline;
			if (change.status === "added") {
				// Only a file: a link or a folder has nothing of its own to show or remove.
				if (!(await lstat(change.path).catch(() => undefined))?.isFile()) continue;
				baseline = null;
			} else {
				const bytes = contents.get(change.rel);
				// Too large to have been kept. In a repository git still lists it.
				if (!bytes) continue;
				baseline = await this.baselineOf(bytes);
			}
			// The session's changes are counted from the commit before the command, which may have committed.
			if (!this.baselines.size) this.since = before ? before.head : await readHead(this.cwd);
			this.baselines.set(change.path, baseline);
			if (baseline === null) {
				// A folder made since the snapshot was made for this file, or for others the command wrote.
				const made: string[] = [];
				for (let dir = dirname(change.path); dir !== dirname(dir) && pathKey(dir) !== top; dir = dirname(dir)) {
					const born = (await stat(dir).catch(() => undefined))?.birthtimeMs;
					if (born === undefined || born < at) break;
					made.push(dir);
				}
				if (made.length) this.createdDirs.set(change.path, made);
			}
			recorded++;
		}
		if (recorded) await this.save();
		return recorded > 0;
	}

	/** Text that survives being read as UTF-8 goes in the record, as an edit's does. Other bytes go in a file named by their hash. */
	private async baselineOf(bytes: Buffer): Promise<Baseline> {
		const binary = bytes.subarray(0, BINARY_PROBE).includes(0);
		if (!binary && bytes.length <= MAX_INLINE_BYTES) {
			const text = bytes.toString("utf8");
			if (Buffer.from(text, "utf8").equals(bytes)) return text;
		}
		const blob = createHash("sha256").update(bytes).digest("hex");
		await mkdir(this.blobs, { recursive: true });
		if (!existsSync(join(this.blobs, blob))) await writeFile(join(this.blobs, blob), bytes, { mode: 0o600 });
		return { blob, binary };
	}

	/** Whether the file holds the kept bytes; null when it is gone. */
	private async matchesBlob(path: string, blob: string): Promise<boolean | null> {
		const [now, kept] = await Promise.all([stat(path).catch(() => undefined), stat(join(this.blobs, blob)).catch(() => undefined)]);
		if (!now?.isFile()) return null;
		if (!kept || now.size !== kept.size) return false;
		const [a, b] = await Promise.all([readFile(path), readFile(join(this.blobs, blob))]);
		return a.equals(b);
	}

	async list(): Promise<FileChange[]> {
		await this.loaded;
		const changes: FileChange[] = [];
		for (const [path, before] of this.baselines) {
			const rel = relative(this.cwd, path);
			const shown = rel.startsWith("..") ? path : rel;
			if (isBlob(before)) {
				const same = await this.matchesBlob(path, before.blob);
				if (same) continue;
				changes.push({
					path,
					rel: shown,
					status: same === null ? "deleted" : "modified",
					adds: 0,
					dels: 0,
					lines: [],
					tooLarge: !before.binary,
					...(before.binary ? { binary: true } : {}),
				});
				continue;
			}
			const after = await readOrNull(path);
			if (after === before) continue;
			const status = before === null ? "added" : after === null ? "deleted" : "modified";
			// A command can leave a binary file where an edit never would.
			const binary = [before, after].some((text) => text?.slice(0, BINARY_PROBE).includes("\0"));
			const tooLarge = !binary && (before?.length ?? 0) + (after?.length ?? 0) > MAX_DIFF_BYTES;
			const lines = tooLarge || binary ? [] : diffLines(rel, before ?? "", after ?? "");
			changes.push({
				path,
				rel: shown,
				status,
				adds: lines.filter((line) => line.kind === "add").length,
				dels: lines.filter((line) => line.kind === "del").length,
				lines,
				tooLarge,
				...(binary ? { binary: true } : {}),
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
		if (!this.baselines.has(path)) throw new Error(t("This session did not change that file."));
		const baseline = this.baselines.get(path);
		// Only a command leaves one of these, and only Code runs commands, which shows a diff instead of this.
		if (isBlob(baseline)) throw new Error(t(baseline.binary ? "Binary file." : "This file is too large to show a diff."));
		const before = baseline ?? "";
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
			throw new Error(t("The file changed since you opened it. Review it again."));
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

	/**
	 * Forgets the files committed since the last check, so the session stops listing them and Revert leaves them
	 * alone: git holds them now. Says whether it forgot any. A file changed again after its commit stays.
	 */
	async dropCommitted(): Promise<boolean> {
		await this.loaded;
		if (!this.baselines.size) return false;
		const head = await readHead(this.cwd);
		if (!head || head === this.since) return false;
		// A commit that is gone, as after a rebase and a clean-up, only means nothing more is learned this time.
		const committed = new Set((await committedSince(this.cwd, this.since, head).catch(() => [])).map(pathKey));
		const paths = [...this.baselines.keys()].filter((path) => committed.has(pathKey(relative(this.cwd, path))));
		this.since = head;
		await this.keep(paths);
		return paths.length > 0;
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
				if (isBlob(before)) await copyFile(join(this.blobs, before.blob), path);
				else await writeFile(path, before);
			}
			this.baselines.delete(path);
			this.createdDirs.delete(path);
		}
		await this.save();
	}
}
