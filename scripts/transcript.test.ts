import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AttachmentStore } from "../src/main/attachments.ts";
import { attachmentsOf, branchMessages, messageFiles, RunTracker } from "../src/main/transcript.ts";

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

test("a run keeps the timing of its last finished reply", () => {
	const tracker = new RunTracker([
		{ role: "user", content: "hi", timestamp: 1000 },
		{ role: "assistant", content: [{ type: "text", text: "Hi!" }], usage: { output: 13 }, timestamp: 1200, durationMs: 4700, firstTokenMs: 1500 },
	] as unknown as Messages);
	assert.deepEqual(tracker.all()[0]!.reply, { at: 1200, durationMs: 4700, firstTokenMs: 1500, output: 13 });
	assert.equal(history([{ type: "text", text: "Done." }]).all()[0]!.reply, undefined);
});

test("a reply after a failed one, as when a 503 is retried, clears the run's error", () => {
	const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable", provider: "openai", timestamp: 1200 };
	const answer = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1500 };
	const reopened = new RunTracker([{ role: "user", content: "hi", timestamp: 1000 }, failed, answer] as unknown as Messages);
	assert.equal(reopened.all()[0]!.error, undefined);
	assert.equal(reopened.all()[0]!.status, "done");

	const live = new RunTracker([]);
	const end = (message: unknown) => {
		live.apply({ type: "message_start", message } as Event);
		live.apply({ type: "message_end", message } as Event);
	};
	end({ role: "user", content: "hi", timestamp: 1000 });
	end(failed);
	assert.equal(live.all()[0]!.error, "503 Service Unavailable");
	end(answer);
	live.apply({ type: "agent_settled", aborted: false } as Event);
	assert.equal(live.all()[0]!.error, undefined);
	assert.equal(live.all()[0]!.status, "done");
	// A run that ends on the failure keeps it.
	end({ role: "user", content: "again", timestamp: 2000 });
	end(failed);
	live.apply({ type: "agent_settled", aborted: false } as Event);
	assert.equal(live.all()[1]!.error, "503 Service Unavailable");
	assert.equal(live.all()[1]!.status, "error");
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

test("a sent message's attachments come back out to be sent again exactly as they were", () => {
	const prefix = '<file name="/work/notes.md">\n# Notes\nline two\n</file>\n<file name="/work/shot.png">[Image resized]</file>\n';
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const { prompt, files } = messageFiles([{ type: "text", text: `${prefix}Fix the header` }, image]);
	assert.equal(prompt, "Fix the header");
	const store = new AttachmentStore();
	const infos = store.fromMessage(files);
	assert.deepEqual(infos.map((info) => [info.name, info.kind]), [["notes.md", "file"], ["shot.png", "image"]]);
	assert.equal(infos[1]!.preview, "data:image/png;base64,aGVsbG8=");
	const rebuilt = store.build(infos.map((info) => info.id));
	assert.equal(rebuilt.prefix, prefix);
	assert.deepEqual(rebuilt.images, [image]);
});

test("each run knows how many later runs began with a user message", () => {
	const tracker = new RunTracker([
		{ role: "assistant", content: [{ type: "text", text: "Kept from before compaction" }], timestamp: 1 },
		{ role: "user", content: "First", timestamp: 2 },
		{ role: "assistant", content: [{ type: "text", text: "One" }], timestamp: 3 },
		{ role: "user", content: "Second", timestamp: 4 },
	] as unknown as Messages);
	assert.equal(tracker.userMessage(0), undefined);
	assert.deepEqual(tracker.userMessage(1), { prompt: "First", later: 1 });
	assert.deepEqual(tracker.userMessage(2), { prompt: "Second", later: 0 });
});

test("history from before a compaction stays, with the compaction marked, after the session is reopened", () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-compaction-"));
	try {
		const manager = SessionManager.create(dir, dir);
		const reply = (text: string, timestamp: number) =>
			({ role: "assistant", content: [{ type: "text", text }], usage: { output: 1 }, timestamp }) as unknown as Parameters<SessionManager["appendMessage"]>[0];
		manager.appendMessage({ role: "user", content: "First", timestamp: 1 });
		manager.appendMessage(reply("One", 2));
		const kept = manager.appendMessage({ role: "user", content: "Second", timestamp: 3 });
		manager.appendMessage(reply("Two", 4));
		manager.appendCompaction("They asked twice.", kept, 1000);
		manager.appendMessage({ role: "user", content: "Third", timestamp: 6 });
		manager.appendMessage(reply("Three", 7));

		const reopened = SessionManager.open(manager.getSessionFile()!);
		// The agent's context starts at the summary; the transcript keeps everything.
		assert.equal(reopened.buildSessionContext().messages.some((message) => message.role === "user" && message.content === "First"), false);
		const tracker = new RunTracker(branchMessages(reopened.getBranch()));
		const runs = tracker.all();
		assert.deepEqual(runs.map((run) => [run.prompt, run.answer, Boolean(run.compacted)]), [
			["First", "One", false],
			["Second", "Two", true],
			["Third", "Three", false],
		]);
		// The summary isn't drawn as a reply, and doesn't move the end of the run before it.
		assert.equal(runs[1]!.endedAt, 4);
		// Messages from before the compaction can still be edited or forked.
		assert.deepEqual(tracker.userMessage(0), { prompt: "First", later: 2 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live compaction marks the run it followed, and a failed one marks nothing", () => {
	const tracker = new RunTracker([
		{ role: "user", content: "First", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "One" }], timestamp: 2 },
	] as unknown as Messages);
	assert.equal(tracker.apply({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false } as Event), false);
	assert.equal(tracker.all()[0]!.compacted, undefined);
	const result = { summary: "They asked once.", firstKeptEntryId: "x", tokensBefore: 1000 };
	assert.equal(tracker.apply({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false } as Event), true);
	assert.equal(tracker.all()[0]!.compacted, true);
});

test("an edited message goes out with the files and images the original carried", () => {
	const prefix = '<file name="/work/a.ts">\nexport {}\n</file>\n<file name="/work/shot.png"></file>\n';
	const image = { type: "image", data: "aGk=", mimeType: "image/png" };
	assert.deepEqual(attachmentsOf([{ type: "text", text: `${prefix}Old wording` }, image]), { prefix, images: [image] });
	assert.deepEqual(attachmentsOf("Just text"), { prefix: "", images: [] });
});

test("a command step leaves out the cd into the project in front of it", () => {
	const command = 'cd "/Users/me/my app" && npm test';
	const tracker = history([{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command } }], "ok");
	const step = tracker.all()[0]!.steps[0]!;
	assert.equal(step.target, "npm test");
	assert.equal(JSON.parse(step.input!).command, command);
});
