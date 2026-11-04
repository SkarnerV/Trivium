import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChangeTracker } from "../src/main/changes.ts";

/** A project with one commit, and a tracker for a session in it. */
function setup({ repository = true } = {}) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-changes-")));
	const repo = join(root, "shop");
	mkdirSync(join(repo, "src"), { recursive: true });
	process.env.GIT_CEILING_DIRECTORIES = root;
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd: repo, stdio: "pipe" });
	const file = (rel: string) => join(repo, rel);
	const commit = (message: string) => {
		git("add", ".");
		git("commit", "-q", "-m", message);
	};
	writeFileSync(file("src/cart.ts"), "one\n");
	writeFileSync(file("README.md"), "# Shop\n");
	writeFileSync(file(".gitignore"), "build/\n");
	if (repository) {
		git("init", "-q", "-b", "main");
		git("config", "core.autocrlf", "false");
		commit("First");
	}
	const saved = join(root, "session.json");
	const tracker = new ChangeTracker(saved, repo);
	/** Records a file as the agent's tools do, then writes it. */
	const edit = async (rel: string, text: string) => {
		await tracker.capture(file(rel));
		mkdirSync(join(file(rel), ".."), { recursive: true });
		writeFileSync(file(rel), text);
	};
	const listed = async () => (await tracker.list()).map((change) => change.rel.replaceAll("\\", "/"));
	return { repo, git, file, commit, tracker, edit, listed, saved, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a committed file leaves the session's list, and Revert no longer touches it", async () => {
	const { file, commit, tracker, edit, listed, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		await edit("src/new.ts", "new\n");
		assert.equal(await tracker.dropCommitted(), false, "nothing is committed yet");
		assert.deepEqual(await listed(), ["src/cart.ts", "src/new.ts"]);
		commit("Cart");
		assert.equal(await tracker.dropCommitted(), true);
		assert.deepEqual(await listed(), []);
		await tracker.revert();
		assert.equal(readFileSync(file("src/cart.ts"), "utf8"), "two\n");
		assert.equal(readFileSync(file("src/new.ts"), "utf8"), "new\n");
	} finally {
		cleanup();
	}
});

test("only the files that were committed leave", async () => {
	const { git, file, tracker, edit, listed, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		await edit("README.md", "# Store\n");
		git("add", "src/cart.ts");
		git("commit", "-q", "-m", "Cart");
		await tracker.dropCommitted();
		assert.deepEqual(await listed(), ["README.md"]);
		await tracker.revert();
		assert.equal(readFileSync(file("README.md"), "utf8"), "# Shop\n");
	} finally {
		cleanup();
	}
});

test("a file changed again after its commit stays, and leaves with the next commit", async () => {
	const { file, commit, tracker, edit, listed, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		commit("Two");
		writeFileSync(file("src/cart.ts"), "three\n");
		assert.equal(await tracker.dropCommitted(), false);
		assert.deepEqual(await listed(), ["src/cart.ts"]);
		commit("Three");
		assert.equal(await tracker.dropCommitted(), true);
		assert.deepEqual(await listed(), []);
	} finally {
		cleanup();
	}
});

test("staging alone doesn't count, and a committed deletion does", async () => {
	const { git, file, commit, tracker, edit, listed, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		git("add", ".");
		assert.equal(await tracker.dropCommitted(), false);
		assert.deepEqual(await listed(), ["src/cart.ts"]);
		await tracker.keep();
		await tracker.capture(file("README.md"));
		rmSync(file("README.md"));
		commit("Remove");
		assert.equal(await tracker.dropCommitted(), true);
		assert.deepEqual(await listed(), []);
	} finally {
		cleanup();
	}
});

test("a file git ignores stays, whatever gets committed", async () => {
	const { commit, tracker, edit, listed, cleanup } = setup();
	try {
		await edit("build/out.js", "built\n");
		await edit("src/cart.ts", "two\n");
		commit("Cart");
		await tracker.dropCommitted();
		assert.deepEqual(await listed(), ["build/out.js"]);
	} finally {
		cleanup();
	}
});

test("your uncommitted work stays revertible when the agent puts a file back to match HEAD", async () => {
	const { file, commit, tracker, edit, listed, cleanup } = setup();
	try {
		writeFileSync(file("src/cart.ts"), "my unsaved work\n");
		await edit("src/cart.ts", "one\n");
		await edit("README.md", "# Store\n");
		commit("Readme");
		await tracker.dropCommitted();
		assert.deepEqual(await listed(), ["src/cart.ts"]);
		await tracker.revert();
		assert.equal(readFileSync(file("src/cart.ts"), "utf8"), "my unsaved work\n");
	} finally {
		cleanup();
	}
});

test("the first commit of a folder that only became a repository later clears what it holds", async () => {
	const { git, commit, tracker, edit, listed, cleanup } = setup({ repository: false });
	try {
		await edit("src/cart.ts", "two\n");
		await edit("build/out.js", "built\n");
		assert.equal(await tracker.dropCommitted(), false);
		git("init", "-q", "-b", "main");
		git("config", "core.autocrlf", "false");
		assert.equal(await tracker.dropCommitted(), false);
		commit("First");
		assert.equal(await tracker.dropCommitted(), true);
		assert.deepEqual(await listed(), ["build/out.js"]);
	} finally {
		cleanup();
	}
});

test("a session loaded later still sees commits made while it was away", async () => {
	const { repo, commit, tracker, edit, saved, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		await tracker.keep([]);
		commit("Cart");
		const reloaded = new ChangeTracker(saved, repo);
		assert.equal(await reloaded.dropCommitted(), true);
		assert.deepEqual(await reloaded.list(), []);
	} finally {
		cleanup();
	}
});

test("a commit rewritten away only loses the check, not the file", async () => {
	const { git, tracker, edit, listed, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		const first = git("rev-parse", "HEAD").toString().trim();
		git("commit", "-q", "--amend", "-m", "Reworded", "--allow-empty");
		git("reflog", "expire", "--expire=now", "--all");
		git("gc", "-q", "--prune=now");
		assert.notEqual(git("rev-parse", "HEAD").toString().trim(), first);
		assert.equal(await tracker.dropCommitted(), false);
		assert.deepEqual(await listed(), ["src/cart.ts"]);
	} finally {
		cleanup();
	}
});
