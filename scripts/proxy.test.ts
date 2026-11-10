import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { lanAddresses, ProxyService, resolveModel } from "../src/main/proxy.ts";
import { ProxyError, seal, unseal } from "../src/main/proxy-protocol.ts";

type Json = Record<string, any>;

const model = (provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> => ({
	id,
	name: id.toUpperCase(),
	api: "openai-completions",
	provider,
	baseUrl: "http://upstream.invalid",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 100_000,
	maxTokens: 4096,
	...extra,
});

const MODELS = [model("acme", "small"), model("acme", "big", { input: ["text", "image"], reasoning: true }), model("other", "small")];

const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-completions",
	provider: "acme",
	model: "small",
	usage,
	stopReason,
	timestamp: 0,
	...extra,
});

/** pi's events for a reply, block by block, the way a provider that streams sends them. */
function eventsFor(final: AssistantMessage): AssistantMessageEvent[] {
	const partial = { ...final, content: [] as AssistantMessage["content"] };
	const events: AssistantMessageEvent[] = [{ type: "start", partial }];
	final.content.forEach((block, contentIndex) => {
		partial.content.push(block);
		if (block.type === "text") {
			events.push({ type: "text_start", contentIndex, partial });
			for (const delta of block.text.match(/.{1,4}/gs) ?? []) events.push({ type: "text_delta", contentIndex, delta, partial });
			events.push({ type: "text_end", contentIndex, content: block.text, partial });
		} else if (block.type === "thinking") {
			events.push({ type: "thinking_start", contentIndex, partial });
			if (block.thinking) events.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
			events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
		} else {
			const json = JSON.stringify(block.arguments);
			events.push({ type: "toolcall_start", contentIndex, partial });
			events.push({ type: "toolcall_delta", contentIndex, delta: json.slice(0, 5), partial });
			events.push({ type: "toolcall_delta", contentIndex, delta: json.slice(5), partial });
			events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		}
	});
	if (final.stopReason === "error") events.push({ type: "error", reason: "error", error: final });
	else events.push({ type: "done", reason: final.stopReason as "stop" | "length" | "toolUse", message: final });
	return events;
}

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

