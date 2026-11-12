import assert from "node:assert/strict";
import test from "node:test";
import type { Step } from "../src/shared/protocol.ts";
import { blocksOf } from "../src/renderer/timeline.ts";

const step = (id: string, tool: string, content?: string): Step => ({ id, tool, target: content?.split("\n")[0] ?? id, content, meta: "", tone: "plain", status: "done" });

const shape = (steps: Step[]) => blocksOf(steps).map((block) => (block.kind === "note" ? block.text : block.steps.map((s) => s.id)));

test("what the agent says between tool calls splits its steps into groups", () => {
	const steps = [
		step("a", "think", "Plan"),
		step("b", "note", "Looking at the parser first.\nIt has two entry points."),
		step("c", "read"),
		step("d", "think", "Hm"),
		step("e", "note", "The bug is in the lexer."),
		step("f", "edit"),
		step("g", "bash"),
	];
	assert.deepEqual(shape(steps), [["a"], "Looking at the parser first.\nIt has two entry points.", ["c", "d"], "The bug is in the lexer.", ["f", "g"]]);
});

test("a run with nothing said along the way is one group", () => {
	assert.deepEqual(shape([step("a", "read"), step("b", "edit")]), [["a", "b"]]);
	assert.deepEqual(shape([]), []);
});

test("an empty note neither shows nor splits the steps around it", () => {
	assert.deepEqual(shape([step("a", "read"), step("b", "note", " \n"), step("c", "edit")]), [["a", "c"]]);
});

test("notes that follow each other stay separate, and a group keeps the id of its first step", () => {
	const blocks = blocksOf([step("a", "note", "One"), step("b", "note", "Two"), step("c", "bash"), step("d", "bash")]);
	assert.deepEqual(blocks.map((block) => [block.kind, block.id]), [["note", "a"], ["note", "b"], ["steps", "c"]]);
});
