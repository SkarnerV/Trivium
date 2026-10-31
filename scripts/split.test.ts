import assert from "node:assert/strict";
import test from "node:test";
import { placeInSplit, showInSplit, visibleSessions, withoutSessions } from "../src/renderer/split.ts";

test("opening a session beside the one on screen puts it on the right, or in the half it was dropped on", () => {
	assert.deepEqual(placeInSplit(undefined, "a", "b"), ["a", "b"]);
	assert.deepEqual(placeInSplit(undefined, "a", "b", 1), ["a", "b"]);
	assert.deepEqual(placeInSplit(undefined, "a", "b", 0), ["b", "a"]);
});

test("a session has nothing to pair with when nothing else is on screen", () => {
	assert.equal(placeInSplit(undefined, undefined, "b"), undefined);
	assert.equal(placeInSplit(undefined, "a", "a"), undefined);
});

test("in a split, a new session takes the half not focused unless it is dropped on one", () => {
	assert.deepEqual(placeInSplit(["a", "b"], "a", "c"), ["a", "c"]);
	assert.deepEqual(placeInSplit(["a", "b"], "b", "c"), ["c", "b"]);
	assert.deepEqual(placeInSplit(["a", "b"], "a", "c", 0), ["c", "b"]);
});

test("a session already in the split stays where it is", () => {
	assert.deepEqual(placeInSplit(["a", "b"], "a", "b", 0), ["a", "b"]);
	assert.deepEqual(showInSplit(["a", "b"], "a", "b"), ["a", "b"]);
});

test("a click in the sidebar replaces the focused half", () => {
	assert.deepEqual(showInSplit(["a", "b"], "a", "c"), ["c", "b"]);
	assert.deepEqual(showInSplit(["a", "b"], "b", "c"), ["a", "c"]);
	assert.equal(showInSplit(undefined, "a", "c"), undefined);
});

test("deleting a session in the split closes it and selects the one left", () => {
	const gone = (path: string) => path === "b";
	assert.deepEqual(withoutSessions({ code: ["a", "b"] }, { code: "b" }, gone), { split: {}, selected: { code: "a" } });
	assert.deepEqual(withoutSessions({ code: ["a", "b"] }, { code: "a" }, gone), { split: {}, selected: { code: "a" } });
	assert.deepEqual(withoutSessions({ code: ["a", "c"] }, { code: "c", write: "b" }, gone), { split: { code: ["a", "c"] }, selected: { code: "c" } });
});

test("a split whose selected session is not one of its halves selects the left one", () => {
	assert.deepEqual(withoutSessions({ code: ["a", "c"] }, { code: "x" }, () => false), { split: { code: ["a", "c"] }, selected: { code: "a" } });
	assert.deepEqual(withoutSessions({ code: ["a", "a"] }, { code: "a" }, () => false), { split: {}, selected: { code: "a" } });
});

test("the sessions on screen are both halves of a split, else the selected one", () => {
	assert.deepEqual(visibleSessions(["a", "b"], "b"), ["a", "b"]);
	assert.deepEqual(visibleSessions(undefined, "a"), ["a"]);
	assert.deepEqual(visibleSessions(undefined, undefined), []);
});