interface Fixture {
	proxy: ProxyService;
	file: string;
	key: string;
	url: string;
	/** What the proxy last asked the backend for. */
	asked: { model?: Model<Api>; context?: Context; options?: SimpleStreamOptions };
	/** The reply the backend gives next. */
	reply: { events: AssistantMessageEvent[] };
	call(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
}

async function start(t: TestContext): Promise<Fixture> {
	const file = join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json");
	const asked: Fixture["asked"] = {};
	const reply: Fixture["reply"] = { events: eventsFor(message([{ type: "text", text: "Hello there" }])) };
	const proxy = new ProxyService({
		file,
		addresses: () => ["192.168.1.20"],
		backend: {
			models: async () => MODELS,
			async *stream(target, context, options) {
				Object.assign(asked, { model: target, context, options });
				yield* reply.events;
			},
		},
	});
	t.after(() => proxy.dispose());
	const port = await freePort();
	await proxy.saveOptions({ port, openai: true, anthropic: true, lan: false });
	const { key } = await proxy.saveKey(undefined, "Tests", "");
	await proxy.setEnabled(true);
	const url = `http://127.0.0.1:${port}`;
	const call: Fixture["call"] = (path, body, headers = { authorization: `Bearer ${key}` }) =>
		fetch(url + path, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	return { proxy, file, key: key!, url, asked, reply, call };
}

/** The data of each server-sent event, parsed, with OpenAI's closing [DONE] left as text. */
const frames = (text: string): Json[] =>
	text
		.split("\n\n")
		.flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")))
		.map((line) => (line === "data: [DONE]" ? { done: true } : JSON.parse(line.slice(6))));

test("requests need one of the proxy's keys, which the file holds only a digest of", async (t) => {
	const { proxy, file, key, call } = await start(t);
	assert.match(key, /^trv-[\w-]{43}$/);
	assert.equal((await call("/v1/models", undefined, {})).status, 401);
	assert.equal((await call("/v1/models", undefined, { authorization: "Bearer trv-not-a-key-anyone-made" })).status, 401);
	assert.equal((await call("/v1/models")).status, 200);
	// Anthropic's clients send the key in their own header.
	assert.equal((await call("/v1/models", undefined, { "x-api-key": key })).status, 200);

	const saved = await readFile(file, "utf8");
	assert.ok(!saved.includes(key));
	const status = await proxy.status();
	assert.equal(status.keys[0]!.hint, `…${key.slice(-4)}`);
	assert.ok(status.keys[0]!.lastUsedAt);
	assert.ok(!("digest" in status.keys[0]!));

	await proxy.setKeyEnabled(status.keys[0]!.id, false);
	const refused = await call("/v1/messages", { model: "acme/small", messages: [] }, { "x-api-key": key });
	assert.equal(refused.status, 401);
	assert.equal(((await refused.json()) as Json).error.type, "authentication_error");
});

test("keys: a name and a value are each one key's own, and a new value replaces the old", async (t) => {
	const { proxy, key, call } = await start(t);
	const [first] = (await proxy.status()).keys;
	await assert.rejects(proxy.saveKey(undefined, "Tests", ""), /already/);
	await assert.rejects(proxy.saveKey(undefined, "Other", key), /already/);
	await assert.rejects(proxy.saveKey(undefined, "Short", "abc"), /16 to 256/);
	// Renaming keeps the key working and shows nothing new.
	assert.equal((await proxy.saveKey(first!.id, "Renamed", "")).key, undefined);
	assert.equal((await call("/v1/models")).status, 200);
	const replaced = await proxy.saveKey(first!.id, "Renamed", "my-own-key-0123456789");
	assert.equal(replaced.key, "my-own-key-0123456789");
	assert.equal((await call("/v1/models")).status, 401);
	assert.equal((await call("/v1/models", undefined, { authorization: "Bearer my-own-key-0123456789" })).status, 200);
	await proxy.removeKey(first!.id);
	assert.equal((await call("/v1/models", undefined, { authorization: "Bearer my-own-key-0123456789" })).status, 401);
});

test("models are offered as provider/id, and by the other names given to them", async (t) => {
	const { proxy, call } = await start(t);
	await proxy.saveAliases([
		{ alias: "gpt-4o", model: "acme/big" },
		{ alias: "gone", model: "acme/retired" },
	]);
	const listing = (await (await call("/v1/models")).json()) as Json;
	assert.deepEqual(
		listing.data.map((entry: Json) => entry.id),
		["gpt-4o", "acme/small", "acme/big", "other/small"],
	);
	assert.deepEqual(listing.data[0], { id: "gpt-4o", object: "model", type: "model", display_name: "BIG", created: 0, created_at: "1970-01-01T00:00:00Z", owned_by: "acme" });

	const aliases = [{ alias: "gpt-4o", model: "acme/big" }];
	assert.equal(resolveModel("gpt-4o", MODELS, aliases).id, "big");
	assert.equal(resolveModel("other/small", MODELS, aliases).provider, "other");
	assert.equal(resolveModel("big", MODELS, aliases).provider, "acme");
	assert.throws(() => resolveModel("small", MODELS, aliases), (error: ProxyError) => error.status === 400 && /provider\/id/.test(error.message));
	assert.throws(() => resolveModel("nope", MODELS, aliases), (error: ProxyError) => error.status === 404);
	await assert.rejects(proxy.saveAliases([{ alias: "a b", model: "acme/big" }]), /without spaces/);
	await assert.rejects(proxy.saveAliases([...aliases, ...aliases]), /twice/);
});

test("OpenAI: a chat completion becomes a pi request, and the reply an OpenAI response", async (t) => {
	const { asked, reply, call } = await start(t);
	reply.events = eventsFor(
		message([{ type: "thinking", thinking: "Hmm." }, { type: "text", text: "Checking." }, { type: "toolCall", id: "call_1", name: "weather", arguments: { city: "Oslo" } }], "toolUse"),
	);
	const response = await call("/v1/chat/completions", {
		model: "acme/big",
		max_tokens: 99999,
		temperature: 0.2,
		reasoning_effort: "high",
		messages: [
			{ role: "system", content: "Be brief." },
			{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
			{ role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "weather", arguments: '{"city":"Rome"}' } }] },
			{ role: "tool", tool_call_id: "call_0", content: "Sunny" },
		],
		tools: [{ type: "function", function: { name: "weather", description: "Looks up weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as Json;
	assert.equal(body.object, "chat.completion");
	assert.equal(body.model, "acme/big");
	assert.deepEqual(body.choices[0], {
		index: 0,
		message: {
			role: "assistant",
			content: "Checking.",
			reasoning_content: "Hmm.",
			tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: '{"city":"Oslo"}' } }],
		},
		finish_reason: "tool_calls",
	});
	// Cached input counts toward the prompt, as OpenAI counts it.
	assert.deepEqual(body.usage, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } });

	assert.equal(asked.model!.id, "big");
	assert.equal(asked.context!.systemPrompt, "Be brief.");
	assert.deepEqual(asked.context!.tools, [{ name: "weather", description: "Looks up weather", parameters: { type: "object", properties: { city: { type: "string" } } } }]);
	const [user, assistant, result] = asked.context!.messages as Json[];
	assert.deepEqual(user!.content, [{ type: "text", text: "Look" }, { type: "image", mimeType: "image/png", data: "AAAA" }]);
	assert.deepEqual(assistant!.content, [{ type: "toolCall", id: "call_0", name: "weather", arguments: { city: "Rome" } }]);
	assert.equal(assistant!.stopReason, "toolUse");
	assert.deepEqual([result!.role, result!.toolCallId, result!.toolName, result!.content[0].text], ["toolResult", "call_0", "weather", "Sunny"]);
	// No more output than the model can write.
	assert.equal(asked.options!.maxTokens, 4096);
	assert.equal(asked.options!.temperature, 0.2);
	assert.equal(asked.options!.reasoning, "high");
});

