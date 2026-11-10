import assert from "node:assert/strict";
import test from "node:test";
import { editorArgs, editorUrl } from "../src/main/editor.ts";

test("VS Code's executable opens a file at a line with --goto, or just the file", () => {
	const file = process.platform === "win32" ? "C:\\work\\my notes #2.md" : "/work/my notes #2.md";
	assert.deepEqual(editorArgs(file, 12), ["--goto", `${file}:12`]);
	assert.deepEqual(editorArgs(file), [file]);
	assert.deepEqual(editorArgs(file, 0), [file]);
});

test("a file opens in VS Code by its absolute path, at a line when given", () => {
	if (process.platform === "win32") {
		assert.equal(editorUrl("C:\\work\\shop\\src\\cart.ts"), "vscode://file/C:/work/shop/src/cart.ts");
		assert.equal(editorUrl("C:\\work\\shop\\src\\cart.ts", 12), "vscode://file/C:/work/shop/src/cart.ts:12");
		assert.equal(editorUrl("\\\\nas\\team\\notes.md"), "vscode://file//nas/team/notes.md");
	} else {
		assert.equal(editorUrl("/work/shop/src/cart.ts"), "vscode://file/work/shop/src/cart.ts");
		assert.equal(editorUrl("/work/shop/src/cart.ts", 12), "vscode://file/work/shop/src/cart.ts:12");
	}
});

test("characters a URL would read differently are escaped in the path", () => {
	const root = process.platform === "win32" ? "C:\\work\\" : "/work/";
	const prefix = process.platform === "win32" ? "vscode://file/C:/work/" : "vscode://file/work/";
	assert.equal(editorUrl(`${root}my notes #2 (100%).md`), `${prefix}my%20notes%20%232%20(100%25).md`);
});

test("a line that isn't a positive number is left off", () => {
	const file = process.platform === "win32" ? "C:\\a.ts" : "/a.ts";
	for (const line of [0, -3, Number.NaN]) assert.doesNotMatch(editorUrl(file, line), /:\d+$/);
	assert.match(editorUrl(file, 7.6), /:7$/);
});
