import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HandoffCache, manifestOf, splitPatch } from "../src/main/handoffs.ts";
import { asyncRunRoots, handoffRoots, isUncOrDevice, trustedPath } from "../src/main/extension-paths.ts";
import type { Run } from "../src/shared/protocol.ts";

/** Roots as a session in another folder sees them: only the temp directory's pi-subagents-* folders apply. */
const roots = () => handoffRoots({ agentDir: join(tmpdir(), "trivium-no-agent-dir"), cwd: join(tmpdir(), "trivium-no-project"), env: {} });
/** A folder like the ones pi-subagents keeps its temporary runs in: directly in the temp directory, named pi-subagents-*. */
const extensionTemp = (name: string) => mkdtempSync(join(tmpdir(), `pi-subagents-${name}-`));
const remove = (...dirs: string[]) => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-before\n+after\n';

test("handoff diffs split per file, including deletes, binary files and spaces", () => {
	assert.deepEqual(splitPatch(patch).map((file) => [file.file, file.adds, file.dels]), [["a.ts", 1, 1], ["b.ts", 1, 1]]);
	assert.equal(splitPatch('diff --git a/a b/a\n--- a/a\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n')[0]!.file, "a");
	assert.equal(splitPatch('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n')[0]!.binary, true);
	assert.equal(splitPatch('diff --git a/a b.ts b/a b.ts\n--- a/a b.ts\n+++ b/a b.ts\n@@ -0,0 +1 @@\n+a\n')[0]!.file, "a b.ts");
	assert.equal(splitPatch('diff --git "a/\\344\\270\\255.ts" "b/\\344\\270\\255.ts"\n--- "a/\\344\\270\\255.ts"\n+++ "b/\\344\\270\\255.ts"\n@@ -0,0 +1 @@\n+a\n')[0]!.file, "中.ts");
	assert.equal(splitPatch('diff --git a/a.png b/a.png\nGIT binary patch\nliteral 0\n')[0]!.binary, true);
});

test("pending handoff lane bindings identify worktrees without reporting them as kept", async () => {
	const root = extensionTemp("pending-handoff");
	try {
		const path = join(root, "handoff.json");
		const manifest = { version: 1, runId: "r", groups: [{ children: [], laneBindings: [{ workflowKey: "api", taskIndex: 0 }], cleanup: { state: "partial", tasks: [{ index: 0, branch: "pi-sub/api", path: root, worktreeRemoved: false, preserved: true, reason: "cleanup pending durable handoff capture" }] } }] };
		assert.deepEqual(manifestOf(manifest)?.worktrees, ["api"]);
		assert.deepEqual(manifestOf(manifest)?.kept, []);
		writeFileSync(path, JSON.stringify(manifest));
		const cache = new HandoffCache(roots());
		await cache.capture({ parallelHandoff: { path } });
		const runs = [{ steps: [{ subagent: { handoffPath: path, children: [{ label: "api" }] } }] }] as unknown as Run[];
		cache.attach(runs);
		assert.equal(runs[0]!.steps[0]!.subagent!.children[0]!.worktree, true);
	} finally { remove(root); }
});

test("a session may read only cached manifest patches, never paths or another session's ids", async () => {
	const root = extensionTemp("handoffs");
	try {
		const path = join(root, "handoff.json");
		const patchPath = join(root, "api.patch");
		writeFileSync(patchPath, patch);
		const manifest = { version: 1, runId: "r", groups: [{ children: [{ workflowKey: "api", patch: { path: patchPath, branch: "pi-sub/api", changed: true, filesChanged: 2, insertions: 2, deletions: 2 } }], cleanup: { tasks: [{ path: join(root, "kept"), preserved: true, branch: "pi-sub/api", reason: "capture failed" }] } }] };
		writeFileSync(path, JSON.stringify(manifest));
		assert.equal(manifestOf({ ...manifest, version: 2 }), undefined);
		assert.equal(manifestOf({ ...manifest, groups: [{ children: [{ patch: { path: "relative" } }] }] })?.children.length, 0);
		const cache = new HandoffCache(roots());
		await cache.capture({ parallelHandoff: { path } });
		const runs = [{ steps: [{ subagent: { handoffPath: path, children: [{ label: "api" }] } }] }] as unknown as Run[];
		const fresh = structuredClone(runs);
		cache.attach(runs);
		const handoff = runs[0]!.steps[0]!.subagent!.children[0]!.handoff!;
		assert.equal(handoff.branch, "pi-sub/api");
		assert.deepEqual(handoff.files, ["a.ts", "b.ts"]);
		assert.equal(runs[0]!.steps[0]!.subagent!.keptWorktrees?.[0]?.reason, "capture failed");
		writeFileSync(patchPath, "changed after capture");
		assert.equal(cache.patch(handoff.id).length, 2);
		const background = new HandoffCache(roots());
		await background.capture({ runs: [{ runId: "background-1", handoffPath: path }] });
		const backgroundRuns = [{ steps: [{ subagent: { asyncId: "background-1", children: [{ label: "api" }] } }] }] as unknown as Run[];
		background.attach(backgroundRuns);
		assert.equal(backgroundRuns[0]!.steps[0]!.subagent!.children[0]!.handoff?.branch, "pi-sub/api");
		assert.throws(() => cache.patch(patchPath), /Unknown/);
		assert.throws(() => new HandoffCache(roots()).patch(handoff.id), /Unknown/);
		await cache.capture({ parallelHandoff: { path: patchPath } });
		assert.equal(cache.patch(handoff.id).length, 2);
		cache.clear();
		assert.throws(() => cache.patch(handoff.id), /Unknown/, "an unloaded or deleted session keeps no patches");
		assert.equal(cache.attach(fresh)[0]!.steps[0]!.subagent!.children[0]!.handoff, undefined, "nor its manifests");
	} finally { remove(root); }
});

