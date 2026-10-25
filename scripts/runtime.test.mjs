import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import test from "node:test";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";
import { prepareRuntime, root } from "./runtime.mjs";

const require = createRequire(import.meta.url);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const iconBytes = (icon) => Buffer.from(icon.isRaw() ? icon.bin : icon.generate());

test("Windows launcher has Trivium icons and metadata without changing Electron", { skip: process.platform !== "win32" }, async () => {
	const source = require("electron");
	const sourceHash = hash(await readFile(source));
	const executable = await prepareRuntime();
	assert.notEqual(executable, source);
	assert.equal(basename(executable), "Trivium.exe");
	assert.equal(hash(await readFile(source)), sourceHash);

	const binary = NtExecutable.from(await readFile(executable));
	const resources = NtExecutableResource.from(binary);
	const expected = Data.IconFile.from(await readFile(join(root, "src/assets/trivium-icon.ico")))
		.icons.map(({ data }) => hash(iconBytes(data)));
	const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
	assert.ok(groups.length > 0);
	for (const group of groups) {
		assert.deepEqual(group.getIconItemsFromEntries(resources.entries).map((icon) => hash(iconBytes(icon))), expected);
	}
	const versions = Resource.VersionInfo.fromEntries(resources.entries);
	assert.ok(versions.length > 0);
	for (const version of versions) {
		for (const language of version.getAllLanguagesForStringValues()) {
			const strings = version.getStringValues(language);
			assert.equal(strings.ProductName, "Trivium");
			assert.equal(strings.FileDescription, "Trivium");
			assert.equal(strings.OriginalFilename, "Trivium.exe");
		}
	}
	const before = await stat(executable);
	assert.equal(await prepareRuntime(), executable);
	assert.equal((await stat(executable)).mtimeMs, before.mtimeMs, "cached runtime should not be rewritten");
});