test("OpenAI: a stream sends text and tool calls as they come, then usage when asked", async (t) => {
	const { reply, call } = await start(t);
	reply.events = eventsFor(message([{ type: "text", text: "Hello there" }, { type: "toolCall", id: "call_1", name: "weather", arguments: { city: "Oslo" } }], "toolUse"));
	const response = await call("/v1/chat/completions", { model: "acme/small", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Hi" }] });
	assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const chunks = frames(await response.text());
	assert.deepEqual(chunks[0]!.choices[0].delta, { role: "assistant", content: "" });
	const deltas = chunks.flatMap((chunk) => chunk.choices?.map((choice: Json) => choice.delta) ?? []);
	assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "Hello there");
	const calls = deltas.flatMap((delta) => delta.tool_calls ?? []);
	assert.deepEqual(calls[0], { index: 0, id: "call_1", type: "function", function: { name: "weather", arguments: "" } });
	assert.equal(calls.map((entry) => entry.function.arguments).join(""), '{"city":"Oslo"}');
	assert.equal(chunks.at(-3)!.choices[0].finish_reason, "tool_calls");
	assert.deepEqual(chunks.at(-2)!.choices, []);
	assert.equal(chunks.at(-2)!.usage.completion_tokens, 5);
	assert.deepEqual(chunks.at(-1), { done: true });
	assert.ok(new Set(chunks.slice(0, -1).map((chunk) => chunk.id)).size === 1);
});

test("OpenAI: a tool call that arrives whole, or names itself late, still streams complete", async (t) => {
	const { reply, call } = await start(t);
	const whole = { type: "toolCall" as const, id: "call_9", name: "weather", arguments: { city: "Lima" } };
	const final = message([whole], "toolUse");
	// The name and ID show up only after the first piece of arguments, and the last event has no deltas left.
	const unnamed = { ...final, content: [{ ...whole, id: "", name: "" }] };
	reply.events = [
		{ type: "start", partial: { ...final, content: [] } },
		{ type: "toolcall_start", contentIndex: 0, partial: unnamed },
		{ type: "toolcall_delta", contentIndex: 0, delta: '{"city":', partial: unnamed },
		{ type: "toolcall_delta", contentIndex: 0, delta: '"Lima"}', partial: final },
		{ type: "toolcall_end", contentIndex: 0, toolCall: whole, partial: final },
		{ type: "done", reason: "toolUse", message: final },
	];
	const late = frames(await (await call("/v1/chat/completions", { model: "acme/small", stream: true, messages: [{ role: "user", content: "Hi" }] })).text());
	const lateCalls = late.flatMap((chunk) => chunk.choices?.[0]?.delta.tool_calls ?? []);
	assert.deepEqual([lateCalls[0].id, lateCalls[0].function.name], ["call_9", "weather"]);
	assert.equal(lateCalls.map((entry) => entry.function.arguments).join(""), '{"city":"Lima"}');

	reply.events = [
		{ type: "start", partial: { ...final, content: [] } },
		{ type: "toolcall_start", contentIndex: 0, partial: final },
		{ type: "toolcall_end", contentIndex: 0, toolCall: whole, partial: final },
		{ type: "done", reason: "toolUse", message: final },
	];
	const atOnce = frames(await (await call("/v1/chat/completions", { model: "acme/small", stream: true, messages: [{ role: "user", content: "Hi" }] })).text());
	assert.equal(atOnce.flatMap((chunk) => chunk.choices?.[0]?.delta.tool_calls ?? []).map((entry) => entry.function.arguments).join(""), '{"city":"Lima"}');
});

test("Anthropic: a stream opens and closes each block, and signs thinking with its model", async (t) => {
	const { reply, call } = await start(t);
	reply.events = eventsFor(
		message(
			[
				{ type: "thinking", thinking: "Let me see.", thinkingSignature: "sig-123" },
				{ type: "text", text: "Checking." },
				{ type: "toolCall", id: "toolu_1", name: "weather", arguments: { city: "Oslo" } },
			],
			"toolUse",
		),
	);
	const text = await (
		await call("/v1/messages", {
			model: "acme/big",
			max_tokens: 1024,
			stream: true,
			system: [{ type: "text", text: "Be brief." }],
			thinking: { type: "enabled", budget_tokens: 8000 },
			messages: [{ role: "user", content: "Hi" }],
		})
	).text();
	const events = frames(text);
	assert.deepEqual(
		events.map((event) => event.type).filter((type, index, all) => type !== all[index - 1]),
		["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
	);
	// Each event is named on its own line too, as Anthropic's clients expect.
	assert.ok(text.startsWith("event: message_start\ndata: {"));
	const starts = events.filter((event) => event.type === "content_block_start");
	assert.deepEqual(starts.map((event) => [event.index, event.content_block.type]), [[0, "thinking"], [1, "text"], [2, "tool_use"]]);
	assert.deepEqual(starts[2]!.content_block, { type: "tool_use", id: "toolu_1", name: "weather", input: {} });
	const deltas = events.filter((event) => event.type === "content_block_delta").map((event) => event.delta);
	assert.equal(deltas.filter((delta) => delta.type === "input_json_delta").map((delta) => delta.partial_json).join(""), '{"city":"Oslo"}');
	const signature = deltas.find((delta) => delta.type === "signature_delta")!.signature;
	assert.deepEqual(unseal(signature), { api: "openai-completions", provider: "acme", model: "big", signature: "sig-123" });
	const end = events.find((event) => event.type === "message_delta")!;
	assert.equal(end.delta.stop_reason, "tool_use");
	assert.deepEqual(end.usage, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
});

test("Anthropic: thinking goes back to the model that wrote it, and nobody else's is passed on", async (t) => {
	const { asked, reply, call } = await start(t);
	reply.events = eventsFor(message([{ type: "text", text: "Sunny in Oslo." }]));
	const response = await call("/v1/messages", {
		model: "acme/big",
		max_tokens: 500,
		thinking: { type: "adaptive" },
		output_config: { effort: "low" },
		tools: [{ name: "weather", description: "Looks up weather", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
		messages: [
			{ role: "user", content: "Weather in Oslo?" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Mine.", signature: seal(MODELS[1]!, "sig-123") },
					{ type: "thinking", thinking: "Someone else's.", signature: "raw-signature-from-elsewhere" },
					{ type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Oslo" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Sunny" }], is_error: true }, { type: "text", text: "Go on." }] },
			{ role: "assistant", content: [{ type: "text", text: "It is sunny." }] },
			{ role: "user", content: "Thanks" },
		],
	});
	const body = (await response.json()) as Json;
	assert.deepEqual(
		{ type: body.type, role: body.role, model: body.model, content: body.content, stop_reason: body.stop_reason },
		{ type: "message", role: "assistant", model: "acme/big", content: [{ type: "text", text: "Sunny in Oslo." }], stop_reason: "end_turn" },
	);

	const [, signed, result, user, plain] = asked.context!.messages as Json[];
	assert.deepEqual(signed!.content, [
		{ type: "thinking", thinking: "Mine.", thinkingSignature: "sig-123" },
		{ type: "toolCall", id: "toolu_1", name: "weather", arguments: { city: "Oslo" } },
	]);
	// pi replays thinking only to the model named here.
	assert.deepEqual([signed!.api, signed!.provider, signed!.model], ["openai-completions", "acme", "big"]);
	assert.deepEqual([result!.role, result!.toolName, result!.isError], ["toolResult", "weather", true]);
	assert.deepEqual(user!.content, [{ type: "text", text: "Go on." }]);
	// A message with no thinking of the proxy's own could be anyone's.
	assert.notEqual(plain!.provider, "acme");
	// Only tools the client runs itself are passed on.
	assert.deepEqual(asked.context!.tools!.map((entry) => entry.name), ["weather"]);
	assert.equal(asked.options!.reasoning, "low");
	assert.equal(asked.options!.maxTokens, 500);
});

test("a provider's refusal answers with its status, in the format the client speaks", async (t) => {
	const { reply, call } = await start(t);
	const refusal = (errorMessage: string) => {
		const failed = message([], "error", { errorMessage });
		reply.events = [{ type: "error", reason: "error", error: failed }];
	};
	refusal('429: {"error":"slow down"}');
	const limited = await call("/v1/chat/completions", { model: "acme/small", stream: true, messages: [{ role: "user", content: "Hi" }] });
	assert.equal(limited.status, 429);
	assert.deepEqual(((await limited.json()) as Json).error.type, "rate_limit_error");

	// The provider turning down Trivium's login isn't the client's key being wrong.
	refusal("401: invalid x-api-key");
	const login = await call("/v1/messages", { model: "acme/small", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] });
	assert.equal(login.status, 502);
	assert.deepEqual((await login.json()) as Json, { type: "error", error: { type: "api_error", message: "401: invalid x-api-key" } });

	// Once the stream has begun, the failure can only be said in it.
	const partial = message([{ type: "text", text: "" }]);
	reply.events = [
		{ type: "start", partial },
		{ type: "error", reason: "error", error: message([], "error", { errorMessage: "The connection dropped" }) },
	];
	const cut = await call("/v1/messages", { model: "acme/small", max_tokens: 10, stream: true, messages: [{ role: "user", content: "Hi" }] });
	assert.equal(cut.status, 200);
	assert.deepEqual(frames(await cut.text()).at(-1), { type: "error", error: { type: "api_error", message: "The connection dropped" } });
});

test("requests the proxy can't serve say why", async (t) => {
	const { proxy, url, key, call } = await start(t);
	const error = async (response: Response) => [response.status, ((await response.json()) as Json).error.message];
	assert.deepEqual(await error(await call("/v1/chat/completions", { messages: [{ role: "user", content: "Hi" }] })), [400, "model is required."]);
	assert.equal((await call("/v1/chat/completions", { model: "acme/nope", messages: [{ role: "user", content: "Hi" }] })).status, 404);
	assert.equal((await call("/v1/chat/completions", { model: "small", messages: [{ role: "user", content: "Hi" }] })).status, 400);
	const image = [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }];
	assert.deepEqual(await error(await call("/v1/chat/completions", { model: "acme/small", messages: [{ role: "user", content: image }] })), [400, "acme/small doesn't accept images."]);
	const remote = [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }];
	assert.equal((await call("/v1/chat/completions", { model: "acme/big", messages: [{ role: "user", content: remote }] })).status, 400);
	const garbled = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{not json" });
	assert.deepEqual(await error(garbled), [400, "The request body isn't valid JSON."]);
	assert.equal((await call("/v1/embeddings", { model: "acme/small" })).status, 404);
	assert.equal(((await (await call("/v1/messages/count_tokens", { model: "acme/small", messages: [{ role: "user", content: "x".repeat(400) }] })).json()) as Json).input_tokens > 100, true);

	await proxy.saveOptions({ ...(await proxy.status()), anthropic: false });
	assert.equal((await call("/v1/messages", { model: "acme/small", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] })).status, 404);
	assert.equal((await call("/v1/chat/completions", { model: "acme/small", messages: [{ role: "user", content: "Hi" }] })).status, 200);
	await assert.rejects(proxy.saveOptions({ port: 80, openai: true, anthropic: true, lan: false }), /1024 to 65535/);
	await assert.rejects(proxy.saveOptions({ ...(await proxy.status()), openai: false }), /at least one format/);
});

