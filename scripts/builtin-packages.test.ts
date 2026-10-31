import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { activeBuiltIns, dropClashingBuiltIns, legacyPermissionMode, packageDir } from "../src/main/builtin-packages.ts";
import { APP_IDS } from "../src/shared/protocol.ts";
import { builtInPackages } from "../src/shared/recommended.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };

test("each app ships the chosen packages", () => {
	assert.deepEqual(builtInPackages("code"), ["@pify/memory", "@narumitw/pi-plan-mode", "pi-subagents"]);
	assert.deepEqual(builtInPackages("research"), ["pi-docparser", "@pify/memory", "pi-subagents"]);
	assert.deepEqual(builtInPackages("write"), ["@pify/memory", "pi-markdown-preview"]);
});

test("every shipped package is a pinned dependency with a pi manifest", () => {
	for (const name of new Set(APP_IDS.flatMap(builtInPackages))) {
		assert.match(manifest.dependencies[name] ?? "", /^\d+\.\d+\.\d+$/, `${name} is pinned`);
		const dir = packageDir(name);
		assert.ok(dir, `${name} is installed`);
		assert.ok((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { pi?: unknown }).pi, `${name} is a pi package`);
	}
});

test("removed packages and ones installed through pi don't load from Trivium", () => {
	const find = (name: string) => `/shipped/${name}`;
	assert.deepEqual(
		activeBuiltIns("code", [], [], find).map((entry) => entry.name),
		["@pify/memory", "@narumitw/pi-plan-mode", "pi-subagents"],
	);
	const installed = ["npm:pi-subagents@0.80.0", { source: "npm:@narumitw/pi-plan-mode" }];
	assert.deepEqual(activeBuiltIns("code", ["@pify/memory"], installed, find).map((entry) => entry.name), []);
	assert.deepEqual(activeBuiltIns("write", [], [], () => undefined), []);
});

test("a shipped package gives way to the user's own extension with the same tools", () => {
	const shipped = join(tmpdir(), "shipped", "@pify", "memory");
	const pify = join(shipped, "extensions", "index.ts");
	const theirs = join(tmpdir(), "user", "pi-memory", "index.ts");
	const plan = join(tmpdir(), "shipped", "plan", "index.ts");
	const extension = (path: string, tools: string[]) =>
		({ path, resolvedPath: path, tools: new Map(tools.map((tool) => [tool, {}])), flags: new Map() }) as unknown as Extension;
	const loaded = (): LoadExtensionsResult => ({
		extensions: [extension(theirs, ["memory_write", "memory_read"]), extension(pify, ["memory_write", "memory_read", "memory_search"]), extension(plan, ["plan"])],
		errors: [
			{ path: pify, error: `Tool "memory_write" conflicts with ${theirs}` },
			{ path: pify, error: `Tool "memory_read" conflicts with ${theirs}` },
			{ path: "/broken.ts", error: "Failed to load" },
		],
		runtime: { pendingProviderRegistrations: [{ extensionPath: pify }] } as unknown as LoadExtensionsResult["runtime"],
	});
	const result = dropClashingBuiltIns(loaded(), [shipped, dirname(plan)]);
	assert.deepEqual(result.extensions.map((entry) => entry.path), [theirs, plan]);
	assert.deepEqual(result.errors, [{ path: "/broken.ts", error: "Failed to load" }]);
	assert.deepEqual(result.runtime.pendingProviderRegistrations, []);
	// With their copy off in this app, the shipped one loads again.
	assert.deepEqual(dropClashingBuiltIns(loaded(), [shipped], new Set([theirs])).extensions.length, 3);
});

test("the old pi-permission-system policy carries over as the closest mode", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trivium-perm-"));
	try {
		assert.equal(legacyPermissionMode(agentDir), "auto");
		const file = join(agentDir, "extensions", "pi-permission-system", "config.json");
		mkdirSync(dirname(file), { recursive: true });
		const write = (config: unknown) => writeFileSync(file, JSON.stringify(config));
		write({ permission: { "*": "allow" }, yoloMode: true });
		assert.equal(legacyPermissionMode(agentDir), "bypass");
		write({ permission: { "*": "allow", bash: "ask", edit: "ask" } });
		assert.equal(legacyPermissionMode(agentDir), "ask");
		write({ permission: { "*": "allow", bash: { "*": "allow", "sudo *": "ask" } } });
		assert.equal(legacyPermissionMode(agentDir), "auto");
		writeFileSync(file, "{ // mine\n}");
		assert.equal(legacyPermissionMode(agentDir), "auto");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
