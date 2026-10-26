import assert from "node:assert/strict";
import test from "node:test";
import { packageName, packageSource } from "../src/shared/packages.ts";

test("package sources: gallery links and bare names become npm, repo paths become git", () => {
	assert.equal(packageSource("https://pi.dev/packages/pi-mcp-adapter"), "npm:pi-mcp-adapter");
	assert.equal(packageSource("https://pi.dev/packages/@andares/pi-toolkits/"), "npm:@andares/pi-toolkits");
	assert.equal(packageSource("  pi-mcp-adapter "), "npm:pi-mcp-adapter");
	assert.equal(packageSource("@example/pi-tools@1.0.0"), "npm:@example/pi-tools@1.0.0");
	assert.equal(packageSource("github.com/example/pi-tools@v1"), "git:github.com/example/pi-tools@v1");
	for (const kept of ["npm:@example/pi-tools", "git:github.com/example/pi-tools", "https://github.com/example/pi-tools", "git@github.com:example/pi-tools.git"]) {
		assert.equal(packageSource(kept), kept);
	}
	assert.throws(() => packageSource(""));
	assert.throws(() => packageSource("not a package"));
});

test("package names drop npm: and the version", () => {
	assert.equal(packageName("npm:pi-web-access"), "pi-web-access");
	assert.equal(packageName("npm:pi-web-access@0.44.0"), "pi-web-access");
	assert.equal(packageName("npm:@gotgenes/pi-permission-system@41.0.0"), "@gotgenes/pi-permission-system");
	assert.equal(packageName("@narumitw/pi-plan-mode"), "@narumitw/pi-plan-mode");
	assert.equal(packageName("git:github.com/example/pi-tools@v1"), "git:github.com/example/pi-tools@v1");
});
