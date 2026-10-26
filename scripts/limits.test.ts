import assert from "node:assert/strict";
import test from "node:test";
import { explainLimit } from "../src/main/limits.ts";

function explained(error: string, provider?: string) {
	const notice = explainLimit(error, provider);
	assert.ok(notice, `expected an explanation for: ${error}`);
	assert.equal(notice.detail, error.trim());
	return notice;
}

test("ChatGPT subscription limits read as the user's own plan, with the usage page", () => {
	const shown = explained(
		"The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.",
		"openai-codex",
	);
	assert.match(shown.message, /^You've reached your ChatGPT plan's usage limit\./);
	assert.equal(shown.link?.url, "https://chatgpt.com/settings/usage");

	const coded = explained(
		'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage',
		"openai",
	);
	assert.match(coded.message, /ChatGPT plan's usage limit/);

	const timed = explained("You have hit your ChatGPT usage limit (plus plan). Try again in ~134 min.", "openai-codex");
	assert.match(timed.message, /It resets in about 2 hours\./);

	const workspace = explained('429: {"code":"subscription_sharing_workplace_individual_usage_limit_exceeded"}', "openai");
	assert.match(workspace.message, /workspace admin/);
});

test("an OpenAI API account out of credit points to billing", () => {
	const notice = explained("429 You exceeded your current quota, please check your plan and billing details.", "openai");
	assert.match(notice.message, /run out of credit/);
	assert.match(notice.link!.url, /billing/);
});

test("DeepSeek's 402 is an empty balance", () => {
	const notice = explained("402 Insufficient Balance", "deepseek");
	assert.match(notice.message, /DeepSeek balance has run out/);
	assert.equal(notice.link?.url, "https://platform.deepseek.com/top_up");
	assert.equal(explainLimit("401 Authentication Fails", "deepseek"), undefined);
});

test("Z.ai's coding plan limits say which window and when it resets", () => {
	const hourly = explained(
		'429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2025-09-02 05:18:59"}',
		"zai",
	);
	assert.match(hourly.message, /GLM Coding Plan's 5-hour usage limit\. It resets at 2025-09-02 05:18:59\./);
	assert.equal(hourly.link?.url, "https://z.ai/subscribe");

	const weekly = explained("429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2025-09-08 00:00:00", "zai-coding-cn");
	assert.match(weekly.message, /weekly or monthly usage limit\. It resets at 2025-09-08 00:00:00\./);
	assert.equal(weekly.link?.url, "https://bigmodel.cn/glm-coding");

	const extra = explained(
		'429: {"code":"1316","message":"Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2025-09-02 05:18:59."}',
		"zai",
	);
	assert.match(extra.message, /5-hour usage limit\. It resets at 2025-09-02 05:18:59\. Your balance can't cover extra usage\./);

	assert.match(explained('429: {"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}', "zai").message, /no balance/);
	assert.equal(explainLimit('429: {"code":"1302","message":"Rate limit reached for requests"}', "zai"), undefined);
});

test("OpenCode Go and free-tier limits are told apart", () => {
	const go = explained(
		'429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}}',
		"opencode-go",
	);
	assert.match(go.message, /OpenCode Go usage limit/);
	const free = explained(
		'429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
		"opencode",
	);
	assert.match(free.message, /free usage/);
});

test("Xiaomi MiMo's 429 is honest that it may be speed or quota", () => {
	assert.match(explained("402 Insufficient Balance", "xiaomi").message, /MiMo balance has run out/);
	assert.match(explained("429 Too Many Requests", "xiaomi-token-plan-sgp").message, /too fast, or your Token Plan quota is used up/);
	assert.match(explained("429: {\"error\":{\"message\":\"Token Plan quota exhausted\"}}", "xiaomi-token-plan-cn").message, /quota is used up\./);
});

test("other errors are left as they are", () => {
	assert.equal(explainLimit("Connection error.", "openai"), undefined);
	assert.equal(explainLimit("429 Rate limit reached for requests", "openai"), undefined);
	assert.equal(explainLimit("400 Prompt too long", "zai"), undefined);
	assert.equal(explainLimit("", "deepseek"), undefined);
});
