import assert from "node:assert/strict";
import test from "node:test";
import { RunTracker } from "../src/main/transcript.ts";

type Messages = ConstructorParameters<typeof RunTracker>[0];
type Event = Parameters<RunTracker["apply"]>[0];

function history(content: unknown[], result?: string, isError = false) {
	return new RunTracker([
		{ role: "user", content: "Inspect the project", timestamp: 1000 },
		{ role: "assistant", content, timestamp: 2000 },
		...(result === undefined ? [] : [{
			role: "toolResult", toolCallId: "tool-1", toolName: "bash",
			content: [{ type: "text", text: result }], isError, timestamp: 3000,
		}]),
	] as unknown as Messages);
}

test("expanded history retains full commands, arguments and error output", () => {
	const command = `printf '${"long command ".repeat(30)}'\nexit 127`;
	const output = "command not found\nProcess exited with code 127";
	const tracker = history([
		{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command, timeout: 10 } },
	], output, true);
	const step = tracker.all()[0]!.steps[0]!;
	assert.ok(step.target.length < command.length);
	assert.deepEqual(JSON.parse(step.input!), { command, timeout: 10 });
	assert.equal(step.output, output);
	assert.equal(step.status, "error");
	assert.equal(step.meta, "exit 127");
});

test("thinking and commentary keep their complete multiline text", () => {
	const thinking = `Plan ${"a detailed thought ".repeat(30)}\nSecond paragraph`;
	const note = "Inspecting files\nThen applying changes";
	const tracker = history([
		{ type: "thinking", thinking },
		{ type: "text", text: note },
		{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/example.ts" } },
		{ type: "text", text: "Done." },
	], "File contents\nSecond line");
	const run = tracker.all()[0]!;
	assert.equal(run.steps[0]!.content, thinking);
	assert.ok(run.steps[0]!.target.length < thinking.length);
	assert.equal(run.steps[1]!.content, note);
	assert.equal(run.steps[2]!.output, "File contents\nSecond line");
	assert.equal(run.answer, "Done.");
});

test("edit arguments preserve every replacement in expanded details", () => {
	const args = {
		path: "src/example.ts",
		edits: [{ oldText: "old\ntext", newText: "new\ntext" }, { oldText: "before", newText: "after" }],
	};
	const tracker = history([
		{ type: "toolCall", id: "tool-1", name: "edit", arguments: args },
	], "Successfully replaced 2 blocks");
	assert.deepEqual(JSON.parse(tracker.all()[0]!.steps[0]!.input!), args);
});

test("live expanded output updates independently of the short terminal tail", () => {
	const tracker = new RunTracker([]);
	const apply = (event: unknown) => tracker.apply(event as Event);
	apply({ type: "message_start", message: { role: "user", content: "Build the project" } });
	apply({
		type: "message_start", message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "build" } }],
		},
	});
	apply({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "build" } });
	const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	apply({
		type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: { command: "build" },
		partialResult: { content: [{ type: "text", text: output }] },
	});
	let step = tracker.all()[0]!.steps[0]!;
	assert.equal(step.output, output);
	assert.equal(step.status, "running");
	assert.equal(step.tail!.split("\n").length, 8);
	apply({
		type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false,
		result: { content: [{ type: "text", text: `${output}\nDone` }] }, durationMs: 100,
	});
	step = tracker.all()[0]!.steps[0]!;
	assert.equal(step.output, `${output}\nDone`);
	assert.equal(step.tail, undefined);
	assert.equal(step.status, "done");
});

test("sent images get previews in order and text files do not", () => {
	const seen: string[] = [];
	const tracker = new RunTracker([{
		role: "user",
		content: [
			{ type: "text", text: '<file name="shots/a.png"></file>\n<file name="notes.md">\n# Notes\n</file>\n<file name="b.jpg"></file>\nWhat changed?' },
			{ type: "image", data: "AAA", mimeType: "image/png" },
			{ type: "image", data: "BBB", mimeType: "image/jpeg" },
		],
		timestamp: 1000,
	}] as unknown as Messages, (data, mimeType) => {
		seen.push(`${data} ${mimeType}`);
		return `thumb:${data}`;
	});
	const [run] = tracker.all();
	assert.equal(run!.prompt, "What changed?");
	assert.deepEqual(run!.attachments, [
		{ kind: "image", id: "i0", name: "a.png", mimeType: "image/png", thumb: "thumb:AAA" },
		{ name: "notes.md", kind: "file" },
		{ kind: "image", id: "i1", name: "b.jpg", mimeType: "image/jpeg", thumb: "thumb:BBB" },
	]);
	assert.deepEqual(seen, ["AAA image/png", "BBB image/jpeg"]);
	assert.deepEqual(tracker.image("i1"), { type: "image", data: "BBB", mimeType: "image/jpeg" });
});

test("a read that returns an image shows it on the step, kept once for preview", () => {
	const thumbs: string[] = [];
	const tracker = new RunTracker([
		{ role: "user", content: "Look at the screenshot", timestamp: 1000 },
		{ role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "docs/screens/ask.png" } }], timestamp: 2000 },
		{
			role: "toolResult", toolCallId: "tool-1", toolName: "read", isError: false, timestamp: 3000,
			content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "PNGDATA", mimeType: "image/png" }],
		},
	] as unknown as Messages, (data) => {
		thumbs.push(data);
		return `thumb:${data}`;
	});
	const step = tracker.all()[0]!.steps.find((s) => s.tool === "read")!;
	assert.deepEqual(step.images, [{ id: "i0", name: "ask.png", mimeType: "image/png", thumb: "thumb:PNGDATA" }]);
	assert.equal(step.meta, "image");
	assert.equal(tracker.image("i0")?.data, "PNGDATA");
	tracker.all();
	assert.deepEqual(thumbs, ["PNGDATA"]);
});
