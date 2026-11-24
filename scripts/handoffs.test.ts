import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delegationHooks } from "../src/main/delegation-hooks.ts";
import { HandoffCache, manifestOf, splitPatch, worktreeKeys } from "../src/main/handoffs.ts";
import { subagentOf } from "../src/main/subagents.ts";
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
		const backgroundPath = join(root, "background.json");
		writeFileSync(backgroundPath, JSON.stringify({ ...manifest, runId: "background-1" }));
		await background.capture({ runs: [{ runId: "background-1", handoffPath: backgroundPath }] });
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

/** A pi-subagents temp root with one folder per run, each with the manifest and patch a worktree child leaves. */
function workflowRuns(root: string) {
	const runDir = (runId: string) => join(root, "async-subagent-runs", runId);
	const add = (key: string, runId: string, file: string, manifestRun = runId) => {
		const diffs = join(runDir(runId), "worktree-diffs", "step-0");
		mkdirSync(diffs, { recursive: true });
		const patchPath = join(diffs, "task-0-worker.patch");
		writeFileSync(patchPath, `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`);
		writeFileSync(join(runDir(runId), "status.json"), JSON.stringify({ runId, state: "complete", steps: [{ agent: "worker", worktreePath: join(root, "worktrees", key) }] }));
		writeFileSync(
			join(runDir(runId), "handoff.json"),
			JSON.stringify({ version: 1, runId: manifestRun, groups: [{ children: [{ index: 0, taskIndex: 0, workflowKey: key, runId: manifestRun, patch: { path: patchPath, branch: `pi-subagents/${key}`, changed: true, filesChanged: 1, insertions: 1, deletions: 1 } }], cleanup: { tasks: [{ index: 0 }] } }] }),
		);
		return patchPath;
	};
	/** A real workflow call's receipt (pi-subagents 0.82.1): no manifest named anywhere, each child its own run. */
	const receipt = (children: [string, string][]) => ({
		mode: "workflow",
		runId: "call_1",
		results: children.map(([key, runId]) => ({ index: 0, agent: "worker", workflowKey: key, runId, task: key, exitCode: 0, finalOutput: "done", artifactPaths: { outputPath: join(root, "artifacts", `${runId}_worker_output.md`) } })),
		workflowChildren: { version: 1, workflowRunId: "call_1", workflowState: "completed", inventoryComplete: true, children: children.map(([key, runId]) => ({ childId: key, runId, agent: "worker", state: "completed" })) },
		mission: { workflowChildren: children.map(([key, runId]) => ({ workflowRunId: "call_1", key, runId, agent: "worker", artifactPaths: [runDir(runId)] })) },
	});
	return { add, receipt, runDir };
}

const viewOf = (details: unknown): Run[] => [{ steps: [{ subagent: subagentOf({ workflow: "./w.js" }, details, "done") }] }] as unknown as Run[];
const childrenOf = (runs: Run[]) => runs[0]!.steps[0]!.subagent!.children;

test("each workflow writer's patch is found by its own run, in any order, and again after the session reopens", async () => {
	const root = extensionTemp("workflow");
	try {
		const { add, receipt } = workflowRuns(root);
		// Written in the order the children finished, the reverse of the order the script lists them in.
		const web = add("web", "run-web", "src/web.ts");
		const api = add("api", "run-api", "src/api.ts");
		const details = receipt([["api", "run-api"], ["web", "run-web"]]);
		// Nothing but the child's run ties it to a manifest: the mission that lists run folders is optional.
		for (const shape of [details, { ...details, mission: undefined }, JSON.parse(JSON.stringify(details))]) {
			const cache = new HandoffCache(roots());
			await cache.capture(shape);
			const runs = cache.attach(viewOf(shape));
			const [first, second] = childrenOf(runs);
			assert.deepEqual([first!.label, first!.handoff?.path, cache.patch(first!.handoff!.id)[0]!.file], ["api", api, "src/api.ts"]);
			assert.deepEqual([second!.label, second!.handoff?.path, cache.patch(second!.handoff!.id)[0]!.file], ["web", web, "src/web.ts"]);
			assert.ok(first!.worktree && second!.worktree);
			const report = cache.report(shape)!;
			assert.ok(report.includes(`- api (worker): ${api}`) && report.includes(`- web (worker): ${web}`), report);
		}
	} finally { remove(root); }
});

