import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isInside, looksBinary, READER_SCHEME, ReaderStore, readerCsp, readerKind, resolveRequest } from "../src/main/reader.ts";
import { filePath, parseTable } from "../src/renderer/preview.ts";

/** A project with a report page beside its stylesheet and chart, and a secret outside it. */
function setup() {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-reader-")));
	const project = join(root, "shop");
	mkdirSync(join(project, "report"), { recursive: true });
	writeFileSync(join(project, "report", "index.html"), '<link rel="stylesheet" href="style.css"><img src="../chart.png">');
	writeFileSync(join(project, "report", "style.css"), "body { color: red }");
	writeFileSync(join(project, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
	writeFileSync(join(root, "secret.txt"), "password");
	return { root, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a path counts as inside its root, never a sibling that shares its name", () => {
	const root = join(tmpdir(), "shop");
	assert.equal(isInside(root, root), true);
	assert.equal(isInside(root, join(root, "src", "cart.ts")), true);
	assert.equal(isInside(root, join(tmpdir(), "shop-old", "cart.ts")), false);
	assert.equal(isInside(root, join(root, "..", "secret.txt")), false);
	assert.equal(isInside(root, join(root, "..file")), true);
	if (process.platform === "win32") assert.equal(isInside("C:\\Work\\Shop", "c:\\work\\shop\\a.ts"), true);
});

test("requests stay inside the root, however the path is written", async () => {
	const { project, root, cleanup } = setup();
	try {
		assert.equal(await resolveRequest(project, "/report/index.html"), join(project, "report", "index.html"));
		assert.equal(await resolveRequest(project, "/report/../chart.png"), join(project, "chart.png"));
		assert.equal(await resolveRequest(project, "/../secret.txt"), undefined);
		assert.equal(await resolveRequest(project, "/%2e%2e/secret.txt"), undefined);
		assert.equal(await resolveRequest(project, "/..%2fsecret.txt"), undefined);
		assert.equal(await resolveRequest(project, "/..%5csecret.txt"), undefined);
		assert.equal(await resolveRequest(project, "/report%00.html"), undefined);
		assert.equal(await resolveRequest(project, "/%E0%A4%A"), undefined);
		assert.equal(await resolveRequest(project, "/missing.html"), undefined);
		assert.equal(await resolveRequest(root, "/secret.txt"), join(root, "secret.txt"));
	} finally {
		cleanup();
	}
});

test("a link inside the root that leads out of it is refused", async (t) => {
	const { project, root, cleanup } = setup();
	try {
		// A junction to a folder needs no special rights on Windows, unlike a link to a file.
		mkdirSync(join(root, "private"));
		writeFileSync(join(root, "private", "keys.txt"), "password");
		symlinkSync(join(root, "private"), join(project, "vendor"), "junction");
		assert.equal(await resolveRequest(project, "/vendor/keys.txt"), undefined);
		try {
			symlinkSync(join(root, "secret.txt"), join(project, "leak.txt"));
		} catch {
			// Windows needs Developer Mode or admin rights to link a file.
			t.diagnostic("file links are not available here");
			return;
		}
		assert.equal(await resolveRequest(project, "/leak.txt"), undefined);
	} finally {
		cleanup();
	}
});

test("the kind comes from the extension, else from whether the bytes are text", () => {
	const text = new TextEncoder().encode("hello\n");
	assert.equal(readerKind("report/index.html", text), "html");
	assert.equal(readerKind("README.md", text), "markdown");
	assert.equal(readerKind("logo.svg", text), "image");
	assert.equal(readerKind("chart.PNG", new Uint8Array([0x89, 0])), "image");
	assert.equal(readerKind("paper.pdf", new Uint8Array([0x25, 0])), "pdf");
	assert.equal(readerKind("results.tsv", text), "table");
	assert.equal(readerKind("src/cart.ts", text), "text");
	assert.equal(readerKind("Makefile", text), "text");
	assert.equal(readerKind("build.zip", new Uint8Array([0x50, 0x4b, 3, 4, 0])), "binary");
});

test("text cut off partway through a character is still text, but bytes that are not UTF-8 are binary", () => {
	const euro = new TextEncoder().encode("price: 5€");
	assert.equal(looksBinary(euro.subarray(0, euro.length - 1)), false);
	assert.equal(looksBinary(new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x41])), true);
	assert.equal(looksBinary(new Uint8Array([0x68, 0x00, 0x69])), true);
});

test("pages load only their own files, and run scripts only when allowed", () => {
	assert.match(readerCsp(false), /script-src 'none'/);
	assert.match(readerCsp(true), new RegExp(`script-src ${READER_SCHEME}: 'unsafe-inline'`));
	for (const scripts of [false, true]) {
		assert.match(readerCsp(scripts), /connect-src 'none'/);
		assert.match(readerCsp(scripts), /form-action 'none'/);
		assert.doesNotMatch(readerCsp(scripts), /https?:/);
	}
});

