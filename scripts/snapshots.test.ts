import assert from "node:assert/strict";
import test from "node:test";
import { excludeLine, parseBatch, parseChanged } from "../src/main/snapshots.ts";

test("status against the snapshot gives what changed since, and skips what has no bytes to keep", () => {
	const zero = "0".repeat(40);
	const records = [
		// In the snapshot and unchanged.
		`1 A. N... 000000 100644 100644 ${zero} ${zero} src/same.ts`,
		`1 AM N... 000000 100644 100644 ${zero} ${zero} src/with space.ts`,
		`1 AD N... 000000 100644 000000 ${zero} ${zero} README.md`,
		`1 AT N... 000000 100644 120000 ${zero} ${zero} now-a-link`,
		// A nested repository, and a link that changed.
		`1 AM S.M. 000000 160000 160000 ${zero} ${zero} vendor/lib`,
		`1 AM N... 000000 120000 120000 ${zero} ${zero} link`,
		"? docs/new.md",
		"? other-repo/",
		"",
	];
	assert.deepEqual(parseChanged(records.join("\0")), [
		{ rel: "src/with space.ts", status: "modified" },
		{ rel: "README.md", status: "deleted" },
		{ rel: "docs/new.md", status: "added" },
	]);
});

test("batch output is read by size, so content with newlines and missing names don't shift the rest", () => {
	const oid = "a".repeat(40);
	const output = Buffer.concat([
		Buffer.from(`${oid} blob 6\n`),
		Buffer.from("a\r\nb\r\n"),
		Buffer.from("\n:gone missing\n"),
		Buffer.from(`${oid} commit 3\nxyz\n`),
		Buffer.from(`${oid} blob 0\n\n`),
		Buffer.from(`${oid} blob 3\n`),
		Buffer.from([0, 10, 255]),
		Buffer.from("\n"),
	]);
	const contents = parseBatch(output, ["crlf.txt", "gone", "vendor/lib", "empty", "logo.png"]);
	assert.deepEqual([...contents.keys()], ["crlf.txt", "empty", "logo.png"]);
	assert.deepEqual(contents.get("crlf.txt"), Buffer.from("a\r\nb\r\n"));
	assert.equal(contents.get("empty")?.length, 0);
	assert.deepEqual(contents.get("logo.png"), Buffer.from([0, 10, 255]));
});

test("an exclude line matches its one path, whatever characters it has", () => {
	assert.equal(excludeLine("data/big.bin"), "/data/big.bin\n");
	assert.equal(excludeLine("data/[raw]*?.bin"), "/data/\\[raw]\\*\\?.bin\n");
	assert.equal(excludeLine("back\\slash"), "/back\\\\slash\n");
	assert.equal(excludeLine("trailing  "), "/trailing\\ \\ \n");
	assert.equal(excludeLine("#not-a-comment"), "/#not-a-comment\n");
	assert.equal(excludeLine("two\nlines"), "");
});
