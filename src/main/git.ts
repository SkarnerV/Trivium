import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DiffLine, GitArea, GitDiff, GitFile, GitStatus } from "../shared/protocol.ts";

/** Diffs bigger than this are listed without lines, like the Changes panel's. */
const MAX_DIFF_BYTES = 512 * 1024;

/** A repository with more changed files than this lists only the first ones. */
const MAX_FILES = 1000;

/** Bytes of an untracked file checked for a NUL byte, as git does, to tell binary from text. */
const BINARY_PROBE = 8000;

/**
 * Runs git in `cwd`. GIT_OPTIONAL_LOCKS=0 keeps status from refreshing the index, so reading never
 * takes index.lock while the agent runs git commands of its own.
 */
function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "core.quotepath=false", "--literal-pathspecs", ...args],
			{ cwd, encoding: "utf8", maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
}

const STATUS: Record<string, GitFile["status"]> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "typechange",
};

/**
 * Reads `git status --porcelain=v2 --branch -z`. A file staged and then changed again is listed twice,
 * once per area. Paths stay relative to the repository root, as git prints them.
 */
export function parseStatus(text: string, root: string): GitStatus {
	const status: GitStatus = { root, branch: null, head: null, ahead: 0, behind: 0, files: [], truncated: false };
	const records = text.split("\0");
	const add = (file: Omit<GitFile, "path">) => {
		if (status.files.length >= MAX_FILES) status.truncated = true;
		else status.files.push({ ...file, path: join(root, file.rel) });
	};
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (record.startsWith("# branch.oid ")) {
			const oid = record.slice(13);
			status.head = oid === "(initial)" ? null : oid.slice(0, 7);
		} else if (record.startsWith("# branch.head ")) {
			const head = record.slice(14);
			status.branch = head === "(detached)" ? null : head;
		} else if (record.startsWith("# branch.upstream ")) {
			status.upstream = record.slice(18);
		} else if (record.startsWith("# branch.ab ")) {
			const match = /^\+(\d+) -(\d+)$/.exec(record.slice(12));
			if (match) {
				status.ahead = Number(match[1]);
				status.behind = Number(match[2]);
			}
		} else if (record.startsWith("1 ") || record.startsWith("2 ")) {
			// "1 XY sub mH mI mW hH hI path"; a rename or copy ("2") adds a score field, and its old path follows as the next record.
			const fields = record.split(" ");
			const xy = fields[1]!;
			const rel = fields.slice(record.startsWith("1 ") ? 8 : 9).join(" ");
			const from = record.startsWith("2 ") ? records[++index] : undefined;
			const staged = STATUS[xy[0]!];
			const unstaged = STATUS[xy[1]!];
			if (staged) add({ rel, from, area: "staged", status: staged });
			if (unstaged) add({ rel, area: "unstaged", status: unstaged });
		} else if (record.startsWith("u ")) {
			add({ rel: record.split(" ").slice(10).join(" "), area: "conflicted", status: "conflicted" });
		} else if (record.startsWith("? ")) {
			add({ rel: record.slice(2), area: "untracked", status: "untracked" });
		}
	}
	return status;
}

/** The branch and changed files of the repository `cwd` is in, or null when it is in none or git is missing. */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
	let root: string;
	try {
		// git prints forward slashes, even on Windows.
		root = resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
	} catch {
		return null;
	}
	const text = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	return parseStatus(text, root);
}

/** Turns `git diff` output for one file into the lines the diff view shows. */
export function parseDiff(text: string): GitDiff {
	const diff: GitDiff = { lines: [], adds: 0, dels: 0, tooLarge: false, binary: false };
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	for (const raw of text.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			inHunk = true;
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[3]);
			diff.lines.push({ kind: "hunk", text: hunk[0] });
		} else if (!inHunk) {
			if (/^Binary files .* differ$/.test(line)) diff.binary = true;
		} else if (line.startsWith("+")) {
			diff.lines.push({ kind: "add", newNo: newNo++, text: line.slice(1) });
			diff.adds++;
		} else if (line.startsWith("-")) {
			diff.lines.push({ kind: "del", oldNo: oldNo++, text: line.slice(1) });
			diff.dels++;
		} else if (line.startsWith(" ")) {
			diff.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
		} else if (line.startsWith("diff ")) {
			// The next file's header: only one file was asked for, but stop rather than misread it.
			break;
		}
	}
	return diff;
}

/** An untracked file shown as all added, since git has nothing to compare it with. */
async function untrackedDiff(path: string): Promise<GitDiff> {
	const empty: GitDiff = { lines: [], adds: 0, dels: 0, tooLarge: false, binary: false };
	const info = await stat(path);
	if (info.isDirectory()) return empty;
	if (info.size > MAX_DIFF_BYTES) return { ...empty, tooLarge: true };
	const buffer = await readFile(path);
	if (buffer.subarray(0, BINARY_PROBE).includes(0)) return { ...empty, binary: true };
	const text = buffer.toString("utf8");
	if (!text) return empty;
	const rows = text.split(/\r?\n/);
	if (rows.at(-1) === "") rows.pop();
	const lines: DiffLine[] = [{ kind: "hunk", text: `@@ -0,0 +1,${rows.length} @@` }];
	rows.forEach((row, index) => lines.push({ kind: "add", newNo: index + 1, text: row }));
	return { ...empty, lines, adds: rows.length };
}

/**
 * One file's diff in one area: staged is the index against HEAD, unstaged the working tree against the
 * index, and a conflicted file the working tree, markers and all, against HEAD.
 */
export async function readGitDiff(root: string, file: Pick<GitFile, "rel" | "from" | "area">): Promise<GitDiff> {
	if (file.area === "untracked") return untrackedDiff(join(root, file.rel));
	const base = ["diff", "--no-color", "--no-ext-diff", "-U3"];
	const args: Record<GitArea, string[]> = {
		staged: [...base, "--cached", "-M", "--", ...(file.from ? [file.from] : []), file.rel],
		unstaged: [...base, "--", file.rel],
		conflicted: [...base, "HEAD", "--", file.rel],
		untracked: [],
	};
	let text: string;
	try {
		text = await git(root, args[file.area], MAX_DIFF_BYTES * 2);
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { ...parseDiff(""), tooLarge: true };
		throw error;
	}
	if (text.length > MAX_DIFF_BYTES) return { ...parseDiff(""), tooLarge: true };
	return parseDiff(text);
}