const manifestFor = (patchPath: string) => ({ version: 1, runId: "r", groups: [{ children: [{ workflowKey: "api", patch: { path: patchPath, branch: "pi-sub/api", changed: true, filesChanged: 2, insertions: 2, deletions: 2 } }] }] });

test("a manifest outside the extension's folders is never read", async () => {
	const outside = mkdtempSync(join(tmpdir(), "trivium-outside-"));
	try {
		const patchPath = join(outside, "api.patch");
		writeFileSync(patchPath, patch);
		const path = join(outside, "handoff.json");
		writeFileSync(path, JSON.stringify(manifestFor(patchPath)));
		const cache = new HandoffCache(roots());
		await cache.capture({ parallelHandoff: { path } });
		await cache.capture({ runs: [{ runId: "x", handoffPath: path }] });
		const runs = [{ steps: [{ subagent: { handoffPath: path, children: [{ label: "api" }] } }] }] as unknown as Run[];
		cache.attach(runs);
		assert.equal(runs[0]!.steps[0]!.subagent!.children[0]!.handoff, undefined);
	} finally { remove(outside); }
});

test("a patch outside the extension's folders is not read, even from a manifest inside them", async () => {
	const root = extensionTemp("outside-patch");
	const outside = mkdtempSync(join(tmpdir(), "trivium-outside-"));
	try {
		const patchPath = join(outside, "secret.patch");
		writeFileSync(patchPath, patch);
		const path = join(root, "handoff.json");
		writeFileSync(path, JSON.stringify(manifestFor(patchPath)));
		const cache = new HandoffCache(roots());
		await cache.capture({ parallelHandoff: { path } });
		const runs = [{ steps: [{ subagent: { handoffPath: path, children: [{ label: "api" }] } }] }] as unknown as Run[];
		cache.attach(runs);
		const handoff = runs[0]!.steps[0]!.subagent!.children[0]!.handoff!;
		assert.deepEqual(handoff.files, []);
		assert.match(handoff.error ?? "", /not where subagents keep their files/);
		assert.deepEqual(cache.patch(handoff.id), []);
	} finally { remove(root, outside); }
});

test("UNC, device and relative paths are refused before touching the file system", async () => {
	for (const path of ["\\\\server\\share\\handoff.json", "\\\\?\\C:\\handoff.json", "\\\\.\\pipe\\x", "//server/share/handoff.json"]) {
		assert.equal(isUncOrDevice(path), true, path);
		assert.equal(await trustedPath(path, { trees: ["/", "C:\\"], temp: [tmpdir()] }), undefined, path);
	}
	assert.equal(isUncOrDevice("C:\\Users\\a\\handoff.json"), false);
	assert.equal(await trustedPath("relative/handoff.json", roots()), undefined);
	assert.equal(await trustedPath("", roots()), undefined);
});

test("a link inside the extension's folder that leads outside it is refused", async (t) => {
	const root = extensionTemp("link");
	const outside = mkdtempSync(join(tmpdir(), "trivium-outside-"));
	try {
		writeFileSync(join(outside, "secret.json"), "{}");
		try {
			// A junction needs no special rights on Windows; elsewhere the type is ignored and it is a directory link.
			symlinkSync(outside, join(root, "escape"), "junction");
		} catch {
			t.skip("links cannot be made here");
			return;
		}
		assert.equal(await trustedPath(join(root, "escape", "secret.json"), roots()), undefined);
		writeFileSync(join(root, "inside.json"), "{}");
		assert.ok(await trustedPath(join(root, "inside.json"), roots()));
	} finally { remove(root, outside); }
});

test("the session, project and configured temp roots are the only other places accepted", async () => {
	const base = mkdtempSync(join(tmpdir(), "trivium-roots-"));
	try {
		const agentDir = join(base, "agent");
		const cwd = join(base, "project");
		const custom = join(base, "custom-temp");
		for (const dir of [join(agentDir, "sessions", "--p--"), join(cwd, ".pi", "subagents", "artifacts"), join(cwd, "src"), join(custom, "async-subagent-runs", "run-1")]) mkdirSync(dir, { recursive: true });
		const files = {
			session: join(agentDir, "sessions", "--p--", "handoff.json"),
			project: join(cwd, ".pi", "subagents", "artifacts", "handoff.json"),
			source: join(cwd, "src", "handoff.json"),
			custom: join(custom, "async-subagent-runs", "run-1", "status.json"),
			agent: join(agentDir, "settings.json"),
		};
		for (const file of Object.values(files)) writeFileSync(file, "{}");
		const allowed = handoffRoots({ agentDir, cwd, env: { PI_SUBAGENTS_TEMP_ROOT: custom }, temp: join(base, "no-temp") });
		assert.ok(await trustedPath(files.session, allowed));
		assert.ok(await trustedPath(files.project, allowed));
		assert.ok(await trustedPath(files.custom, allowed));
		assert.equal(await trustedPath(files.source, allowed), undefined, "the project's own files are not handoffs");
		assert.equal(await trustedPath(files.agent, allowed), undefined, "nor is the agent's configuration");
		const runRoots = asyncRunRoots({ env: { PI_SUBAGENTS_TEMP_ROOT: custom } });
		assert.ok(await trustedPath(files.custom, runRoots));
		assert.equal(await trustedPath(files.session, runRoots), undefined);
		if (process.platform === "win32") {
			// Windows paths compare without case, as the Changes tracker compares them.
			const lower = handoffRoots({ agentDir, cwd: cwd.toLowerCase(), env: {}, temp: join(base, "no-temp") });
			assert.ok(await trustedPath(files.project.toUpperCase(), lower));
		}
	} finally { remove(base); }
});
