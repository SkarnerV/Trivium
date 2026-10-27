import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDiff, parseStatus, readGitDiff, readGitStatus } from "../src/main/git.ts";

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
