import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { git, readHead, repoDirs } from "./git.ts";

/** A file bigger than this is never copied, so a command's change to it is not recorded. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** New files one sync may copy. More than this and the folder is not one to snapshot. */
const MAX_SYNC_BYTES = 200 * 1024 * 1024;
const MAX_SYNC_FILES = 50_000;

/** The contents read back for one command. */
const MAX_READ_BYTES = 64 * 1024 * 1024;

const LIST_TIMEOUT_MS = 10_000;
const ADD_TIMEOUT_MS = 60_000;
const LARGE_OUTPUT = 64 * 1024 * 1024;

/**
 * No line-ending conversion, filters or keyword expansion, whatever the project's .gitattributes say: the copy
 * kept must be the file's bytes, or a revert would rewrite a CRLF file. This file outranks every .gitattributes.
 */
const ATTRIBUTES = "* -text -filter -ident !working-tree-encoding\n";

const CONFIG = "[core]\n\tautocrlf = false\n\tsafecrlf = false\n\tfilemode = false\n\tlongpaths = true\n\tfsmonitor = false\n[gc]\n\tauto = 0\n";

export interface ShadowChange {
	/** Path from the work tree's top folder, as git prints it. */
	rel: string;
	/** Absolute path, under the session's own folder as the session spells it. */
	path: string;
	status: "added" | "modified" | "deleted";
}

