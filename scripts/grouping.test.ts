import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { byWorkspace } from "../src/renderer/grouping.ts";

const session = (title: string, cwd: string, chat = false) => ({ title, cwd, chat, path: `/sessions/${title}.jsonl` }) as SessionSummary;

const shape = (sessions: SessionSummary[]) => byWorkspace(sessions).map((group) => [group.name, group.sessions.map((item) => item.title)]);

test("sessions gather under their workspace, in the order they came", () => {
	assert.deepEqual(
		shape([session("a", "/work/shop"), session("b", "/work/blog"), session("c", "/work/shop")]),
		[
			["shop", ["a", "c"]],
			["blog", ["b"]],
		],
	);
});

test("two folders with the same name stay apart", () => {
	const groups = byWorkspace([session("a", "/work/shop"), session("b", "/home/shop")]);
	assert.deepEqual(groups.map((group) => [group.name, group.cwd]), [
		["shop", "/work/shop"],
		["shop", "/home/shop"],
	]);
});

test("chats and sessions with no folder get a name of their own", () => {
	assert.deepEqual(shape([session("a", "/chats", true), session("b", "")]), [
		["Chats", ["a"]],
		["No project", ["b"]],
	]);
});

test("no sessions make no groups", () => {
	assert.deepEqual(byWorkspace([]), []);
});