test("a web page may call from this computer, and from the network only when it is allowed", async (t) => {
	const { url } = await start(t);
	const preflight = (origin: string) => fetch(`${url}/v1/chat/completions`, { method: "OPTIONS", headers: { origin, "access-control-request-headers": "authorization,x-stainless-os" } });
	const local = await preflight("http://localhost:3000");
	assert.equal(local.status, 204);
	assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:3000");
	assert.equal(local.headers.get("access-control-allow-headers"), "authorization,x-stainless-os");
	assert.equal((await preflight("http://192.168.1.50:3000")).headers.get("access-control-allow-origin"), null);
	assert.equal((await preflight("https://example.com")).headers.get("access-control-allow-origin"), null);
});

test("the proxy starts again with Trivium, moves to a new port, and says when it can't listen", async (t) => {
	const { proxy, file, key, url } = await start(t);
	const backend = { models: async () => MODELS, stream: async function* () {} };
	const taken = new ProxyService({ file: join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json"), backend });
	t.after(() => taken.dispose());
	await taken.saveKey(undefined, "Tests", "");
	await taken.saveOptions({ ...(await proxy.status()) });
	await assert.rejects(taken.setEnabled(true), /is in use by another app/);
	assert.equal((await taken.status()).enabled, false);
	// Without a key nobody could connect, so it doesn't turn on.
	const empty = new ProxyService({ file: join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json"), backend });
	await assert.rejects(empty.setEnabled(true), /Add an API key first/);

	const port = await freePort();
	const moved = await proxy.saveOptions({ ...(await proxy.status()), port });
	assert.deepEqual([moved.running, moved.port, moved.addresses], [true, port, []]);
	await assert.rejects(fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${key}` } }));
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
	assert.deepEqual((await proxy.saveOptions({ ...moved, lan: true })).addresses, ["192.168.1.20"]);

	proxy.dispose();
	const again = new ProxyService({ file, backend });
	t.after(() => again.dispose());
	await again.init();
	assert.equal((await again.status()).running, true);
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
	assert.equal((await again.setEnabled(false)).running, false);
});

test("network addresses: real network cards come before Docker's and a VPN's", () => {
	const address = (value: string, internal = false) => ({ address: value, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
	assert.deepEqual(
		lanAddresses({
			lo: [address("127.0.0.1", true)],
			"vEthernet (WSL)": [address("172.20.0.1")],
			docker0: [address("172.17.0.1")],
			"Wi-Fi": [address("192.168.1.20"), { ...address("fe80::1"), family: "IPv6" as const, scopeid: 0 }],
			Ethernet: [address("169.254.10.10")],
		}),
		["192.168.1.20", "172.20.0.1", "172.17.0.1"],
	);
});
