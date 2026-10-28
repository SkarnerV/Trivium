import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { activeBuiltIns, dropClashingBuiltIns, ensurePermissionConfig, packageDir, readPermissions, writePermissionLevel } from "../src/main/builtin-packages.ts";
import { DEFAULT_PERMISSION_LEVEL, PERMISSION_LEVELS, permissionLevelOf } from "../src/shared/permissions.ts";
import { APP_IDS } from "../src/shared/protocol.ts";
import { builtInPackages } from "../src/shared/recommended.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };

test("each app ships the chosen packages", () => {
	assert.deepEqual(builtInPackages("code"), ["@gotgenes/pi-permission-system", "@pify/memory", "@narumitw/pi-plan-mode", "pi-subagents"]);
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
		["@gotgenes/pi-permission-system", "@pify/memory", "@narumitw/pi-plan-mode", "pi-subagents"],
	);
	const installed = ["npm:pi-subagents@0.80.0", { source: "npm:@narumitw/pi-plan-mode" }];
	assert.deepEqual(activeBuiltIns("code", ["@gotgenes/pi-permission-system"], installed, find).map((entry) => entry.name), ["@pify/memory"]);
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

test("the starting permission policy is written once and never over the user's own", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trivium-perm-"));
	try {
		const file = join(agentDir, "extensions", "pi-permission-system", "config.json");
		ensurePermissionConfig(agentDir);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { permission: DEFAULT_PERMISSION_LEVEL.permission });
		writeFileSync(file, '{"permission":{"*":"ask"}}');
		ensurePermissionConfig(agentDir);
		assert.equal(readFileSync(file, "utf8"), '{"permission":{"*":"ask"}}');
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a level is recognized in the config, and anything else is the user's own", () => {
	for (const level of PERMISSION_LEVELS) assert.equal(permissionLevelOf({ permission: structuredClone(level.permission) })?.id, level.id);
	const auto = DEFAULT_PERMISSION_LEVEL.permission;
	// Surfaces in another order are the same policy; patterns in another order are not, since the last match wins.
	assert.equal(permissionLevelOf({ permission: Object.fromEntries(Object.entries(auto).reverse()) })?.id, "auto");
	const bash = auto.bash as Record<string, string>;
	assert.equal(permissionLevelOf({ permission: { ...auto, bash: Object.fromEntries(Object.entries(bash).reverse()) } }), undefined);
	assert.equal(permissionLevelOf({ permission: { ...auto, read: "ask" } }), undefined);
	assert.equal(permissionLevelOf({ permission: auto, yoloMode: true }), undefined);
	assert.equal(permissionLevelOf({}), undefined);
});

test("choosing a level keeps the config's other settings and drops yolo mode", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trivium-perm-"));
	try {
		assert.deepEqual(readPermissions(agentDir), { path: join(agentDir, "extensions", "pi-permission-system", "config.json"), level: "auto" });
		await writePermissionLevel(agentDir, "ask");
		const file = readPermissions(agentDir).path;
		writeFileSync(file, JSON.stringify({ debugLog: true, yoloMode: true, permission: { "*": "deny" } }));
		assert.equal(readPermissions(agentDir).level, "custom");
		await writePermissionLevel(agentDir, "bypass");
		const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.equal(written.debugLog, true);
		assert.equal("yoloMode" in written, false);
		assert.equal(readPermissions(agentDir).level, "bypass");
		// A file with comments is the user's to edit; Trivium neither reads a level from it nor rewrites it.
		writeFileSync(file, '{\n  // mine\n  "permission": {}\n}');
		assert.deepEqual(readPermissions(agentDir), { path: file, level: "custom", unreadable: true });
		await assert.rejects(writePermissionLevel(agentDir, "auto"), /isn't plain JSON/);
		assert.match(readFileSync(file, "utf8"), /\/\/ mine/);
		await assert.rejects(writePermissionLevel(agentDir, "loose"), /Unknown permission level/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
