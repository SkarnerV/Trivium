import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HandoffCache, manifestOf, splitPatch } from "../src/main/handoffs.ts";
import type { Run } from "../src/shared/protocol.ts";

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
	const root = mkdtempSync(join(tmpdir(), "trivium-pending-handoff-"));
	try {
		const path = join(root, "handoff.json");
		const manifest = { version: 1, runId: "r", groups: [{ children: [], laneBindings: [{ workflowKey: "api", taskIndex: 0 }], cleanup: { state: "partial", tasks: [{ index: 0, branch: "pi-sub/api", path: root, worktreeRemoved: false, preserved: true, reason: "cleanup pending durable handoff capture" }] } }] };
		assert.deepEqual(manifestOf(manifest)?.worktrees, ["api"]);
		assert.deepEqual(manifestOf(manifest)?.kept, []);
		writeFileSync(path, JSON.stringify(manifest));
		const cache = new HandoffCache();
		await cache.capture({ parallelHandoff: { path } });
		const runs = [{ steps: [{ subagent: { handoffPath: path, children: [{ label: "api" }] } }] }] as unknown as Run[];
		cache.attach(runs);
		assert.equal(runs[0]!.steps[0]!.subagent!.children[0]!.worktree, true);
	} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test("a session may read only cached manifest patches, never paths or another session's ids", async () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-handoffs-"));
	try {
		const path = join(root, "handoff.json");
		const patchPath = join(root, "api.patch");
		writeFileSync(patchPath, patch);
		const manifest = { version: 1, runId: "r", groups: [{ children: [{ workflowKey: "api", patch: { path: patchPath, branch: "pi-sub/api", changed: true, filesChanged: 2, insertions: 2, deletions: 2 } }], cleanup: { tasks: [{ path: join(root, "kept"), preserved: true, branch: "pi-sub/api", reason: "capture failed" }] } }] };
		writeFileSync(path, JSON.stringify(manifest));
		assert.equal(manifestOf({ ...manifest, version: 2 }), undefined);
		assert.equal(manifestOf({ ...manifest, groups: [{ children: [{ patch: { path: "relative" } }] }] })?.children.length, 0);
		const cache = new HandoffCache();
		await cache.capture({ parallelHandoff: { path } });
		const runs = [{ steps: [{ subagent: { handoffPath: path, children: [{ label: "api" }] } }] }] as unknown as Run[];
		cache.attach(runs);
		const handoff = runs[0]!.steps[0]!.subagent!.children[0]!.handoff!;
		assert.equal(handoff.branch, "pi-sub/api");
		assert.deepEqual(handoff.files, ["a.ts", "b.ts"]);
		assert.equal(runs[0]!.steps[0]!.subagent!.keptWorktrees?.[0]?.reason, "capture failed");
		writeFileSync(patchPath, "changed after capture");
		assert.equal(cache.patch(handoff.id).length, 2);
		const background = new HandoffCache();
		await background.capture({ runs: [{ runId: "background-1", handoffPath: path }] });
		const backgroundRuns = [{ steps: [{ subagent: { asyncId: "background-1", children: [{ label: "api" }] } }] }] as unknown as Run[];
		background.attach(backgroundRuns);
		assert.equal(backgroundRuns[0]!.steps[0]!.subagent!.children[0]!.handoff?.branch, "pi-sub/api");
		assert.throws(() => cache.patch(patchPath), /Unknown/);
		assert.throws(() => new HandoffCache().patch(handoff.id), /Unknown/);
		await cache.capture({ parallelHandoff: { path: patchPath } });
		assert.equal(cache.patch(handoff.id).length, 2);
	} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
