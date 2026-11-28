import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { t } from "../shared/i18n.ts";
import type {
	DiffLine,
	GitArea,
	GitCommit,
	GitCommitDetail,
	GitCommitFile,
	GitDiff,
	GitFile,
	GitHistory,
	GitHistoryCommit,
	GitRef,
	GitStatus,
	ProjectFile,
	ProjectTree,
} from "../shared/protocol.ts";

/** Diffs bigger than this are listed without lines, like the Changes panel's. */
const MAX_DIFF_BYTES = 512 * 1024;

/** A repository with more changed files than this lists only the first ones. */
const MAX_FILES = 1000;

/** Commits listed each way between a branch and its upstream; the counts say how many more there are. */
const MAX_COMMITS = 5;

/** The most commits the History view reads at once, however far back it has gone. */
const MAX_HISTORY = 5000;

/** Room for the output of a long history, or of a commit that touched many files. */
const LARGE_OUTPUT = 64 * 1024 * 1024;

/** A commit id as git prints it in full. */
const FULL_ID = /^[0-9a-f]{40,64}$/i;

/** The tree of a repository with no files, to compare a first commit with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Bytes of an untracked file checked for a NUL byte, as git does, to tell binary from text. */
const BINARY_PROBE = 8000;

/**
 * Runs git in `cwd`. GIT_OPTIONAL_LOCKS=0 keeps status from refreshing the index, so reading never
 * takes index.lock while the agent runs git commands of its own.
 */
