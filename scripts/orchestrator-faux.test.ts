import assert from "node:assert/strict";
import { dirname } from "node:path";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import faux from "../dev/faux-extension.ts";
import { HandoffCache, manifestOf } from "../src/main/handoffs.ts";
import { subagentOf } from "../src/main/subagents.ts";

test("the faux workflow exercises plan, waiting, failure, eight children, timeout and real handoff patches", async () => {
	let execute: Function = () => {};
	faux({
		registerProvider: () => {},
		registerTool: (tool: { name: string; execute: Function }) => { if (tool.name === "subagent") execute = tool.execute; },
	} as unknown as ExtensionAPI);
	const roots = new Set<string>();
	try {
		await Promise.all(["orchestrator", "orchestrator eight"].map(async (scenario) => {
			let plan = false;
			let waiting = false;
			let count = 0;
			const result = await execute("faux-run", { workflow: true, options: { scenario } }, undefined, (update: { details: any }) => {
				const path = update.details.parallelHandoff?.path;
				if (path) roots.add(dirname(path));
				const view = subagentOf({ workflow: true }, update.details, "running");
				plan ||= view.children.every((child) => child.status === "pending");
				waiting ||= view.children.some((child) => child.waitingOn === "main");
				count = Math.max(count, view.children.length);
			});
			assert.equal(plan, true);
			const view = subagentOf({ workflow: true }, result.details, "done");
			assert.equal(count, scenario.includes("eight") ? 8 : 3);
			assert.ok(view.children.some((child) => child.status === "error"));
			if (scenario.includes("eight")) {
				assert.ok(view.children.some((child) => child.timedOut));
			} else {
				assert.equal(waiting, true);
				const path = result.details.parallelHandoff.path;
				const manifest = manifestOf(JSON.parse(await readFile(path, "utf8")))!;
				assert.equal(manifest.children.length, 2);
				assert.equal(manifest.kept.length, 1);
				const cache = new HandoffCache();
				await cache.capture(result.details);
				const runs = [{ steps: [{ subagent: view }] }] as any;
				cache.attach(runs);
				assert.equal(cache.patch(view.children[0]!.handoff!.id).length, 2);
			}
		}));
	} finally {
		for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
