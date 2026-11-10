import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
	/** Runs `work` as a command the agent ran: the project is snapshotted before it and compared after. */
	const command = async (work: () => void) => {
		await tracker.beforeCommand();
		work();
		return tracker.afterCommand();
	};
	return { root, repo, git, file, commit, tracker, edit, listed, command, saved, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
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
	const { repo, commit, edit, saved, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		commit("Cart");
		// The session last looked at a commit the repository no longer has.
		writeFileSync(saved, JSON.stringify({ ...JSON.parse(readFileSync(saved, "utf8")), since: "0".repeat(40) }));
		const reloaded = new ChangeTracker(saved, repo);
		assert.equal(await reloaded.dropCommitted(), false);
		assert.equal((await reloaded.list()).length, 1);
	} finally {
		cleanup();
	}
});

/** What a command does to three files: rewrites one, deletes one and creates one in a new folder. */
function threeChanges(file: (rel: string) => string) {
	writeFileSync(file("src/cart.ts"), "two\n");
	rmSync(file("README.md"));
	mkdirSync(file("docs/guide"), { recursive: true });
	writeFileSync(file("docs/guide/intro.md"), "# Intro\n");
}

/** Every file under a folder, and the bytes they add up to. */
function filesUnder(dir: string): { names: string[]; bytes: number } {
	const found = { names: [] as string[], bytes: 0 };
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			const inner = filesUnder(path);
			found.names.push(...inner.names);
			found.bytes += inner.bytes;
		} else {
			const info = statSync(path);
			found.names.push(`${path} ${info.size} ${info.mtimeMs}`);
			found.bytes += info.size;
		}
	}
	return found;
}

for (const repository of [true, false]) {
	const where = repository ? "in a repository" : "outside a repository";
	test(`what a command rewrote, deleted and created is listed and can be reverted, ${where}`, async () => {
		const { file, tracker, command, cleanup } = setup({ repository });
		try {
			assert.equal(await command(() => threeChanges(file)), true);
			const status = Object.fromEntries((await tracker.list()).map((change) => [change.rel.replaceAll("\\", "/"), change.status]));
			assert.deepEqual(status, { "docs/guide/intro.md": "added", "README.md": "deleted", "src/cart.ts": "modified" });
			await tracker.revert();
			assert.equal(readFileSync(file("src/cart.ts"), "utf8"), "one\n");
			assert.equal(readFileSync(file("README.md"), "utf8"), "# Shop\n");
			assert.equal(existsSync(file("docs")), false, "the folders made for the new file go with it");
			assert.deepEqual(await tracker.list(), []);
		} finally {
			cleanup();
		}
	});
}

test("a command that changes nothing records nothing", async () => {
	const { file, listed, command, cleanup } = setup();
	try {
		assert.equal(await command(() => readFileSync(file("README.md"))), false);
		assert.deepEqual(await listed(), []);
	} finally {
		cleanup();
	}
});

test("a file git ignores is left out of what a command changed", async () => {
	const { file, listed, command, cleanup } = setup();
	try {
		await command(() => {
			mkdirSync(file("build"));
			writeFileSync(file("build/out.js"), "built\n");
			writeFileSync(file("src/cart.ts"), "two\n");
		});
		assert.deepEqual(await listed(), ["src/cart.ts"]);
	} finally {
		cleanup();
	}
});

test("a file the agent edited keeps its first baseline when a command changes it again", async () => {
	const { file, tracker, edit, command, cleanup } = setup();
	try {
		await edit("src/cart.ts", "two\n");
		assert.equal(await command(() => writeFileSync(file("src/cart.ts"), "three\n")), false, "nothing new to record");
		await tracker.revert();
		assert.equal(readFileSync(file("src/cart.ts"), "utf8"), "one\n");
	} finally {
		cleanup();
	}
});

test("only what the command changed is recorded, not edits made by hand before it", async () => {
	const { file, listed, command, cleanup } = setup();
	try {
		writeFileSync(file("README.md"), "# My own edit\n");
		await command(() => writeFileSync(file("src/cart.ts"), "two\n"));
		assert.deepEqual(await listed(), ["src/cart.ts"]);
	} finally {
		cleanup();
	}
});

test("a checkout or a merge by a command records nothing: git holds those files", async () => {
	const { git, file, commit, listed, command, cleanup } = setup();
	try {
		git("checkout", "-q", "-b", "feature");
		writeFileSync(file("src/cart.ts"), "feature\n");
		writeFileSync(file("src/extra.ts"), "extra\n");
		commit("Feature");
		assert.equal(await command(() => git("checkout", "-q", "main")), false);
		assert.equal(await command(() => git("merge", "-q", "feature")), false);
		assert.deepEqual(await listed(), []);
	} finally {
		cleanup();
	}
});

test("uncommitted work a command threw away is recorded, and revert brings it back", async () => {
	const { git, file, tracker, listed, command, cleanup } = setup();
	try {
		writeFileSync(file("src/cart.ts"), "my unsaved work\n");
		assert.equal(await command(() => git("checkout", "--", "src/cart.ts")), true);
		assert.equal(readFileSync(file("src/cart.ts"), "utf8"), "one\n");
		assert.deepEqual(await listed(), ["src/cart.ts"]);
		await tracker.revert();
		assert.equal(readFileSync(file("src/cart.ts"), "utf8"), "my unsaved work\n");
	} finally {
		cleanup();
	}
});

