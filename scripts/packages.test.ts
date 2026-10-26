import assert from "node:assert/strict";
import test from "node:test";
import { packageSource } from "../src/shared/packages.ts";

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