/** A line for git's exclude file that matches exactly this path, or nothing when no line can. */
export function excludeLine(rel: string): string {
	if (rel.includes("\n")) return "";
	const escaped = rel.replace(/[\\*?[]/g, "\\$&").replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
	return `/${escaped}\n`;
}

/**
 * Reads `git status --porcelain=v2 -z` taken against the shadow index: what the work tree holds that the index
 * does not. Skips nested repositories and links, which have no bytes of their own to keep.
 */
export function parseChanged(text: string): Array<Pick<ShadowChange, "rel" | "status">> {
	const changes: Array<Pick<ShadowChange, "rel" | "status">> = [];
	for (const record of text.split("\0")) {
		if (record.startsWith("? ")) {
			const rel = record.slice(2);
			if (!rel.endsWith("/")) changes.push({ rel, status: "added" });
		} else if (record.startsWith("1 ")) {
			// "1 XY sub mH mI mW hH hI path": Y is the work tree against the index.
			const fields = record.split(" ");
			const state = fields[1]?.[1];
			if (fields[2]?.startsWith("S") || fields[4] === "120000" || fields[5] === "120000" || fields[4] === "160000") continue;
			const rel = fields.slice(8).join(" ");
			if (state === "M" || state === "T") changes.push({ rel, status: "modified" });
			else if (state === "D") changes.push({ rel, status: "deleted" });
		}
	}
	return changes;
}

/** Reads `git cat-file --batch` output for `names`, in order. A name git has no blob for is left out. */
export function parseBatch(output: Buffer, names: string[]): Map<string, Buffer> {
	const contents = new Map<string, Buffer>();
	let at = 0;
	for (const name of names) {
		const end = output.indexOf(10, at);
		if (end < 0) break;
		const header = output.subarray(at, end).toString("utf8");
		at = end + 1;
		const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
		if (!match) continue;
		const size = Number(match[2]);
		if (match[1] === "blob") contents.set(name, output.subarray(at, at + size));
		at += size + 1;
	}
	return contents;
}

/**
 * A git folder of Trivium's own whose index follows a session's project, to tell what a command changed and keep
 * what the files held before it. It adds and changes nothing in the project's own .git, and never takes its index
 * lock: in a repository it only reads that one's objects, so files git already holds are not copied again. (git
 * does mark an object it finds there as used again, which moves that file's modified time and nothing else.)
 * Ignored files are left out, as git leaves them.
 *
 * `sync` brings the index up to the files as they are; `changed` lists what differs from it since. Anything
 * that goes wrong turns it off for good rather than reaching the command it was called for.
 */
export class ShadowRepo {
	/** Why it stopped, once it has: the folder is too much to copy, or git failed or is missing. */
	off?: "size" | "git";
	private workTree = "";
	/** From the session's folder up to the work tree's top, which git may spell another way than the session does. */
	private up = "";
	private opened?: Promise<void>;
	private readonly gitDir: string;
	private readonly cwd: string;

	constructor(gitDir: string, cwd: string) {
		this.gitDir = gitDir;
		this.cwd = cwd;
	}

	private run(args: string[], options: { timeout?: number; gitDir?: string } = {}): Promise<string> {
		return git(this.workTree, args, LARGE_OUTPUT, {
			timeout: options.timeout ?? ADD_TIMEOUT_MS,
			env: { GIT_DIR: options.gitDir ?? this.gitDir, GIT_WORK_TREE: this.workTree },
		});
	}

	private async open(): Promise<void> {
		const real = await repoDirs(this.cwd);
		this.workTree = real?.root ?? resolve(this.cwd);
		if (real) this.up = relative(await realpath(this.cwd).catch(() => resolve(this.cwd)), real.root);
		// A home folder or a whole drive is not a project.
		if (this.workTree === resolve(homedir()) || dirname(this.workTree) === this.workTree) {
			this.off = "size";
			return;
		}
		if (existsSync(join(this.gitDir, "HEAD"))) {
			// Left by a git that was killed mid-write. Nothing else uses this folder.
			await rm(join(this.gitDir, "index.lock"), { force: true });
			return;
		}
		// Built aside and moved into place whole, so a half-made one is never taken for ready.
		const building = `${this.gitDir}.tmp`;
		await rm(building, { recursive: true, force: true });
		await mkdir(dirname(building), { recursive: true });
		await this.run(["init", "-q"], { gitDir: building });
		await appendFile(join(building, "config"), CONFIG);
		await mkdir(join(building, "info"), { recursive: true });
		await writeFile(join(building, "info", "attributes"), ATTRIBUTES);
		if (real) {
			const exclude = await readFile(join(real.gitDir, "info", "exclude"), "utf8").catch(() => "");
			await writeFile(join(building, "info", "exclude"), exclude && !exclude.endsWith("\n") ? `${exclude}\n` : exclude);
			await mkdir(join(building, "objects", "info"), { recursive: true });
			await writeFile(join(building, "objects", "info", "alternates"), `${join(real.gitDir, "objects").replaceAll("\\", "/")}\n`);
			// Start from what is committed, so only files that differ from it are ever copied.
			const head = await readHead(real.root);
			if (head) await this.run(["read-tree", head], { gitDir: building }).catch(() => {});
		}
		await rename(building, this.gitDir);
	}

	private ready(): Promise<boolean> {
		this.opened ??= this.open().catch(() => {
			this.off ??= "git";
		});
		return this.opened.then(() => !this.off);
	}

	private stop(error: unknown): false {
		const failure = error as { killed?: boolean; code?: unknown };
		// A git that ran out of time or output was given too much to do.
		this.off ??= failure.killed || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "size" : "git";
		return false;
	}

	/**
	 * Records every file as it is now. Files too large to keep are excluded first, and a folder with too much that
	 * is new turns this off. Says whether it is still on.
	 */
	async sync(): Promise<boolean> {
		if (!(await this.ready())) return false;
		try {
			const fresh = (await this.run(["ls-files", "-o", "--exclude-standard", "-z"], { timeout: LIST_TIMEOUT_MS })).split("\0").filter(Boolean);
			if (fresh.length > MAX_SYNC_FILES) {
				this.off = "size";
				return false;
			}
			let total = 0;
			let excluded = "";
			for (let index = 0; index < fresh.length; index += 64) {
				const sizes = await Promise.all(
					fresh.slice(index, index + 64).map(async (rel) => ({ rel, size: (await stat(join(this.workTree, rel)).catch(() => undefined))?.size ?? 0 })),
				);
				for (const { rel, size } of sizes) {
					if (size > MAX_FILE_BYTES) excluded += excludeLine(rel);
					else total += size;
				}
			}
			if (total > MAX_SYNC_BYTES) {
				this.off = "size";
				return false;
			}
			if (excluded) await appendFile(join(this.gitDir, "info", "exclude"), excluded);
			try {
				await this.run(["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors"]);
			} catch (error) {
				// A file that could not be read, such as one another program holds open, is left out; the rest are in.
				if ((error as { code?: unknown }).code !== 1) throw error;
			}
			return true;
		} catch (error) {
			return this.stop(error);
		}
	}

	/** The files that differ from the last sync. Reads only; null when this is off. */
	async changed(): Promise<ShadowChange[] | null> {
		if (!(await this.ready())) return null;
		try {
			const text = await this.run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
			return parseChanged(text).map((change) => ({ ...change, path: resolve(this.cwd, this.up, change.rel) }));
		} catch (error) {
			this.stop(error);
			return null;
		}
	}

	/** What each file held at the last sync, by its `rel`. Leaves out a file over the size limit, and stops at the limit for one command. */
	async contents(rels: string[]): Promise<Map<string, Buffer>> {
		const names = rels.filter((rel) => !rel.includes("\n"));
		if (!names.length || !(await this.ready())) return new Map();
		try {
			const input = (list: string[]) => list.map((rel) => `:${rel}\n`).join("");
			const sizes = (await this.pipe(["cat-file", "--batch-check"], input(names))).toString("utf8").split("\n");
			let total = 0;
			const wanted = names.filter((_, index) => {
				const match = /^[0-9a-f]+ blob (\d+)$/.exec(sizes[index] ?? "");
				if (!match || Number(match[1]) > MAX_FILE_BYTES || total + Number(match[1]) > MAX_READ_BYTES) return false;
				total += Number(match[1]);
				return true;
			});
			if (!wanted.length) return new Map();
			return parseBatch(await this.pipe(["cat-file", "--batch"], input(wanted)), wanted);
		} catch (error) {
			this.stop(error);
			return new Map();
		}
	}

	/** Runs git with `input` on its stdin and gives back its stdout as bytes. */
	private pipe(args: string[], input: string): Promise<Buffer> {
		return new Promise((done, fail) => {
			const child = spawn("git", args, {
				cwd: this.workTree,
				windowsHide: true,
				stdio: ["pipe", "pipe", "ignore"],
				timeout: ADD_TIMEOUT_MS,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workTree },
			});
			const chunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.on("error", fail);
			child.on("close", (code) => (code === 0 ? done(Buffer.concat(chunks)) : fail(new Error(`git ${args[0]} exited with ${code}`))));
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		});
	}
}