test("a child run in this process leaves its manifest beside its artifacts, or a script returns where it is", async () => {
	const root = extensionTemp("workflow-foreground");
	try {
		const artifacts = join(root, "artifacts");
		mkdirSync(join(artifacts, "handoffs"), { recursive: true });
		const patchPath = join(artifacts, "api.patch");
		writeFileSync(patchPath, patch);
		const manifest = (runId: string) => JSON.stringify({ ...manifestFor(patchPath), runId, groups: [{ children: [{ workflowKey: "api", runId, patch: { path: patchPath, branch: "b", changed: true, filesChanged: 2, insertions: 2, deletions: 2 } }] }] });
		writeFileSync(join(artifacts, "handoffs", "run-1.json"), manifest("run-1"));
		mkdirSync(join(root, "other", "handoffs"), { recursive: true });
		const returned = join(root, "other", "handoffs", "run-2.json");
		writeFileSync(returned, manifest("run-2"));
		for (const details of [
			{ results: [{ workflowKey: "api", runId: "run-1", agent: "worker", artifactPaths: { outputPath: join(artifacts, "run-1_worker_output.md") } }] },
			{ results: [{ workflowKey: "api", runId: "run-2", agent: "worker" }], workflow: { value: { children: [{ key: "api", runId: "run-2", artifactPaths: [returned] }] } } },
			{ results: [{ workflowKey: "api", runId: "run-2", agent: "worker", artifactPaths: [returned] }] },
		]) {
			const cache = new HandoffCache(roots());
			await cache.capture(details);
			assert.equal(childrenOf(cache.attach(viewOf(details)))[0]!.handoff?.path, patchPath);
		}
	} finally { remove(root); }
});

test("a background workflow's notice names its children's runs, which its launch step shows by their keys", async () => {
	const root = extensionTemp("workflow-notice");
	try {
		const { add } = workflowRuns(root);
		const path = add("api", "run-api", "src/api.ts");
		const cache = new HandoffCache(roots());
		await cache.capture({ runs: [{ runId: "flow-1", agent: "workflow", status: "completed", childOutputs: [{ workflowKey: "api", runId: "run-api", agent: "worker", status: "completed" }] }] });
		const runs = [{ steps: [{ subagent: { asyncId: "flow-1", background: true, children: [{ label: "api" }] } }] }] as unknown as Run[];
		assert.equal(childrenOf(cache.attach(runs))[0]!.handoff?.path, path);
	} finally { remove(root); }
});

test("a missing or mismatched manifest names its writer, shows no patch and blocks its integration", async () => {
	const root = extensionTemp("workflow-missing");
	try {
		const { add, receipt, runDir } = workflowRuns(root);
		const good = add("api", "run-api", "src/api.ts");
		add("web", "run-web", "src/web.ts", "run-of-another");
		add("db", "run-db", "src/db.ts");
		rmSync(join(runDir("run-db"), "handoff.json"));
		const details = receipt([["api", "run-api"], ["web", "run-web"], ["db", "run-db"]]);
		const cache = new HandoffCache(roots());
		await cache.capture(details, { input: { workflow: "./w.js" }, cwd: root });
		const [api, web, db] = childrenOf(cache.attach(viewOf(details)));
		assert.equal(api!.handoff?.path, good);
		assert.equal(api!.handoff?.error, undefined);
		assert.match(web!.handoff?.error ?? "", /isn't this agent's/);
		assert.match(db!.handoff?.error ?? "", /is missing/);
		for (const child of [web, db]) {
			assert.equal(child!.handoff!.path, "");
			assert.deepEqual(cache.patch(child!.handoff!.id), []);
		}
		const report = cache.report(details)!;
		assert.ok(report.includes(good));
		assert.match(report, /- web \(worker\): BLOCKED, do not integrate: its patch manifest belongs to run run-of-another/);
		assert.match(report, /- db \(worker\): BLOCKED, do not integrate: its patch manifest is missing/);
		assert.ok(!report.includes(join(runDir("run-web"), "worktree-diffs")), "a blocked writer's patch path is not given out");
		assert.match(cache.refusal(`git apply ${join(runDir("run-web"), "worktree-diffs", "step-0", "task-0-worker.patch")}`) ?? "", /run-web must not be integrated/);
		assert.equal(cache.refusal(`git apply ${good}`), undefined);
		// A manifest put right is accepted when the result is read again.
		add("db", "run-db", "src/db.ts");
		await cache.capture(details, { input: { workflow: "./w.js" }, cwd: root });
		assert.equal(cache.refusal("git apply run-db.patch"), undefined);
	} finally { remove(root); }
});

