import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bundles, dist } from "./bundles.mjs";

/**
 * electron-builder packages only the dist files its config lists. A bundle built into dist and left off that list
 * works in development and is missing from the packaged app, where whatever loads it by path fails.
 */
test("every bundle built into dist is packaged", () => {
	const config = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
	const packaged = [...config.matchAll(/^\s+- (dist\/\S+)\s*$/gm)].map((match) => match[1]);
	for (const [name, bundle] of Object.entries(bundles)) {
		if (!("outfile" in bundle)) continue;
		const file = `dist/${bundle.outfile.slice(dist.length)}`;
		assert.ok(packaged.includes(file), `${name} is built to ${file}, which electron-builder.yml does not package`);
	}
});
