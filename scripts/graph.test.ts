import assert from "node:assert/strict";
import test from "node:test";
import { GRAPH_COLORS, layoutGraph, linesBelow } from "../src/renderer/graph.ts";

const commit = (id: string, ...parents: string[]) => ({ id, parents });

test("a straight history stays in one column", () => {
	const { rows, lanes } = layoutGraph([commit("c", "b"), commit("b", "a"), commit("a")]);
	assert.equal(lanes, 1);
	assert.deepEqual(rows.map((row) => row.lane), [0, 0, 0]);
	assert.deepEqual(rows[0]!.into, [], "the newest commit has nothing above it");
	assert.deepEqual(rows[1]!.into, [{ lane: 0, color: 0 }]);
	assert.deepEqual(rows[2]!.out, [], "the first commit has no parent");
});

test("a branch runs beside its parent's line and joins at the commit it forked from", () => {
	// feature: e - d, forked from b; main: c - b - a.
	const { rows, lanes } = layoutGraph([commit("c", "b"), commit("e", "d"), commit("d", "b"), commit("b", "a"), commit("a")]);
	assert.equal(lanes, 2);
	assert.equal(rows[1]!.lane, 1);
	assert.deepEqual(rows[1]!.through.map((line) => line.lane), [0]);
	assert.equal(rows[2]!.lane, 1, "the branch keeps its column down to the fork");
	assert.deepEqual(rows[3]!.into.map((line) => line.lane), [0, 1]);
	assert.equal(rows[3]!.lane, 0);
	assert.deepEqual(rows[3]!.through, []);
	assert.equal(rows[4]!.lane, 0);
});

test("a merge opens a column for the branch it brought in, which ends at the fork", () => {
	const { rows } = layoutGraph([commit("m", "c", "f"), commit("c", "b"), commit("f", "b"), commit("b")]);
	assert.deepEqual(rows[0]!.out.map((line) => line.lane), [0, 1]);
	assert.notEqual(rows[0]!.out[0]!.color, rows[0]!.out[1]!.color);
	assert.equal(rows[2]!.lane, 1);
	assert.deepEqual(rows[3]!.into.map((line) => line.lane), [0, 1]);
	assert.deepEqual(rows[3]!.out, []);
});

test("a merge's second parent shares a column already leading to it", () => {
	const { rows, lanes } = layoutGraph([commit("t", "f"), commit("m", "c", "f"), commit("c", "f"), commit("f")]);
	assert.equal(lanes, 2);
	assert.deepEqual(rows[1]!.out.map((line) => line.lane), [1, 0]);
});

test("a freed column is used again, keeping the graph narrow", () => {
	const { lanes } = layoutGraph([commit("a2", "a1"), commit("b2", "b1"), commit("b1"), commit("c2", "c1"), commit("c1"), commit("a1")]);
	assert.equal(lanes, 2);
});

test("a parent past the end of the list leaves its line running", () => {
	const { rows } = layoutGraph([commit("b", "a")]);
	assert.deepEqual(rows[0]!.out, [{ lane: 0, color: 0 }]);
});

test("colors stay within the ones styles.css has", () => {
	const commits = Array.from({ length: GRAPH_COLORS * 3 }, (_, index) => commit(`tip${index}`));
	assert.ok(layoutGraph(commits).rows.every((row) => row.color < GRAPH_COLORS));
});

test("the lines below a commit are what ran past it and what leaves it, once each", () => {
	const { rows } = layoutGraph([commit("t", "f"), commit("m", "c", "f"), commit("c", "f"), commit("f")]);
	assert.deepEqual(linesBelow(rows[1]!).map((line) => line.lane).sort(), [0, 1]);
	assert.deepEqual(linesBelow(rows[3]!), []);
});
