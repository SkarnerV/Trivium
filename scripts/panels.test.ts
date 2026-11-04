import assert from "node:assert/strict";
import test from "node:test";
import { panelFor, panelOpen, panelViews, shownView, workingDocument } from "../src/renderer/panels.ts";
import type { FileChange, Run, SessionView, Step } from "../src/shared/protocol.ts";

const change = (path: string, status: FileChange["status"] = "modified") => ({ path, status }) as FileChange;
const write = (changes: FileChange[]) => ({ app: "write", changes }) as SessionView;
const step = (tool: string, target: string, status: Step["status"] = "done") => ({ tool, target, status }) as Step;
const runs = (...steps: Step[]) => [{ steps }] as Run[];

test("Write has its documents, and Review only while there are edits to look at", () => {
	assert.deepEqual(panelViews(write([]), undefined), ["preview"]);
	assert.deepEqual(panelViews(write([change("a.md")]), undefined), ["preview", "review"]);
	assert.deepEqual(panelViews(write([change("a.md", "deleted")]), undefined), ["preview"]);
});

test("Code keeps the tabs the user opened", () => {
	const code = { app: "code", changes: [] } as unknown as SessionView;
	assert.deepEqual(panelViews(code, undefined), ["session"]);
	assert.deepEqual(panelViews(code, ["session", "services"]), ["session", "services"]);
});

test("edits bring Review forward, unless the user picked Preview", () => {
	const edited = panelViews(write([change("a.md")]), undefined);
	assert.equal(shownView(edited, undefined), "review");
	assert.equal(shownView(edited, "preview"), "preview");
});

test("Preview comes back once nothing is left to review, even after picking Review", () => {
	assert.equal(shownView(panelViews(write([]), undefined), "review"), "preview");
});

test("the panel stays closed until there is a document, and stays as the user set it", () => {
	assert.equal(panelFor("write", write([])), undefined);
	assert.equal(panelOpen("write", write([]), undefined), false);
	assert.equal(panelOpen("write", write([]), false), true);
	assert.equal(panelOpen("write", write([change("a.md")]), true), false);
});

test("a document the session read shows while none is open", () => {
	assert.equal(workingDocument(runs(step("read", "notes/spec.md")), true), "notes/spec.md");
	assert.equal(workingDocument(runs(step("read", "a.md"), step("read", "b.txt")), true), "b.txt");
	assert.equal(workingDocument(runs(step("read", "notes/spec.md")), false), undefined);
});

test("only documents count as reading, and only finished steps count at all", () => {
	assert.equal(workingDocument(runs(step("read", "src/main.ts")), true), undefined);
	assert.equal(workingDocument(runs(step("read", "a.md", "running")), true), undefined);
	assert.equal(workingDocument(runs(step("read", "a.md", "error")), true), undefined);
	assert.equal(workingDocument(runs(step("grep", "a.md")), true), undefined);
});

test("the file the session edited last wins, open documents or not", () => {
	const steps = runs(step("read", "a.md"), step("edit", "b.tex"), step("read", "c.md"));
	assert.equal(workingDocument(steps, true), "b.tex");
	assert.equal(workingDocument(steps, false), "b.tex");
	assert.equal(workingDocument([...runs(step("edit", "a.md")), ...runs(step("write", "b.md"))], false), "b.md");
});
