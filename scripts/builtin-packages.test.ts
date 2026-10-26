import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeBuiltIns, ensurePermissionConfig, packageDir, readPermissions, writePermissionLevel } from "../src/main/builtin-packages.ts";
import { DEFAULT_PERMISSION_LEVEL, PERMISSION_LEVELS, permissionLevelOf } from "../src/shared/permissions.ts";
import { APP_IDS } from "../src/shared/protocol.ts";
import { builtInPackages } from "../src/shared/recommended.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };

test("each app ships the chosen packages", () => {
	assert.deepEqual(builtInPackages("code"), ["@gotgenes/pi-permission-system", "@narumitw/pi-plan-mode", "pi-subagents"]);
	assert.deepEqual(builtInPackages("research"), ["pi-docparser", "pi-memory", "pi-subagents"]);
	assert.deepEqual(builtInPackages("write"), ["pi-markdown-preview"]);
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
		["@gotgenes/pi-permission-system", "@narumitw/pi-plan-mode", "pi-subagents"],
	);
	const installed = ["npm:pi-subagents@0.80.0", { source: "npm:@narumitw/pi-plan-mode" }];
	assert.deepEqual(activeBuiltIns("code", ["@gotgenes/pi-permission-system"], installed, find), []);
	assert.deepEqual(activeBuiltIns("write", [], [], () => undefined), []);
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
	const risky = DEFAULT_PERMISSION_LEVEL.permission;
	// Surfaces in another order are the same policy; patterns in another order are not, since the last match wins.
	assert.equal(permissionLevelOf({ permission: Object.fromEntries(Object.entries(risky).reverse()) })?.id, "risky");
	const bash = risky.bash as Record<string, string>;
	assert.equal(permissionLevelOf({ permission: { ...risky, bash: Object.fromEntries(Object.entries(bash).reverse()) } }), undefined);
	assert.equal(permissionLevelOf({ permission: { ...risky, read: "ask" } }), undefined);
	assert.equal(permissionLevelOf({ permission: risky, yoloMode: true }), undefined);
	assert.equal(permissionLevelOf({}), undefined);
});

test("choosing a level keeps the config's other settings and drops yolo mode", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "trivium-perm-"));
	try {
		assert.deepEqual(readPermissions(agentDir), { path: join(agentDir, "extensions", "pi-permission-system", "config.json"), level: "risky" });
		await writePermissionLevel(agentDir, "changes");
		const file = readPermissions(agentDir).path;
		writeFileSync(file, JSON.stringify({ debugLog: true, yoloMode: true, permission: { "*": "deny" } }));
		assert.equal(readPermissions(agentDir).level, "custom");
		await writePermissionLevel(agentDir, "commands");
		const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.equal(written.debugLog, true);
		assert.equal("yoloMode" in written, false);
		assert.equal(readPermissions(agentDir).level, "commands");
		// A file with comments is the user's to edit; Trivium neither reads a level from it nor rewrites it.
		writeFileSync(file, '{\n  // mine\n  "permission": {}\n}');
		assert.deepEqual(readPermissions(agentDir), { path: file, level: "custom", unreadable: true });
		await assert.rejects(writePermissionLevel(agentDir, "risky"), /isn't plain JSON/);
		assert.match(readFileSync(file, "utf8"), /\/\/ mine/);
		await assert.rejects(writePermissionLevel(agentDir, "loose"), /Unknown permission level/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