export function git(
	cwd: string,
	args: string[],
	maxBuffer = 16 * 1024 * 1024,
	options: { env?: Record<string, string>; timeout?: number } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-c", "core.quotepath=false", "--literal-pathspecs", ...args],
			{ cwd, encoding: "utf8", maxBuffer, windowsHide: true, timeout: options.timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env } },
			// What git printed on stderr says why it failed, without the command line Node's message starts with.
			(error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)),
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
export function parseStatus(text: string, root: string, limit = MAX_FILES): GitStatus {
	const status: GitStatus = { root, branch: null, head: null, ahead: 0, behind: 0, files: [], truncated: false };
	const records = text.split("\0");
	const add = (file: Omit<GitFile, "path">) => {
		if (status.files.length >= limit) status.truncated = true;
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

/** Reads `git log --format=%h%x00%s`: one commit per line, its short id and subject split by a NUL. */
export function parseLog(text: string): GitCommit[] {
	return text
		.split("\n")
		.filter((line) => line.includes("\0"))
		.map((line) => {
			const [id = "", subject = ""] = line.split("\0");
			return { id, subject: subject.trimEnd() };
		});
}

/** The newest commits in `range`, or none when git cannot list them. */
async function commits(root: string, range: string): Promise<GitCommit[]> {
	try {
		return parseLog(await git(root, ["log", "--no-color", "--format=%h%x00%s", `-n${MAX_COMMITS}`, range, "--"]));
	} catch {
		return [];
	}
}

/** The top folder of the repository `cwd` is in and the git folder its worktrees share, or null when it is in none or git is missing. */
export async function repoDirs(cwd: string): Promise<{ root: string; gitDir: string } | null> {
	try {
		// git prints forward slashes, even on Windows, and the common folder relative to `cwd`.
		const [top = "", common = ".git"] = (await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"])).trim().split(/\r?\n/);
		return { root: resolve(top), gitDir: resolve(cwd, common) };
	} catch {
		return null;
	}
}

/** What git has uncommitted in the repository `cwd` is in, and the commit it is at. */
export interface Dirty {
	/** Every file changed, staged, untracked or in conflict, by its path from the repository's top folder as git prints it. */
	files: Set<string>;
	/** The commit HEAD is at, in full, or null before the first one. */
	head: string | null;
}

/** Reads that in one git call, without the upstream's commits. Null when `cwd` is in no repository or git is missing. */
export async function readDirty(cwd: string): Promise<Dirty | null> {
	let text: string;
	try {
		// Paths come out relative to the top folder wherever in the repository this runs.
		text = await git(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], LARGE_OUTPUT);
	} catch {
		return null;
	}
	const files = new Set<string>();
	for (const file of parseStatus(text, "", Infinity).files) {
		files.add(file.rel);
		if (file.from) files.add(file.from);
	}
	return { files, head: /(?:^|\0)# branch\.oid ([0-9a-f]{40,64})\0/.exec(text)?.[1] ?? null };
}

/**
 * The branch and changed files of the repository `cwd` is in, or null when it is in none or git is missing.
 * With an upstream, also the commits each way between them, and when the remote was last fetched.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
	const dirs = await repoDirs(cwd);
	if (!dirs) return null;
	const { root, gitDir } = dirs;
	const text = await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	const status = parseStatus(text, root);
	if (!status.upstream) return status;
	const [outgoing, incoming, fetched] = await Promise.all([
		status.ahead ? commits(root, "@{upstream}..HEAD") : [],
		status.behind ? commits(root, "HEAD..@{upstream}") : [],
		stat(join(gitDir, "FETCH_HEAD")).catch(() => undefined),
	]);
	if (outgoing.length) status.outgoing = outgoing;
	if (incoming.length) status.incoming = incoming;
	if (fetched) status.fetchedAt = Math.round(fetched.mtimeMs);
	return status;
}

/** Reads a `%D` decoration printed with --decorate=full. The remote's own HEAD says nothing a branch's name doesn't. */
export function parseRefs(text: string): GitRef[] {
	const refs: GitRef[] = [];
	for (const part of text.split(", ")) {
		const current = part.startsWith("HEAD -> ");
		const name = current ? part.slice(8) : part.replace(/^tag: /, "");
		if (name === "HEAD") refs.push({ name, kind: "head" });
		else if (name.startsWith("refs/heads/")) refs.push({ name: name.slice(11), kind: "branch", ...(current ? { current } : {}) });
		else if (name.startsWith("refs/tags/")) refs.push({ name: name.slice(10), kind: "tag" });
		else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD")) refs.push({ name: name.slice(13), kind: "remote" });
	}
	return refs;
}

/** Reads `git log --format=%H%x00%P%x00%an%x00%at%x00%D%x00%s`: one commit per line. */
export function parseHistory(text: string): GitHistoryCommit[] {
	return text
		.split("\n")
		.filter((line) => line.includes("\0"))
		.map((line) => {
			const [id = "", parents = "", author = "", time = "0", refs = "", subject = ""] = line.split("\0");
			return {
				id,
				parents: parents ? parents.split(" ") : [],
				author,
				time: Number(time) * 1000,
				refs: parseRefs(refs),
				subject: subject.trimEnd(),
			};
		});
}

/** Reads `git log --raw --numstat -z` for one commit: a raw record per file, then a count per file. */
export function parseCommitFiles(text: string): GitCommitFile[] {
	const files: GitCommitFile[] = [];
	const counts = new Map<string, { adds: number; dels: number }>();
	const records = text.split("\0");
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!.trimStart();
		if (record.startsWith(":")) {
			const letter = record.split(" ")[4]?.[0] ?? "";
			const from = letter === "R" || letter === "C" ? records[++index] : undefined;
			const rel = records[++index] ?? "";
			files.push({ rel, ...(from ? { from } : {}), status: STATUS[letter] ?? "modified", adds: 0, dels: 0 });
			continue;
		}
		const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);
		if (!match) continue;
		// A rename's count has no path of its own: the old and new ones are the next two records.
		if (!match[3]) index += 2;
		const rel = match[3] || records[index] || "";
		// A binary file counts as "-", which is no lines either way.
		counts.set(rel, { adds: Number(match[1]) || 0, dels: Number(match[2]) || 0 });
	}
	return files.map((file) => ({ ...file, ...counts.get(file.rel) }));
}

/** The repository `cwd` is in, or null when it is in none or git is missing. */
async function repoRoot(cwd: string): Promise<string | null> {
	try {
		return resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
	} catch {
		return null;
	}
}

/** The commit HEAD is at, or null outside a repository and before the first commit. */
export async function readHead(cwd: string): Promise<string | null> {
	try {
		return (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim() || null;
	} catch {
		return null;
	}
}

/**
 * The files under `cwd`, by paths relative to it, that commits since `since` changed and that match HEAD now, so
 * git holds them as they are. With no `since`, every file HEAD has that matches it. Leaves out a file changed
 * again after its commit, and any that no commit touched, however it compares with HEAD.
 */
export async function committedSince(cwd: string, since: string | null, head: string): Promise<string[]> {
	const names = async (...revisions: string[]) =>
		(await git(cwd, ["diff", "--name-only", "-z", "--relative", "--no-renames", ...revisions, "--"], LARGE_OUTPUT)).split("\0").filter(Boolean);
	// One at a time: `since` may be gone, and a failure here must not leave the other git still running in the folder.
	const changed = await names(since ?? EMPTY_TREE, head);
	const different = new Set(await names("HEAD"));
	return changed.filter((file) => !different.has(file));
}

/** The repository to read a commit from. Fails unless `id` is a full id, so nothing else reaches git as a revision or an option. */
async function commitRepo(cwd: string, id: string): Promise<string> {
	const root = FULL_ID.test(id) ? await repoRoot(cwd) : null;
	if (!root) throw new Error(t("That commit is not in this repository."));
	return root;
}

/**
 * The newest commits of every branch, remote branch and tag, and of HEAD when it is detached, children before
 * their parents as the graph needs them. Empty outside a repository and before the first commit.
 */
export async function readGitHistory(cwd: string, limit: number): Promise<GitHistory> {
	const root = await repoRoot(cwd);
	if (!root) return { commits: [], more: false };
	if (!(await readHead(root))) return { commits: [], more: false };
	const count = Math.min(Math.max(1, Math.floor(limit)), MAX_HISTORY);
	const format = "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s";
	const text = await git(root, ["log", "--no-color", "--topo-order", "--decorate=full", format, `-n${count + 1}`, "--branches", "--remotes", "--tags", "HEAD", "--"], LARGE_OUTPUT);
	const commits = parseHistory(text);
	return { commits: commits.slice(0, count), more: commits.length > count };
}

/** A commit's message below its subject, and the files it changed against its first parent, which is what a merge brought in. */
export async function readGitCommit(cwd: string, id: string): Promise<GitCommitDetail> {
	const root = await commitRepo(cwd, id);
	const [message, changed] = await Promise.all([
		git(root, ["log", "-1", "--no-color", "--format=%b", id, "--"]),
		git(root, ["-c", "log.showroot=true", "log", "-1", "-m", "--first-parent", "-M", "--raw", "--numstat", "-z", "--format=", id, "--"], LARGE_OUTPUT),
	]);
	const files = parseCommitFiles(changed);
	const session = sessionOfMessage(message);
	const body = message.replace(new RegExp(`^${SESSION_TRAILER}:.*$`, "gm"), "").trim();
	return { body, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES, ...(session ? { session } : {}) };
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
	return boundedDiff(root, args[file.area]);
}

/** What a commit changed in one file, against its first parent. A rename needs both paths, or git sees a new file. */
export async function readGitCommitDiff(cwd: string, id: string, file: Pick<GitCommitFile, "rel" | "from">): Promise<GitDiff> {
	const root = await commitRepo(cwd, id);
	const paths = [...(file.from ? [file.from] : []), file.rel];
	return boundedDiff(root, ["-c", "log.showroot=true", "show", "--format=", "-m", "--first-parent", "--no-color", "--no-ext-diff", "-U3", "-M", id, "--", ...paths]);
}

/** Runs a diff command and parses it, or says it is too large to show. */
async function boundedDiff(root: string, args: string[]): Promise<GitDiff> {
	let text: string;
	try {
		text = await git(root, args, MAX_DIFF_BYTES * 2);
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { ...parseDiff(""), tooLarge: true };
		throw error;
	}
	if (text.length > MAX_DIFF_BYTES) return { ...parseDiff(""), tooLarge: true };
	return parseDiff(text);
}

/** Most files the Files tab lists; a bigger tree says it shows the first ones. */
const MAX_TREE_FILES = 20000;

/** Bigger files are not read into the Files tab. */
const MAX_READ_BYTES = 512 * 1024;

/** How long pushing, pulling and fetching may take before they give up. */
const NETWORK_TIMEOUT = 120_000;

/** Git asks no questions on a terminal it does not have: a missing credential fails instead of hanging. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

/** The trailer a commit names its Trivium session by. */
export const SESSION_TRAILER = "Trivium-Session";

/** Puts the files in the index as they are now, deletions too. */
export async function stageFiles(root: string, rels: string[]): Promise<void> {
	if (rels.length) await git(root, ["add", "-A", "--", ...rels]);
}

/** Takes the files out of the index again, keeping their changes. Before the first commit there is no HEAD to go back to. */
export async function unstageFiles(root: string, rels: string[]): Promise<void> {
	if (!rels.length) return;
	if (await readHead(root)) await git(root, ["restore", "--staged", "--", ...rels]);
	else await git(root, ["rm", "--cached", "-r", "-q", "--", ...rels]);
}

/**
 * Throws away the files' changes in the working tree: a tracked file goes back to what the index holds, and an
 * untracked one is deleted. Staged changes stay.
 */
export async function discardFiles(root: string, files: Pick<GitFile, "rel" | "area">[]): Promise<void> {
	const tracked = files.filter((file) => file.area === "unstaged").map((file) => file.rel);
	const untracked = files.filter((file) => file.area === "untracked").map((file) => file.rel);
	if (tracked.length) await git(root, ["restore", "--worktree", "--", ...tracked]);
	await Promise.all(untracked.map((rel) => rm(join(root, rel), { recursive: true, force: true })));
}

/** A commit message with the session's trailer below it, unless the message already names one. */
export function withSessionTrailer(message: string, sessionId: string | undefined): string {
	const text = message.trim();
	if (!sessionId || new RegExp(`^${SESSION_TRAILER}:`, "m").test(text)) return text;
	return `${text}\n\n${SESSION_TRAILER}: ${sessionId}`;
}

/** The session a commit message names in its trailer, if it names one. */
export function sessionOfMessage(body: string): string | undefined {
	return new RegExp(`^${SESSION_TRAILER}:\\s*(\\S+)\\s*$`, "m").exec(body)?.[1];
}

/**
 * Commits what is staged, or every change when `all` is set. Amending replaces the last commit, keeping its
 * message when no new one is given.
 */
export async function commitChanges(root: string, options: { message: string; all?: boolean; amend?: boolean }): Promise<void> {
	const message = options.message.trim();
	if (!message && !options.amend) throw new Error(t("Write a commit message first."));
	if (options.all) await git(root, ["add", "-A"]);
	await git(root, ["commit", "--quiet", ...(options.amend ? ["--amend"] : []), ...(message ? ["-m", message] : ["--no-edit"])]);
}

/** Undoes the last commit, keeping its changes staged. The first commit has no parent to go back to. */
export async function undoLastCommit(root: string): Promise<void> {
	try {
		await git(root, ["rev-parse", "--verify", "--quiet", "HEAD~1"]);
	} catch {
		throw new Error(t("The first commit can't be undone."));
	}
	await git(root, ["reset", "--soft", "HEAD~1"]);
}

/** Pushes the branch. One with no upstream yet gets one on the only remote, or on origin. */
export async function pushBranch(root: string): Promise<void> {
	const status = parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z"]), root);
	if (!status.branch) throw new Error(t("Check out a branch before pushing."));
	if (status.upstream) {
		await git(root, ["push", "--quiet"], undefined, { env: NO_PROMPT, timeout: NETWORK_TIMEOUT });
		return;
	}
	const remotes = (await git(root, ["remote"])).split(/\r?\n/).filter(Boolean);
	const remote = remotes.length === 1 ? remotes[0]! : remotes.includes("origin") ? "origin" : undefined;
	if (!remote) throw new Error(t("This repository has no remote to push to."));
	await git(root, ["push", "--quiet", "--set-upstream", remote, status.branch], undefined, { env: NO_PROMPT, timeout: NETWORK_TIMEOUT });
}

/** Brings in the upstream's commits when they apply without a merge. */
export async function pullBranch(root: string): Promise<void> {
	await git(root, ["pull", "--quiet", "--ff-only"], undefined, { env: NO_PROMPT, timeout: NETWORK_TIMEOUT });
}

/** Reads what the remotes have, without changing any branch. */
export async function fetchRemotes(root: string): Promise<void> {
	await git(root, ["fetch", "--quiet", "--all"], undefined, { env: NO_PROMPT, timeout: NETWORK_TIMEOUT });
}

/** The branch checked out in the repository `cwd` is in, "" when HEAD is detached, or null when it is in none or git is missing. */
export async function readBranch(cwd: string): Promise<string | null> {
	if (!(await repoRoot(cwd))) return null;
	try {
		return (await git(cwd, ["branch", "--show-current"])).trim();
	} catch {
		return "";
	}
}

/** What git said on stderr when it failed, else the error's own message. */
function gitError(error: unknown): Error {
	const stderr = (error as { stderr?: string }).stderr?.trim();
	return new Error(stderr || (error instanceof Error ? error.message : String(error)));
}

/**
 * Checks out `branch`, new from HEAD, in a worktree of its own beside the repository, in `<repo>.worktrees/`.
 * Returns the folder in it that matches `cwd`, which may be below the repository's top folder.
 */
export async function addWorktree(cwd: string, branch: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (!root) throw new Error(t("This folder is not in a git repository."));
	let name: string;
	try {
		name = (await git(root, ["check-ref-format", "--branch", branch.trim()])).trim();
	} catch {
		throw new Error(t("“{branch}” is not a valid branch name.", { branch: branch.trim() }));
	}
	const parent = join(dirname(root), `${basename(root)}.worktrees`);
	const slug = name.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "worktree";
	let target = join(parent, slug);
	for (let n = 2; existsSync(target); n++) target = join(parent, `${slug}-${n}`);
	try {
		await git(root, ["worktree", "add", "--quiet", "-b", name, target, "HEAD"]);
	} catch (error) {
		throw gitError(error);
	}
	return join(target, relative(root, resolve(cwd)));
}

/** Makes `cwd` a repository. */
export async function initRepo(cwd: string): Promise<void> {
	await git(cwd, ["init", "--quiet"]);
}

/** Reads a text file, unless it is too large or binary. */
export async function readProjectFile(path: string): Promise<ProjectFile> {
	const info = await stat(path);
	if (info.isDirectory()) throw new Error(t("That is a folder, not a file."));
	if (info.size > MAX_READ_BYTES) return { text: null, binary: false, tooLarge: true };
	const buffer = await readFile(path);
	if (buffer.subarray(0, BINARY_PROBE).includes(0)) return { text: null, binary: true, tooLarge: false };
	return { text: buffer.toString("utf8"), binary: false, tooLarge: false };
}

/** A file's text as a commit had it. */
export async function readFileAtCommit(cwd: string, id: string, rel: string): Promise<ProjectFile> {
	const root = await commitRepo(cwd, id);
	let text: string;
	try {
		text = await git(root, ["show", `${id}:${rel}`], MAX_READ_BYTES * 2);
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { text: null, binary: false, tooLarge: true };
		throw new Error(t("That file isn't in this commit."));
	}
	if (text.length > MAX_READ_BYTES) return { text: null, binary: false, tooLarge: true };
	if (text.slice(0, BINARY_PROBE).includes("\0")) return { text: null, binary: true, tooLarge: false };
	return { text, binary: false, tooLarge: false };
}

/** Folders a walk outside a repository never goes into. */
const SKIPPED = new Set([".git", "node_modules"]);

/**
 * Every file under `cwd`, by paths relative to it with forward slashes. In a repository, the files git tracks
 * that are on disk and the untracked ones it does not ignore; with `ignored`, also what it ignores, by top folder,
 * folders ending in a slash. Outside one, a walk of the folder.
 */
export async function listProjectFiles(cwd: string, options: { ignored?: boolean } = {}): Promise<ProjectTree> {
	const split = (text: string) => text.split("\0").filter(Boolean);
	if (await repoRoot(cwd)) {
		const [listed, deleted, ignored] = await Promise.all([
			git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], LARGE_OUTPUT).then(split),
			git(cwd, ["ls-files", "-z", "--deleted"], LARGE_OUTPUT).then(split),
			options.ignored ? git(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], LARGE_OUTPUT).then(split) : [],
		]);
		// A deleted file stays in the index until it is committed; the tab lists what is on disk.
		const gone = new Set(deleted);
		const files = [...new Set(listed)].filter((rel) => !gone.has(rel));
		return { files: files.slice(0, MAX_TREE_FILES), ignored, truncated: files.length > MAX_TREE_FILES, git: true };
	}
	const files: string[] = [];
	let truncated = false;
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (files.length >= MAX_TREE_FILES) {
				truncated = true;
				return;
			}
			const rel = prefix + entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED.has(entry.name)) await walk(join(dir, entry.name), `${rel}/`);
			} else if (entry.isFile()) files.push(rel);
		}
	};
	await walk(cwd, "");
	return { files, ignored: [], truncated, git: false };
}

/** What a commit message is drafted from: the staged diff, or every change when nothing is staged, cut when long; and recent subjects. */
export async function draftSource(root: string, limit = 24_000): Promise<{ diff: string; subjects: string[] }> {
	const head = await readHead(root);
	let diff = await git(root, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U2"], LARGE_OUTPUT);
	if (!diff.trim()) {
		const tracked = await git(root, ["diff", "--no-color", "--no-ext-diff", "-U2", ...(head ? ["HEAD"] : [])], LARGE_OUTPUT);
		const untracked = (await git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
		diff = tracked + (untracked.length ? `\nNew files:\n${untracked.map((rel) => `  ${rel}`).join("\n")}\n` : "");
	}
	const subjects = head ? (await git(root, ["log", "-n10", "--no-color", "--format=%s"])).split(/\r?\n/).filter(Boolean) : [];
	return { diff: diff.length > limit ? `${diff.slice(0, limit)}\n[diff cut short]` : diff, subjects };
}
