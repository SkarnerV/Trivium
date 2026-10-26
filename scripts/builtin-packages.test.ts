import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeBuiltIns, ensurePermissionConfig, packageDir, STARTER_PERMISSIONS } from "../src/main/builtin-packages.ts";
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
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), STARTER_PERMISSIONS);
		writeFileSync(file, '{"permission":{"*":"ask"}}');
		ensurePermissionConfig(agentDir);
		assert.equal(readFileSync(file, "utf8"), '{"permission":{"*":"ask"}}');
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