test("an open page is served with its neighbours, and nothing once it is closed", async () => {
	const { project, cleanup } = setup();
	const store = new ReaderStore(() => {});
	try {
		const page = await store.open(join(project, "report", "index.html"), project, "report/index.html");
		assert.equal(page.kind, "html");
		assert.match(page.url!, new RegExp(`^${READER_SCHEME}://[0-9a-f]{32}/report/index\\.html\\?v=\\d+$`));
		assert.match(page.text!, /stylesheet/);
		const base = `${READER_SCHEME}://${page.id}`;
		const served = await store.respond(new Request(`${base}/report/index.html`));
		assert.equal(served.status, 200);
		assert.match(served.headers.get("Content-Type")!, /^text\/html/);
		assert.match(served.headers.get("Content-Security-Policy")!, /script-src 'none'/);
		assert.equal((await store.respond(new Request(`${base}/report/style.css`))).headers.get("Content-Type"), "text/css; charset=utf-8");
		assert.equal((await store.respond(new Request(`${base}/chart.png`))).status, 200);
		assert.equal((await store.respond(new Request(`${base}/report/`))).status, 404);
		assert.equal((await store.respond(new Request(`${READER_SCHEME}://${"0".repeat(32)}/chart.png`))).status, 404);

		const scripted = await store.setScripts(page.id, true);
		assert.notEqual(scripted.id, page.id);
		assert.equal(scripted.scripts, true);
		assert.equal((await store.respond(new Request(`${base}/chart.png`))).status, 404);
		const csp = (await store.respond(new Request(`${READER_SCHEME}://${scripted.id}/report/index.html`))).headers.get("Content-Security-Policy");
		assert.match(csp!, /script-src trivium-file: 'unsafe-inline'/);

		store.close(scripted.id);
		assert.equal((await store.respond(new Request(`${READER_SCHEME}://${scripted.id}/report/index.html`))).status, 404);
		await assert.rejects(store.reload(scripted.id), /no longer open/);
	} finally {
		store.dispose();
		cleanup();
	}
});

test("images come as a URL, text as text, and a long file is cut at a whole line", async () => {
	const { project, cleanup } = setup();
	const store = new ReaderStore(() => {});
	try {
		const image = await store.open(join(project, "chart.png"), project, "chart.png");
		assert.equal(image.kind, "image");
		assert.equal(image.text, undefined);
		assert.ok(image.url);

		const line = "PASS a test that took a while\n";
		writeFileSync(join(project, "test.log"), line.repeat(Math.ceil((2 * 1024 * 1024) / line.length) + 10));
		const log = await store.open(join(project, "test.log"), project, "test.log");
		assert.equal(log.kind, "text");
		assert.equal(log.truncated, true);
		assert.equal(log.url, undefined);
		assert.ok(log.text!.endsWith("a while"));
		assert.ok(log.text!.length <= 2 * 1024 * 1024);
	} finally {
		store.dispose();
		cleanup();
	}
});

test("file paths in a reply are told apart from other code", () => {
	assert.equal(filePath("src/main.ts"), "src/main.ts");
	assert.equal(filePath("./report/index.html"), "./report/index.html");
	assert.equal(filePath("README.md:12"), "README.md");
	assert.equal(filePath("src\\cart.ts:4:2"), "src\\cart.ts");
	assert.equal(filePath("C:\\work\\shop\\a.json"), "C:\\work\\shop\\a.json");
	assert.equal(filePath("package.json"), "package.json");
	assert.equal(filePath("npm test"), undefined);
	assert.equal(filePath("https://example.com/a.html"), undefined);
	assert.equal(filePath("v1.2"), undefined);
	assert.equal(filePath("foo()"), undefined);
	assert.equal(filePath("src/"), undefined);
});

test("tables keep quoted separators, quotes and line breaks in their cells", () => {
	const { rows, more } = parseTable('suite,note\napi,"fast, mostly"\nui,"said ""ok"""\ncli,"two\nlines"\r\n', ",");
	assert.deepEqual(rows, [
		["suite", "note"],
		["api", "fast, mostly"],
		["ui", 'said "ok"'],
		["cli", "two\nlines"],
	]);
	assert.equal(more, false);
	assert.deepEqual(parseTable("a\tb\n1\t2", "\t").rows, [
		["a", "b"],
		["1", "2"],
	]);
	const long = parseTable("n\n1\n2\n3\n4\n", ",", 2);
	assert.equal(long.rows.length, 3);
	assert.equal(long.more, true);
});