test("a file a command changed and committed leaves the list", async () => {
	const { file, commit, tracker, listed, command, cleanup } = setup();
	try {
		// Dirty before the command, so it is recorded even though the command leaves it clean.
		writeFileSync(file("README.md"), "# Store\n");
		await command(() => {
			writeFileSync(file("README.md"), "# Market\n");
			writeFileSync(file("src/cart.ts"), "two\n");
			commit("Both");
		});
		assert.equal(await tracker.dropCommitted(), true);
		assert.deepEqual(await listed(), []);
		await tracker.revert();
		assert.equal(readFileSync(file("README.md"), "utf8"), "# Market\n", "revert leaves committed work alone");
	} finally {
		cleanup();
	}
});

test("line endings and binary files come back byte for byte, whatever the repository converts", async () => {
	const { git, file, commit, tracker, command, cleanup } = setup();
	try {
		git("config", "core.autocrlf", "true");
		writeFileSync(file(".gitattributes"), "*.txt text eol=crlf\n");
		const crlf = Buffer.from("first\r\nsecond\r\n");
		const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x00]);
		const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
		writeFileSync(file("notes.txt"), crlf);
		writeFileSync(file("logo.png"), binary);
		writeFileSync(file("menu.dat"), latin);
		commit("Assets");
		await command(() => {
			writeFileSync(file("notes.txt"), "first\nsecond\n");
			writeFileSync(file("logo.png"), Buffer.from([1, 2, 3, 0]));
			rmSync(file("menu.dat"));
		});
		const changes = await tracker.list();
		const logo = changes.find((change) => change.rel === "logo.png");
		assert.equal(logo?.binary, true);
		assert.deepEqual(logo?.lines, []);
		assert.equal(changes.find((change) => change.rel === "menu.dat")?.status, "deleted");
		await tracker.revert();
		assert.deepEqual(readFileSync(file("notes.txt")), crlf);
		assert.deepEqual(readFileSync(file("logo.png")), binary);
		assert.deepEqual(readFileSync(file("menu.dat")), latin);
		assert.deepEqual(await tracker.list(), []);
	} finally {
		cleanup();
	}
});

test("a new binary file is listed without lines", async () => {
	const { file, tracker, command, cleanup } = setup();
	try {
		await command(() => writeFileSync(file("logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01])));
		const [logo] = await tracker.list();
		assert.equal(logo?.status, "added");
		assert.equal(logo?.binary, true);
		assert.deepEqual(logo?.lines, []);
	} finally {
		cleanup();
	}
});

test("a file too large to keep is never copied, and a change to it is left to git", async () => {
	const { root, file, listed, command, cleanup } = setup();
	try {
		writeFileSync(file("data.bin"), Buffer.alloc(11 * 1024 * 1024, 1));
		await command(() => {
			writeFileSync(file("data.bin"), Buffer.alloc(11 * 1024 * 1024, 2));
			writeFileSync(file("src/cart.ts"), "two\n");
		});
		assert.deepEqual(await listed(), ["src/cart.ts"]);
		assert.ok(filesUnder(join(root, "session.git")).bytes < 1024 * 1024, "the snapshot holds no copy of it");
	} finally {
		cleanup();
	}
});

test("snapshots add and change nothing in the project's own .git", async () => {
	const { repo, file, command, cleanup } = setup();
	try {
		// git marks an object it finds already stored as used again, which only moves that file's modified time.
		const kept = () => filesUnder(join(repo, ".git")).names.map((name) => (/[\\/]objects[\\/]/.test(name) ? name.replace(/ [\d.]+$/, "") : name));
		const before = kept();
		await command(() => threeChanges(file));
		assert.deepEqual(kept(), before);
	} finally {
		cleanup();
	}
});

test("a session loaded later still knows what its commands changed, and goes on from there", async () => {
	const { repo, file, command, saved, cleanup } = setup();
	try {
		writeFileSync(file("logo.png"), Buffer.from([9, 0, 9]));
		await command(() => {
			writeFileSync(file("logo.png"), Buffer.from([1, 0, 1]));
			writeFileSync(file("src/cart.ts"), "two\n");
		});
		const reloaded = new ChangeTracker(saved, repo);
		assert.equal((await reloaded.list()).length, 2);
		await reloaded.beforeCommand();
		writeFileSync(file("README.md"), "# Store\n");
		assert.equal(await reloaded.afterCommand(), true);
		await reloaded.revert();
		assert.deepEqual(readFileSync(file("logo.png")), Buffer.from([9, 0, 9]));
		assert.equal(readFileSync(file("README.md"), "utf8"), "# Shop\n");
		assert.equal(existsSync(saved.replace(/\.json$/, ".blobs")), false, "kept bytes go once nothing needs them");
	} finally {
		cleanup();
	}
});
