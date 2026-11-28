import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addWorktree,
	commitChanges,
	discardFiles,
	listProjectFiles,
	parseCommitFiles,
	parseDiff,
	parseHistory,
	parseLog,
	parseRefs,
	parseStatus,
	readFileAtCommit,
	readGitCommit,
	readGitCommitDiff,
	readGitDiff,
	readGitHistory,
	readGitStatus,
	readBranch,
	readProjectFile,
	sessionOfMessage,
	stageFiles,
	undoLastCommit,
	unstageFiles,
	withSessionTrailer,
} from "../src/main/git.ts";

/** A repository in a temporary folder with one commit, which git outside it is never asked about. */
function setup() {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-git-")));
	const repo = join(root, "shop");
	mkdirSync(join(repo, "src"), { recursive: true });
	process.env.GIT_CEILING_DIRECTORIES = root;
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd: repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "core.autocrlf", "false");
	writeFileSync(join(repo, "src", "cart.ts"), "export const items = [];\nexport function total() {\n\treturn 0;\n}\n");
	writeFileSync(join(repo, "README.md"), "# Shop\n");
	writeFileSync(join(repo, "old name.txt"), "moved\n");
	git("add", ".");
	git("commit", "-q", "-m", "First");
	return { root, repo, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("porcelain v2 status gives the branch, upstream and each file once per area", () => {
	const text = [
		"# branch.oid 4f2a9c1e0b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f",
		"# branch.head feature/cart",
		"# branch.upstream origin/feature/cart",
		"# branch.ab +2 -1",
		"1 MM N... 100644 100644 100644 aaa bbb src/cart.ts",
		"1 .D N... 100644 100644 000000 aaa aaa README.md",
		"2 R. N... 100644 100644 100644 aaa aaa R100 docs/new name.md",
		"docs/old name.md",
		"u UU N... 100644 100644 100644 100644 aaa bbb ccc src/merge.ts",
		"? notes/todo list.txt",
		"! dist/main.mjs",
		"",
	].join("\0");
	const status = parseStatus(text, "/work/shop");
	assert.equal(status.branch, "feature/cart");
	assert.equal(status.head, "4f2a9c1");
	assert.equal(status.upstream, "origin/feature/cart");
	assert.deepEqual([status.ahead, status.behind], [2, 1]);
	assert.deepEqual(
		status.files.map(({ rel, from, area, status }) => ({ rel, from, area, status })),
		[
			{ rel: "src/cart.ts", from: undefined, area: "staged", status: "modified" },
			{ rel: "src/cart.ts", from: undefined, area: "unstaged", status: "modified" },
			{ rel: "README.md", from: undefined, area: "unstaged", status: "deleted" },
			{ rel: "docs/new name.md", from: "docs/old name.md", area: "staged", status: "renamed" },
			{ rel: "src/merge.ts", from: undefined, area: "conflicted", status: "conflicted" },
			{ rel: "notes/todo list.txt", from: undefined, area: "untracked", status: "untracked" },
		],
	);
	assert.equal(status.files[0]!.path, join("/work/shop", "src/cart.ts"));
	assert.equal(status.truncated, false);
});

test("a detached HEAD has no branch, and a new repository no commit", () => {
	const detached = parseStatus("# branch.oid 0123456789abcdef\0# branch.head (detached)\0", "/r");
	assert.deepEqual([detached.branch, detached.head, detached.upstream], [null, "0123456", undefined]);
	const fresh = parseStatus("# branch.oid (initial)\0# branch.head main\0", "/r");
	assert.deepEqual([fresh.branch, fresh.head], ["main", null]);
});

test("a huge change lists the first thousand files", () => {
	const text = Array.from({ length: 1200 }, (_, index) => `? file${index}.txt`).join("\0");
	const status = parseStatus(text, "/r");
	assert.equal(status.files.length, 1000);
	assert.equal(status.truncated, true);
});

test("a unified diff becomes numbered lines, without its header or CRs", () => {
	const text = [
		"diff --git a/src/cart.ts b/src/cart.ts",
		"index aaa..bbb 100644",
		"--- a/src/cart.ts",
		"+++ b/src/cart.ts",
		"@@ -2,3 +2,3 @@ export const items = [];",
		" export function total() {\r",
		"-\treturn 0;",
		"+\treturn items.length;",
		" }",
		"\\ No newline at end of file",
		"",
	].join("\n");
	const diff = parseDiff(text);
	assert.deepEqual(diff.lines, [
		{ kind: "hunk", text: "@@ -2,3 +2,3 @@" },
		{ kind: "ctx", oldNo: 2, newNo: 2, text: "export function total() {" },
		{ kind: "del", oldNo: 3, text: "\treturn 0;" },
		{ kind: "add", newNo: 3, text: "\treturn items.length;" },
		{ kind: "ctx", oldNo: 4, newNo: 4, text: "}" },
	]);
	assert.deepEqual([diff.adds, diff.dels, diff.binary, diff.tooLarge], [1, 1, false, false]);
	assert.equal(parseDiff("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n").binary, true);
});

test("a folder outside any repository has no git status", async () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-nogit-")));
	process.env.GIT_CEILING_DIRECTORIES = root;
	try {
		mkdirSync(join(root, "plain"));
		assert.equal(await readGitStatus(join(root, "plain")), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a real repository's staged, unstaged, renamed and untracked files, each with its diff", async () => {
	const { repo, git, cleanup } = setup();
	try {
		writeFileSync(join(repo, "src", "cart.ts"), "export const items = [];\nexport function total() {\n\treturn items.length;\n}\n");
		git("add", "src/cart.ts");
		writeFileSync(join(repo, "src", "cart.ts"), "export const items = [];\nexport function total() {\n\treturn items.length;\n}\nexport const empty = false;\n");
		renameSync(join(repo, "old name.txt"), join(repo, "new name.txt"));
		git("add", "-A", "old name.txt", "new name.txt");
		rmSync(join(repo, "README.md"));
		writeFileSync(join(repo, "src", "todo.md"), "- tests\r\n- docs\r\n");
		writeFileSync(join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

		// Asked from a subfolder, paths are still relative to the repository root.
		const status = await readGitStatus(join(repo, "src"));
		assert.ok(status);
		assert.equal(status.branch, "main");
		assert.match(status.head ?? "", /^[0-9a-f]{7}$/);
		assert.equal(realpathSync.native(status.root), repo);
		const summary = status.files.map(({ rel, from, area, status }) => `${area} ${status} ${from ? `${from} -> ` : ""}${rel}`).sort();
		assert.deepEqual(summary, [
			"staged modified src/cart.ts",
			"staged renamed old name.txt -> new name.txt",
			"unstaged deleted README.md",
			"unstaged modified src/cart.ts",
			"untracked untracked logo.bin",
			"untracked untracked src/todo.md",
		]);

		const staged = await readGitDiff(status.root, { rel: "src/cart.ts", area: "staged" });
		assert.deepEqual(
			staged.lines.filter((line) => line.kind === "add" || line.kind === "del").map((line) => `${line.kind} ${line.text}`),
			["del \treturn 0;", "add \treturn items.length;"],
		);
		const unstaged = await readGitDiff(status.root, { rel: "src/cart.ts", area: "unstaged" });
		assert.deepEqual([unstaged.adds, unstaged.dels], [1, 0]);
		assert.deepEqual(unstaged.lines.find((line) => line.kind === "add"), { kind: "add", newNo: 5, text: "export const empty = false;" });

		const renamed = await readGitDiff(status.root, { rel: "new name.txt", from: "old name.txt", area: "staged" });
		assert.deepEqual([renamed.lines.length, renamed.binary], [0, false]);
		const deleted = await readGitDiff(status.root, { rel: "README.md", area: "unstaged" });
		assert.deepEqual([deleted.adds, deleted.dels], [0, 1]);

		const untracked = await readGitDiff(status.root, { rel: "src/todo.md", area: "untracked" });
		assert.deepEqual(untracked.lines, [
			{ kind: "hunk", text: "@@ -0,0 +1,2 @@" },
			{ kind: "add", newNo: 1, text: "- tests" },
			{ kind: "add", newNo: 2, text: "- docs" },
		]);
		assert.equal((await readGitDiff(status.root, { rel: "logo.bin", area: "untracked" })).binary, true);
	} finally {
		cleanup();
	}
});

test("a merge conflict is listed once, and its diff shows the markers against HEAD", async () => {
	const { repo, git, cleanup } = setup();
	try {
		git("checkout", "-q", "-b", "other");
		writeFileSync(join(repo, "README.md"), "# Shop on other\n");
		git("commit", "-q", "-am", "Other");
		git("checkout", "-q", "main");
		writeFileSync(join(repo, "README.md"), "# Shop on main\n");
		git("commit", "-q", "-am", "Main");
		assert.throws(() => git("merge", "-q", "other"));
		const status = await readGitStatus(repo);
		assert.deepEqual(status?.files.map(({ rel, area }) => `${area} ${rel}`), ["conflicted README.md"]);
		const diff = await readGitDiff(status!.root, { rel: "README.md", area: "conflicted" });
		assert.ok(diff.lines.some((line) => line.kind === "add" && line.text.startsWith("<<<<<<<")));
	} finally {
		cleanup();
	}
});

test("commits each way between a branch and its upstream, and when the remote was fetched", async () => {
	const { root, repo, git, cleanup } = setup();
	const run = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, stdio: "pipe" });
	try {
		// No upstream yet: nothing to push or pull, and no fetch to date.
		const local = await readGitStatus(repo);
		assert.equal(local?.upstream, undefined);
		assert.equal(local?.outgoing, undefined);

		run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
		git("remote", "add", "origin", join(root, "origin.git"));
		git("push", "-q", "-u", "origin", "main");
		run(root, "clone", "-q", join(root, "origin.git"), "other");
		writeFileSync(join(root, "other", "README.md"), "# Shop, from elsewhere\n");
		run(join(root, "other"), "commit", "-q", "-am", "Change the title elsewhere");
		run(join(root, "other"), "push", "-q");

		writeFileSync(join(repo, "src", "cart.ts"), "export const items = [1];\n");
		git("commit", "-q", "-am", "Fix --watch flag parsing");
		writeFileSync(join(repo, "src", "cart.ts"), "export const items = [2];\n");
		git("commit", "-q", "-am", "Add HTML test report");
		git("fetch", "-q");

		const status = await readGitStatus(join(repo, "src"));
		assert.equal(status?.upstream, "origin/main");
		assert.deepEqual([status?.ahead, status?.behind], [2, 1]);
		assert.deepEqual(status?.outgoing?.map((commit) => commit.subject), ["Add HTML test report", "Fix --watch flag parsing"]);
		assert.match(status?.outgoing?.[0]?.id ?? "", /^[0-9a-f]{7,}$/);
		assert.deepEqual(status?.incoming?.map((commit) => commit.subject), ["Change the title elsewhere"]);
		assert.ok(status?.fetchedAt && Math.abs(Date.now() - status.fetchedAt) < 60_000);
	} finally {
		cleanup();
	}
});

test("log lines become commits, keeping subjects that hold odd characters", () => {
	assert.deepEqual(parseLog("a1f3c9e\0Fix --watch flag parsing\n7be20d4\0Say \"hi\" — again\n\n"), [
		{ id: "a1f3c9e", subject: "Fix --watch flag parsing" },
		{ id: "7be20d4", subject: 'Say "hi" — again' },
	]);
	assert.deepEqual(parseLog(""), []);
});

test("a decoration names the current branch, others, remotes and tags, without the remote's HEAD", () => {
	assert.deepEqual(parseRefs("HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/fix/cart"), [
		{ name: "main", kind: "branch", current: true },
		{ name: "v1", kind: "tag" },
		{ name: "origin/main", kind: "remote" },
		{ name: "fix/cart", kind: "branch" },
	]);
	assert.deepEqual(parseRefs("HEAD"), [{ name: "HEAD", kind: "head" }]);
	assert.deepEqual(parseRefs(""), []);
});

test("history lines give each commit's parents, author, time and subject", () => {
	const line = (...fields: string[]) => fields.join("\0");
	const commits = parseHistory(`${line("aaa", "bbb ccc", "Ada", "100", "", "Merge fix")}\n${line("bbb", "", "Ada", "50", "tag: refs/tags/v1", "First")}\n`);
	assert.deepEqual(commits[0], { id: "aaa", parents: ["bbb", "ccc"], author: "Ada", time: 100_000, refs: [], subject: "Merge fix" });
	assert.deepEqual(commits[1]!.parents, []);
	assert.deepEqual(commits[1]!.refs, [{ name: "v1", kind: "tag" }]);
});

test("a commit's files take their counts from the numstat records, renames and binary files too", () => {
	const text = [
		":100644 100644 aaa bbb M",
		"a b.txt",
		":100644 100644 aaa aaa R100",
		"old.txt",
		"new.txt",
		":000000 100644 000 ccc A",
		"bin.dat",
		"3\t1\ta b.txt",
		"0\t0\t",
		"old.txt",
		"new.txt",
		"-\t-\tbin.dat",
		"",
	].join("\0");
	assert.deepEqual(parseCommitFiles(text), [
		{ rel: "a b.txt", status: "modified", adds: 3, dels: 1 },
		{ rel: "new.txt", from: "old.txt", status: "renamed", adds: 0, dels: 0 },
		{ rel: "bin.dat", status: "added", adds: 0, dels: 0 },
	]);
});

test("history reads a real repository's branches, a merge's parents and the files of each commit", async () => {
	const { repo, git, cleanup } = setup();
	try {
		git("checkout", "-q", "-b", "feature");
		writeFileSync(join(repo, "README.md"), "# Shop\n\nNew line\n");
		git("mv", "old name.txt", "new name.txt");
		git("add", ".");
		git("commit", "-q", "-m", "Feature", "-m", "Why it was needed.");
		git("checkout", "-q", "main");
		writeFileSync(join(repo, "src", "cart.ts"), "export const items = [1];\n");
		git("add", ".");
		git("commit", "-q", "-m", "Main");
		git("merge", "-q", "--no-ff", "--no-edit", "feature");
		git("tag", "v1");

		const history = await readGitHistory(join(repo, "src"), 10);
		assert.equal(history.more, false);
		const [merge, ...rest] = history.commits;
		assert.equal(merge!.parents.length, 2);
		assert.deepEqual(merge!.refs, [{ name: "main", kind: "branch", current: true }, { name: "v1", kind: "tag" }]);
		const feature = rest.find((commit) => commit.subject === "Feature")!;
		const first = rest.find((commit) => commit.subject === "First")!;
		assert.equal(rest.indexOf(first), rest.length - 1, "parents come after their children");
		assert.equal((await readGitHistory(repo, 2)).more, true);

		const detail = await readGitCommit(join(repo, "src"), feature.id);
		assert.equal(detail.body, "Why it was needed.");
		const renamed = detail.files.find((file) => file.status === "renamed")!;
		assert.deepEqual([renamed.from, renamed.rel], ["old name.txt", "new name.txt"]);
		assert.deepEqual(detail.files.find((file) => file.rel === "README.md"), { rel: "README.md", status: "modified", adds: 2, dels: 0 });

		// The first commit has no parent to compare with, and a merge compares with its first.
		assert.equal((await readGitCommit(repo, first.id)).files.length, 3);
		assert.deepEqual((await readGitCommit(repo, merge!.id)).files.map((file) => file.rel).sort(), ["README.md", "new name.txt"]);

		const diff = await readGitCommitDiff(repo, feature.id, { rel: "README.md" });
		assert.deepEqual([diff.adds, diff.dels], [2, 0]);
		const moved = await readGitCommitDiff(repo, feature.id, { rel: renamed.rel, from: renamed.from });
		assert.deepEqual(moved.lines, [], "a pure rename has no lines, not a whole new file");
		const root = await readGitCommitDiff(repo, first.id, { rel: "README.md" });
		assert.equal(root.adds, 1);
	} finally {
		cleanup();
	}
});

test("history is empty before the first commit and outside a repository", async () => {
	const { repo, git, cleanup } = setup();
	try {
		rmSync(join(repo, ".git"), { recursive: true, force: true });
		assert.deepEqual(await readGitHistory(repo, 10), { commits: [], more: false });
		git("init", "-q", "-b", "main");
		assert.deepEqual(await readGitHistory(repo, 10), { commits: [], more: false });
	} finally {
		cleanup();
	}
});

test("only a full commit id reaches git", async () => {
	const { repo, cleanup } = setup();
	try {
		await assert.rejects(readGitCommit(repo, "--output=/tmp/x"));
		await assert.rejects(readGitCommitDiff(repo, "HEAD", { rel: "README.md" }));
	} finally {
		cleanup();
	}
});

/** Commits made by the code under test need a name, which a test machine may not have configured. */
function identity() {
	Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" });
}

test("staging, unstaging and discarding move files between areas, and discarding deletes untracked ones", async () => {
	const { repo, cleanup } = setup();
	try {
		writeFileSync(join(repo, "README.md"), "# Shop\nMore\n");
		writeFileSync(join(repo, "notes.txt"), "draft\n");
		rmSync(join(repo, "old name.txt"));
		await stageFiles(repo, ["README.md", "old name.txt"]);
		let status = await readGitStatus(repo);
		assert.deepEqual(status!.files.map(({ rel, area }) => `${area}:${rel}`).sort(), ["staged:README.md", "staged:old name.txt", "untracked:notes.txt"]);
		await unstageFiles(repo, ["README.md"]);
		status = await readGitStatus(repo);
		assert.ok(status!.files.some((file) => file.rel === "README.md" && file.area === "unstaged"));
		await discardFiles(repo, [{ rel: "README.md", area: "unstaged" }, { rel: "notes.txt", area: "untracked" }]);
		status = await readGitStatus(repo);
		assert.deepEqual(status!.files.map(({ rel, area }) => `${area}:${rel}`), ["staged:old name.txt"]);
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# Shop\n");
		assert.equal(existsSync(join(repo, "notes.txt")), false);
	} finally {
		cleanup();
	}
});

test("a commit names its session in a trailer, which the commit's details read back out of the body", async () => {
	const { repo, cleanup } = setup();
	identity();
	try {
		writeFileSync(join(repo, "README.md"), "# Shop\nMore\n");
		await commitChanges(repo, { message: withSessionTrailer("Describe the shop\n\nIt sells things.", "abc-123"), all: true });
		const [top] = (await readGitHistory(repo, 1)).commits;
		assert.equal(top!.subject, "Describe the shop");
		const detail = await readGitCommit(repo, top!.id);
		assert.equal(detail.session, "abc-123");
		assert.equal(detail.body, "It sells things.");
		assert.equal(sessionOfMessage("Fix\n\nTrivium-Session: xyz\n"), "xyz");
		assert.equal(withSessionTrailer("Fix\n\nTrivium-Session: xyz", "other"), "Fix\n\nTrivium-Session: xyz");
		await assert.rejects(commitChanges(repo, { message: "  " }), /commit message/);
	} finally {
		cleanup();
	}
});

test("undoing a commit keeps its changes staged, and the first commit can't be undone", async () => {
	const { repo, cleanup } = setup();
	identity();
	try {
		await assert.rejects(undoLastCommit(repo), /first commit/);
		writeFileSync(join(repo, "README.md"), "# Shop\nMore\n");
		await commitChanges(repo, { message: "More", all: true });
		await undoLastCommit(repo);
		const status = await readGitStatus(repo);
		assert.deepEqual(status!.files.map(({ rel, area }) => `${area}:${rel}`), ["staged:README.md"]);
		assert.equal((await readGitHistory(repo, 5)).commits.length, 1);
	} finally {
		cleanup();
	}
});

test("the project's files leave out what git ignores and what was deleted, unless ignored files are asked for", async () => {
	const { repo, git, cleanup } = setup();
	try {
		writeFileSync(join(repo, ".gitignore"), "dist/\n");
		mkdirSync(join(repo, "dist"));
		writeFileSync(join(repo, "dist", "main.js"), "x\n");
		writeFileSync(join(repo, "src", "new.ts"), "export {};\n");
		rmSync(join(repo, "old name.txt"));
		const tree = await listProjectFiles(repo);
		assert.equal(tree.git, true);
		assert.deepEqual(tree.files.sort(), [".gitignore", "README.md", "src/cart.ts", "src/new.ts"]);
		assert.deepEqual(tree.ignored, []);
		assert.deepEqual((await listProjectFiles(repo, { ignored: true })).ignored, ["dist/"]);
		rmSync(join(repo, ".git"), { recursive: true, force: true });
		const plain = await listProjectFiles(repo);
		assert.equal(plain.git, false);
		assert.ok(plain.files.includes("dist/main.js"));
		void git;
	} finally {
		cleanup();
	}
});

test("a file reads as text, or says it is binary, and a commit's version reads by its id", async () => {
	const { repo, cleanup } = setup();
	identity();
	try {
		assert.deepEqual(await readProjectFile(join(repo, "README.md")), { text: "# Shop\n", binary: false, tooLarge: false });
		writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
		assert.equal((await readProjectFile(join(repo, "logo.png"))).binary, true);
		const [first] = (await readGitHistory(repo, 1)).commits;
		writeFileSync(join(repo, "README.md"), "# Changed\n");
		assert.equal((await readFileAtCommit(repo, first!.id, "README.md")).text, "# Shop\n");
		await assert.rejects(readFileAtCommit(repo, first!.id, "missing.txt"));
		await assert.rejects(readFileAtCommit(repo, "HEAD", "README.md"));
	} finally {
		cleanup();
	}
});

test("a project's branch, empty when HEAD is detached, and none outside a repository", async () => {
	const { root, repo, git } = setup();
	try {
		assert.equal(await readBranch(repo), "main");
		assert.equal(await readBranch(join(repo, "src")), "main");
		git("checkout", "-q", "--detach");
		assert.equal(await readBranch(repo), "");
		const plain = join(root, "plain");
		mkdirSync(plain);
		assert.equal(await readBranch(plain), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a worktree checks out a new branch beside the repository, in the folder matching the one asked for", async () => {
	const { root, repo, git } = setup();
	try {
		const first = await addWorktree(join(repo, "src"), "trivium/fix-cart");
		assert.equal(first, join(root, "shop.worktrees", "trivium-fix-cart", "src"));
		assert.equal(await readBranch(first), "trivium/fix-cart");
		// The project's own checkout stays where it was.
		assert.equal(await readBranch(repo), "main");
		// A folder already there gets a number; a branch already there is git's to refuse.
		mkdirSync(join(root, "shop.worktrees", "trivium-other"), { recursive: true });
		assert.equal(await addWorktree(repo, "trivium/other"), join(root, "shop.worktrees", "trivium-other-2"));
		await assert.rejects(addWorktree(repo, "trivium/fix-cart"), /already exists/);
		await assert.rejects(addWorktree(repo, "bad..name"), /not a valid branch name/);
		assert.match(git("worktree", "list").toString(), /trivium-fix-cart/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