test("a script says which children must leave a manifest; a reviewer, and a writer in the project folder, need none", async () => {
	const root = extensionTemp("workflow-script");
	try {
		assert.deepEqual(worktreeKeys('runs.all([{ key: "api", agent: "worker", task: "x", worktree: true }, { key: "tests", agent: "reviewer", task: "y" }, { key: "web", isolation: "worktree" }])'), ["api", "web"]);
		writeFileSync(join(root, "w.js"), 'return await runs.all([{ key: "api", agent: "worker", task: "x", worktree: true, async: false }, { key: "tests", agent: "reviewer", task: "y" }]);');
		const details = { results: [{ workflowKey: "api", runId: "gone-1", agent: "worker" }, { workflowKey: "tests", runId: "gone-2", agent: "reviewer" }] };
		const live = new HandoffCache(roots());
		await live.capture(details, { input: { workflow: "./w.js" }, cwd: root });
		const [api, tests] = childrenOf(live.attach(viewOf(details)));
		assert.match(api!.handoff?.error ?? "", /is missing/);
		assert.equal(tests!.handoff, undefined);
		// Read back later, files that were cleaned up since are not a writer's work lost.
		const reopened = new HandoffCache(roots());
		await reopened.capture(details);
		assert.equal(childrenOf(reopened.attach(viewOf(details)))[0]!.handoff, undefined);
		assert.equal(reopened.report(details), undefined);
	} finally { remove(root); }
});

test("a single call's and a notice's manifest must be the run's own", async () => {
	const root = extensionTemp("single");
	try {
		const patchPath = join(root, "a.patch");
		writeFileSync(patchPath, patch);
		const path = join(root, "handoff.json");
		writeFileSync(path, JSON.stringify({ version: 1, runId: "run-1", groups: [{ children: [{ index: 0, patch: { path: patchPath, branch: "b", changed: true, filesChanged: 2, insertions: 2, deletions: 2 } }] }] }));
		const single = (runId: string) => ({ mode: "single", runId, results: [{ index: 0, agent: "worker", exitCode: 0 }], parallelHandoff: { version: 1, path } });
		const cache = new HandoffCache(roots());
		await cache.capture(single("run-1"));
		assert.equal(childrenOf(cache.attach(viewOf(single("run-1"))))[0]!.handoff?.path, patchPath);
		assert.ok(cache.report(single("run-1"))!.includes(`- worker: ${patchPath}`));
		const other = new HandoffCache(roots());
		await other.capture(single("run-2"));
		const child = childrenOf(other.attach(viewOf(single("run-2"))))[0]!;
		assert.equal(child.handoff?.path, "");
		assert.match(child.handoff?.error ?? "", /isn't this agent's/);
		assert.match(other.report(single("run-2"))!, /run run-2: BLOCKED/);
		const notice = new HandoffCache(roots());
		await notice.capture({ runs: [{ runId: "run-3", handoffPath: path }] });
		assert.match(notice.refusal("git apply /x/run-3/a.patch") ?? "", /must not be integrated/);
	} finally { remove(root); }
});

test("the main agent's result carries the validated patch paths, and a blocked writer's command does not run", async () => {
	const root = extensionTemp("hooks");
	try {
		const { add, receipt } = workflowRuns(root);
		const good = add("api", "run-api", "src/api.ts");
		add("web", "run-web", "src/web.ts", "run-of-another");
		const details = receipt([["api", "run-api"], ["web", "run-web"]]);
		const handlers: Record<string, (event: any, ctx?: any) => Promise<any>> = {};
		delegationHooks({
			app: "code",
			changes: { beforeCommand: async () => {}, afterCommand: async () => false, beforeSubagents: async () => {} },
			handoffs: new HandoffCache(roots()),
			background: { launched: () => {}, finished: async () => {} },
			changing: (event) => event.toolName === "bash",
			afterSubagents: async () => {},
			onChanges: async () => {},
			onNotice: async () => {},
		})({ on: (name: string, handler: (typeof handlers)[string]) => (handlers[name] = handler) } as never);
		const input = { workflow: "./w.js", async: false };
		await handlers.tool_call!({ toolName: "subagent", toolCallId: "1", input });
		const result = await handlers.tool_result!({ toolName: "subagent", toolCallId: "1", input, details, content: [{ type: "text", text: "Workflow completed." }] }, { cwd: root });
		assert.equal(result.content[0].text, "Workflow completed.");
		assert.ok(result.content[1].text.includes(good));
		assert.match(result.content[1].text, /- web \(worker\): BLOCKED/);
		const blocked = await handlers.tool_call!({ toolName: "bash", toolCallId: "2", input: { command: "git apply /tmp/run-web/a.patch" } });
		assert.equal(blocked?.block, true);
		assert.equal(await handlers.tool_call!({ toolName: "bash", toolCallId: "3", input: { command: `git apply ${good}` } }), undefined);
		await handlers.tool_result!({ toolName: "bash", toolCallId: "3", input: {}, content: [] });
		const plain = await handlers.tool_result!({ toolName: "subagent", toolCallId: "4", input: { agent: "scout" }, details: { results: [{ agent: "scout" }] }, content: [] });
		assert.equal(plain, undefined, "a result that hands nothing back is left as it is");
	} finally { remove(root); }
});
