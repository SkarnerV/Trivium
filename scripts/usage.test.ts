import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionSummary, UsageBucket, UsageReport } from "../src/shared/protocol.ts";
import { countReplies, UsageCounter } from "../src/main/usage.ts";
import { addDays, dayOf, summarize, tokensOf } from "../src/shared/usage.ts";

const NOON = new Date(2026, 9, 20, 12).getTime();

/** One saved assistant reply, as pi writes it. */
function reply(time: number, usage: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cost", number>>, model = "opus", provider = "anthropic") {
	const { cost = 0, ...tokens } = usage;
	return JSON.stringify({
		type: "message",
		timestamp: new Date(time).toISOString(),
		message: {
			role: "assistant",
			provider,
			model,
			timestamp: time,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens, cost: { total: cost } },
		},
	});
}

const header = (time: number, parentSession?: string) =>
	JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date(time).toISOString(), cwd: "/p", ...(parentSession ? { parentSession } : {}) });

function buckets(text: string): UsageBucket[] {
	const into = new Map<string, UsageBucket>();
	countReplies(text, into);
	return [...into.values()];
}

test("replies add up by day and model, and empty or broken ones are skipped", () => {
	const text = [
		header(NOON),
		JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
		reply(NOON, { input: 100, output: 20, cacheRead: 300, cost: 0.5 }),
		reply(NOON + 60_000, { input: 10, output: 5, cacheWrite: 40, cost: 0.25 }),
		reply(NOON + 120_000, {}),
		"{ not json",
		reply(NOON + 86_400_000, { input: 1, output: 1 }),
		reply(NOON, { input: 7, output: 3 }, "gpt", "openai"),
	].join("\n");
	assert.deepEqual(buckets(text), [
		{ day: dayOf(NOON), provider: "anthropic", model: "opus", responses: 2, input: 110, output: 25, cacheRead: 300, cacheWrite: 40, cost: 0.75 },
		{ day: dayOf(NOON + 86_400_000), provider: "anthropic", model: "opus", responses: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
		{ day: dayOf(NOON), provider: "openai", model: "gpt", responses: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0 },
	]);
});

test("a fork skips the replies it copied from the session it came from", () => {
	const text = [header(NOON, "/sessions/original.jsonl"), reply(NOON - 60_000, { input: 500, output: 50 }), reply(NOON + 60_000, { input: 9, output: 1 })].join("\n");
	assert.deepEqual(
		buckets(text).map((bucket) => [bucket.responses, bucket.input]),
		[[1, 9]],
	);
});

function session(path: string, app: SessionSummary["app"] = "code"): SessionSummary {
	return { path, id: path, cwd: "/p", title: "A session", app, modified: 0, messageCount: 1, running: false, unread: false, chat: false };
}

test("subagents count toward their session, and counts are cached until a file changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-usage-"));
	try {
		const dir = join(root, "sessions", "--p--");
		const parent = join(dir, "2026-10-20_abc.jsonl");
		const child = join(dir, "2026-10-20_abc", "run-1", "child.jsonl");
		mkdirSync(join(dir, "2026-10-20_abc", "run-1"), { recursive: true });
		writeFileSync(parent, [header(NOON), reply(NOON, { input: 100, output: 10, cost: 1 })].join("\n"));
		writeFileSync(child, [header(NOON), reply(NOON, { input: 50, output: 5, cost: 0.5 }, "haiku")].join("\n"));
		const cacheFile = join(root, "usage-cache.json");
		const isPlan = (provider: string) => provider === "openai";
		const report = await new UsageCounter(cacheFile).report([session(parent), session(join(dir, "unsaved.jsonl"))], isPlan, new Date(NOON));
		assert.equal(report.today, dayOf(NOON));
		assert.deepEqual(report.plans, []);
		assert.equal(report.sessions.length, 1);
		assert.deepEqual(
			report.sessions[0].buckets.map((bucket) => [bucket.model, bucket.input, bucket.cost]),
			[
				["opus", 100, 1],
				["haiku", 50, 0.5],
			],
		);

		// A new counter reads the cache; a changed file is counted again.
		const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
		cached.sessions[parent].buckets[0].input = 999;
		writeFileSync(cacheFile, JSON.stringify(cached));
		const again = await new UsageCounter(cacheFile).report([session(parent)], isPlan, new Date(NOON));
		assert.equal(again.sessions[0].buckets[0].input, 999);
		writeFileSync(child, [header(NOON), reply(NOON, { input: 60, output: 6 }, "gpt", "openai")].join("\n"));
		const changed = await new UsageCounter(cacheFile).report([session(parent)], isPlan, new Date(NOON));
		assert.deepEqual(
			changed.sessions[0].buckets.map((bucket) => [bucket.model, bucket.input]),
			[
				["opus", 100],
				["gpt", 60],
			],
		);
		assert.deepEqual(changed.plans, ["openai"]);

		// A session no longer listed drops out of the cache.
		await new UsageCounter(cacheFile).report([], isPlan, new Date(NOON));
		assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")).sessions, {});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function bucket(day: string, input: number, model = "opus", cost = 0): UsageBucket {
	return { day, provider: "anthropic", model, responses: 1, input, output: 0, cacheRead: 0, cacheWrite: 0, cost };
}

test("a summary counts its range, compares with the stretch before, and ranks apps, models and sessions", () => {
	const today = "2026-10-27";
	const report: UsageReport = {
		today,
		plans: [],
		sessions: [
			{ path: "a", title: "A", app: "code", cwd: "/p", chat: false, buckets: [bucket(addDays(today, -10), 40), bucket(today, 100, "opus", 2)] },
			{ path: "b", title: "B", app: "research", cwd: "/p", chat: false, buckets: [bucket(addDays(today, -3), 300, "sonnet")] },
			{ path: "c", title: "C", app: "write", cwd: "/p", chat: false, buckets: [bucket(addDays(today, -200), 1000)] },
		],
	};
	const week = summarize(report, "7");
	assert.equal(week.from, addDays(today, -6));
	assert.equal(tokensOf(week.total), 400);
	assert.equal(week.total.cost, 2);
	assert.equal(week.sessions, 2);
	assert.equal(tokensOf(week.previous!), 40);
	assert.equal(week.bars.length, 7);
	assert.deepEqual(
		week.bars.map((bar) => bar.tally.input),
		[0, 0, 0, 300, 0, 0, 100],
	);
	assert.deepEqual(
		week.apps.map(({ app, tally }) => [app, tally.input]),
		[
			["code", 100],
			["research", 300],
			["write", 0],
		],
	);
	assert.deepEqual(
		week.models.map((model) => model.model),
		["sonnet", "opus"],
	);
	assert.deepEqual(
		week.top.map((entry) => [entry.session.path, entry.last]),
		[
			["b", addDays(today, -3)],
			["a", today],
		],
	);

	// All time starts at the first reply, and longer than 90 days shows weeks.
	const all = summarize(report, "all");
	assert.equal(all.from, addDays(today, -200));
	assert.equal(all.previous, undefined);
	assert.equal(all.bars.length, Math.ceil(201 / 7));
	assert.equal(all.bars.at(-1)!.to, today);
	assert.equal(tokensOf(all.total), 1440);
	assert.equal(
		all.bars.reduce((sum, bar) => sum + bar.tally.input, 0),
		1440,
	);
});
