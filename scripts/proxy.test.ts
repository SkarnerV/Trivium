import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises, { mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { parseListing } from "../src/main/custom-models.ts";
import { lanAddresses, ProxyService, resolveModel } from "../src/main/proxy.ts";
import { modelEntry, ProxyError, seal, unseal } from "../src/main/proxy-protocol.ts";

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

async function start(t: TestContext, requireKey = true): Promise<Fixture> {
	const file = join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json");
	const asked: Fixture["asked"] = {};
	const reply: Fixture["reply"] = { events: eventsFor(message([{ type: "text", text: "Hello there" }])) };
	const proxy = new ProxyService({
		file,
		addresses: () => ["192.168.1.20", "100.101.102.103"],
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
	const { key } = await proxy.saveKey(undefined, "Tests", "");
	await proxy.saveOptions({ port, openai: true, anthropic: true, lan: false, requireKey });
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

test("with no key required, a request needs none and a placeholder is as good as any", async (t) => {
	const { proxy, key, call } = await start(t, false);
	const chat = { model: "acme/small", messages: [{ role: "user", content: "Hi" }] };
	const supplied: Record<string, string>[] = [
		{},
		{ authorization: "Bearer sk-placeholder" },
		{ authorization: "Bearer " },
		{ authorization: "Basic eDp5" },
		{ "x-api-key": "dummy" },
		{ "x-api-key": "x".repeat(500) },
	];
	for (const headers of supplied) {
		assert.equal((await call("/v1/models", undefined, headers)).status, 200, JSON.stringify(headers));
		assert.equal((await call("/v1/chat/completions", chat, headers)).status, 200, JSON.stringify(headers));
		assert.equal((await call("/v1/messages", { ...chat, max_tokens: 10 }, headers)).status, 200, JSON.stringify(headers));
		assert.equal((await call("/v1/messages/count_tokens", chat, headers)).status, 200, JSON.stringify(headers));
	}
	// A key that is known still has its use noted.
	assert.equal((await proxy.status()).keys[0]!.lastUsedAt, undefined);
	assert.equal((await call("/v1/models")).status, 200);
	assert.ok((await proxy.status()).keys[0]!.lastUsedAt);

	// Requiring one applies to the next request, without a new socket; so does no longer requiring it.
	const { port } = proxy;
	assert.equal((await proxy.saveOptions({ ...(await proxy.status()), requireKey: true })).requireKey, true);
	assert.equal((await call("/v1/models", undefined, {})).status, 401);
	assert.equal((await call("/v1/models", undefined, { "x-api-key": "dummy" })).status, 401);
	assert.equal((await call("/v1/models", undefined, { "x-api-key": key })).status, 200);
	await proxy.saveOptions({ ...(await proxy.status()), requireKey: false });
	assert.equal((await call("/v1/models", undefined, {})).status, 200);
	assert.equal(proxy.port, port);
});

test("with no key required, web pages from elsewhere are refused unless they have a key", async (t) => {
	const { proxy, url, key, asked, call } = await start(t, false);
	const chat = { model: "acme/small", messages: [{ role: "user", content: "Hi" }] };
	const from = async (origin: string, headers: Record<string, string> = {}) => (await call("/v1/chat/completions", chat, { origin, ...headers })).status;
	assert.equal(await from("https://example.com"), 403);
	// A sandboxed frame or a local file, and a page that needs no preflight for what it sends.
	assert.equal(await from("null"), 403);
	assert.equal(await from("https://example.com", { "content-type": "text/plain" }), 403);
	assert.equal(await from("https://example.com", { authorization: "Bearer placeholder" }), 403);
	assert.equal(await from("http://192.168.1.50:3000"), 403);
	const refused = await call("/v1/messages", chat, { origin: "https://example.com" });
	assert.equal(((await refused.json()) as Json).error.type, "permission_error");
	assert.equal(asked.model, undefined);
	assert.equal(await from("http://localhost:3000"), 200);
	assert.equal(await from("https://example.com", { authorization: `Bearer ${key}` }), 200);

	// A domain pointed at this computer is same-origin to the browser, so only Host tells.
	const at = (host: string, headers: Record<string, string> = {}) =>
		new Promise<number>((resolve, reject) => {
			request(`${url}/v1/models`, { headers: { host, ...headers } }, (response) => {
				response.resume();
				resolve(response.statusCode!);
			})
				.on("error", reject)
				.end();
		});
	const loopback = ["localhost:8787", "LOCALHOST", "localhost.:8787", "app.localhost:8787", "127.0.0.1:8787", "[::1]:8787", "host.docker.internal:8787"];
	const network = ["192.168.1.20:8787", "192.168.7.7", "10.0.0.5:8787", "172.16.0.1", "172.31.255.1", "100.101.102.103:8787"];
	// Names a peer can claim over mDNS or the router's DNS, addresses that aren't local, and look-alikes.
	const others = ["my-pc:8787", "my-pc.local", "nas.lan", "api.internal", "evil.host.docker.internal", "pc.home.arpa", "8.8.8.8", "172.32.0.1", "0.0.0.0:8787", "169.254.1.1", "[fe80::1]:8787", "[2001:db8::1]:8787"];
	others.push("evil.example:8787", "localhost.evil.example", "127.0.0.1.evil.example", "notlocalhost", "bad host");
	for (const host of loopback) assert.equal(await at(host), 200, host);
	for (const host of [...network, ...others]) assert.equal(await at(host), 403, host);
	for (const host of ["proxy.example", "my-pc.local", "192.168.1.20"]) assert.equal(await at(host, { "x-api-key": key }), 200, host);
	assert.equal(await at("proxy.example", { "x-api-key": "placeholder" }), 403);
	// With the network allowed: private addresses and this computer's own, whatever range it is in, but still no names.
	await proxy.saveOptions({ lan: true });
	for (const host of [...loopback, ...network]) assert.equal(await at(host), 200, host);
	for (const host of others) assert.equal(await at(host), 403, host);
	await proxy.saveOptions({ lan: false });
	assert.equal(await at("192.168.1.20:8787"), 403);
	// Where a key is required, it alone decides.
	await proxy.saveOptions({ ...(await proxy.status()), requireKey: true });
	assert.equal(await at("proxy.example", { "x-api-key": key }), 200);
	assert.equal(await at("localhost:8787"), 401);
});

test("with no key required, a request needs one valid Host", async (t) => {
	const { proxy, key } = await start(t, false);
	/** Sends a request as it is written, which fetch and http.request wouldn't, and gives the status. */
	const raw = (version: string, headers: string[]) =>
		new Promise<number>((resolve, reject) => {
			const socket = connect(proxy.port!, "127.0.0.1");
			let text = "";
			socket.on("data", (chunk) => (text += chunk));
			socket.on("error", reject);
			socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
			socket.write(Buffer.from([`GET /v1/models HTTP/${version}`, ...headers, "Connection: close", "", ""].join("\r\n"), "latin1"));
		});
	const host = (value: string) => raw("1.1", [`Host: ${value}`]);

	assert.equal(await raw("1.0", ["Host: localhost"]), 200);
	assert.equal(await raw("1.0", []), 403);
	// HTTP/1.1 has no request without one, so Node turns it away itself.
	assert.equal(await raw("1.1", []), 400);
	assert.equal(await raw("1.1", ["Host:"]), 403);
	assert.equal(await raw("1.1", ["Host: localhost", "Host: localhost"]), 403);
	assert.equal(await raw("1.1", ["Host: localhost", "Host: evil.example"]), 403);

	const valid = ["localhost", "127.0.0.1", "127.0.0.1:1", "localhost:65535", "[::1]", "[0:0:0:0:0:0:0:1]:8787", "host.docker.internal.:80"];
	for (const value of valid) assert.equal(await host(value), 200, value);
	const malformed = [
		...["evil@localhost", "evil:pass@localhost:8787", "@localhost", "localhost/", "localhost/foo", "localhost\\foo", "localhost?x", "localhost#x", "http://localhost"],
		...["localhost:", "localhost:0", "localhost:65536", "localhost:123456", "localhost:+80", "localhost:80x", "localhost:80:80", ":8787", "local host", "local\thost", "localhost, evil.example"],
		...["localhost\xa0", "%6cocalhost", "l\xf6calhost", ".localhost", "app..localhost", "localhost..", "::1", "[::1", "::1]", "[::1]x", "[]", "[localhost]", "[::1%25eth0]", "[127.0.0.1]"],
	];
	for (const lan of [false, true]) {
		await proxy.saveOptions({ lan });
		for (const value of malformed) assert.equal(await host(value), 403, value);
		assert.equal(await raw("1.0", []), 403);
	}
	// Node stops collecting headers at 2000 unless told not to. None is out of sight, only their size is limited.
	const many = Array.from({ length: 2005 }, () => "a:b");
	assert.equal(await raw("1.1", ["Host: localhost", ...many]), 200);
	assert.equal(await raw("1.1", ["Host: localhost", ...many, "Host: evil.example"]), 403);
	assert.equal(await raw("1.1", ["Host: localhost", ...many, "Host: localhost"]), 403);
	assert.equal(await raw("1.1", ["Host: localhost", ...many, "Origin: https://evil.example"]), 403);
	assert.equal(await raw("1.1", ["Host: evil.example", ...many, `X-Api-Key: ${key}`]), 200);
	assert.equal(await raw("1.1", ["Host: localhost", `a: ${"b".repeat(17_000)}`]), 431);
	// A key lets any of them in, and where one is required a good Host is no help.
	assert.equal(await raw("1.0", [`X-Api-Key: ${key}`]), 200);
	assert.equal(await raw("1.1", ["Host: evil@localhost", `X-Api-Key: ${key}`]), 200);
	await proxy.saveOptions({ requireKey: true });
	assert.equal(await raw("1.0", []), 401);
	assert.equal(await raw("1.1", ["Host: localhost"]), 401);
});

test("no key is required by default, and one must exist before it can be", async (t) => {
	const file = join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json");
	const backend = { models: async () => MODELS, stream: async function* () {} };
	const proxy = new ProxyService({ file, backend });
	t.after(() => proxy.dispose());
	assert.equal((await proxy.status()).requireKey, false);
	const port = await freePort();
	await proxy.saveOptions({ ...(await proxy.status()), port });
	assert.equal((await proxy.setEnabled(true)).running, true);
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 200);

	const required = async () => proxy.saveOptions({ ...(await proxy.status()), requireKey: true });
	await assert.rejects(required(), /Add an API key first/);
	assert.equal((await proxy.status()).requireKey, false);
	const { status } = await proxy.saveKey(undefined, "Tests", "");
	await proxy.setKeyEnabled(status.keys[0]!.id, false);
	await assert.rejects(required(), /Every API key is off/);
	await proxy.setKeyEnabled(status.keys[0]!.id, true);
	assert.equal((await required()).requireKey, true);

	// The choice outlasts a restart, either way.
	assert.equal((await new ProxyService({ file, backend }).status()).requireKey, true);
	await proxy.saveOptions({ ...(await proxy.status()), requireKey: false });
	assert.equal((await new ProxyService({ file, backend }).status()).requireKey, false);
});

test("a proxy set up before the option existed goes on requiring a key", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json");
	const backend = { models: async () => MODELS, stream: async function* () {} };
	const requireKey = async (saved: unknown) => {
		await writeFile(file, typeof saved === "string" ? saved : JSON.stringify(saved));
		return (await new ProxyService({ file, backend }).status()).requireKey;
	};
	const old = { enabled: false, port: 8787, openai: true, anthropic: true, lan: false, keys: [] as Json[], aliases: [] };
	const key = { id: "1", name: "App", digest: "00", hint: "…abcd", enabled: true, createdAt: 1 };
	assert.equal(await requireKey({ ...old, keys: [key] }), true);
	assert.equal(await requireKey({ ...old, keys: [{ ...key, enabled: false }] }), true);
	assert.equal(await requireKey({ ...old, enabled: true }), true);
	assert.equal(await requireKey({ ...old, enabled: true, keys: [key], requireKey: "no" }), true);
	// Never set up, so it gets the default; and a saved choice wins.
	assert.equal(await requireKey(old), false);
	assert.equal(await requireKey("not json"), false);
	assert.equal(await requireKey({ ...old, enabled: true, keys: [key], requireKey: false }), false);
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
	// The other name is described as the model it stands for.
	assert.deepEqual(listing.data[0], { ...listing.data[2], id: "gpt-4o" });

	const aliases = [{ alias: "gpt-4o", model: "acme/big" }];
	assert.equal(resolveModel("gpt-4o", MODELS, aliases).id, "big");
	assert.equal(resolveModel("other/small", MODELS, aliases).provider, "other");
	assert.equal(resolveModel("big", MODELS, aliases).provider, "acme");
	assert.throws(() => resolveModel("small", MODELS, aliases), (error: ProxyError) => error.status === 400 && /provider\/id/.test(error.message));
	assert.throws(() => resolveModel("nope", MODELS, aliases), (error: ProxyError) => error.status === 404);
	await assert.rejects(proxy.saveAliases([{ alias: "a b", model: "acme/big" }]), /without spaces/);
	await assert.rejects(proxy.saveAliases([...aliases, ...aliases]), /twice/);
});

test("the model listing has OpenAI's and Anthropic's fields, with each model's limits and capabilities", async (t) => {
	const { call } = await start(t);
	const response = await call("/v1/models");
	assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
	const listing = (await response.json()) as Json;
	const { data, ...page } = listing;
	assert.deepEqual(page, { object: "list", has_more: false, first_id: "acme/small", last_id: "other/small" });
	const no = { supported: false };
	const yes = { supported: true };
	const unsupported = {
		batch: no,
		citations: no,
		code_execution: no,
		context_management: { supported: false, clear_thinking_20251015: null, clear_tool_uses_20250919: null, compact_20260112: null },
		pdf_input: no,
		structured_outputs: no,
	};
	const common = {
		object: "model",
		type: "model",
		created: 0,
		created_at: "1970-01-01T00:00:00Z",
		owned_by: "acme",
		context_window: 100_000,
		max_output_tokens: 4096,
		max_input_tokens: 100_000,
		max_tokens: 4096,
		output_modalities: ["text"],
	};
	assert.deepEqual(data[0], {
		...common,
		id: "acme/small",
		display_name: "SMALL",
		input_modalities: ["text"],
		capabilities: {
			...unsupported,
			effort: { supported: false, low: no, medium: no, high: no, xhigh: no, max: no },
			image_input: no,
			thinking: { supported: false, types: { adaptive: no, enabled: no } },
		},
	});
	assert.deepEqual(data[1], {
		...common,
		id: "acme/big",
		display_name: "BIG",
		input_modalities: ["text", "image"],
		capabilities: {
			...unsupported,
			effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: no },
			image_input: yes,
			thinking: { supported: true, types: { adaptive: yes, enabled: yes } },
		},
	});
	// Clients that leave out /v1 get the same listing.
	assert.deepEqual(await (await call("/models")).json(), listing);

	// Trivium itself, adding this proxy as a custom endpoint in either format, reads everything back.
	for (const api of ["openai-completions", "anthropic-messages"] as const) {
		assert.deepEqual(parseListing(api, listing), [
			{ id: "acme/big", name: "BIG", contextWindow: 100_000, maxTokens: 4096, images: true, reasoning: true },
			{ id: "acme/small", name: "SMALL", contextWindow: 100_000, maxTokens: 4096, images: false, reasoning: false },
			{ id: "other/small", name: "SMALL", contextWindow: 100_000, maxTokens: 4096, images: false, reasoning: false },
		]);
	}
});

test("a listed model keeps its own limits and effort levels, and a limit that isn't known is null", () => {
	const entry = modelEntry("a/b", model("a", "b", { contextWindow: 1_000_000, maxTokens: 0, reasoning: true, thinkingLevelMap: { low: null, max: "max" } }));
	assert.deepEqual([entry.context_window, entry.max_input_tokens], [1_000_000, 1_000_000]);
	assert.deepEqual([entry.max_output_tokens, entry.max_tokens], [null, null]);
	const { supported, ...levels } = entry.capabilities.effort;
	assert.equal(supported, true);
	assert.deepEqual(
		Object.entries(levels).flatMap(([level, value]) => (value.supported ? [level] : [])),
		["medium", "high", "max"],
	);
	const unnamed = modelEntry("a/b", model("a", "b", { name: "", contextWindow: Number.NaN }));
	assert.deepEqual([unnamed.display_name, unnamed.context_window, unnamed.max_input_tokens], ["b", null, null]);
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
	await assert.rejects(proxy.saveOptions({ port: 80, openai: true, anthropic: true, lan: false, requireKey: true }), /1024 to 65535/);
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

test("a key answers any origin, but only local ones get the CORS headers a browser needs", async (t) => {
	for (const requireKey of [false, true]) {
		const { proxy, url, key, call } = await start(t, requireKey);
		const chat = { model: "acme/small", messages: [{ role: "user", content: "Hi" }] };
		const cors = (response: Response) => ["origin", "methods", "headers"].map((name) => response.headers.get(`access-control-allow-${name}`));
		const preflight = async (origin: string) => {
			const response = await fetch(`${url}/v1/chat/completions`, {
				method: "OPTIONS",
				headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
			});
			return [response.status, ...cors(response)];
		};
		// A plain answer, a stream, a listing and a refusal.
		const answers = async (origin: string) => {
			const headers = { origin, authorization: `Bearer ${key}` };
			const responses = [
				await call("/v1/chat/completions", chat, headers),
				await call("/v1/chat/completions", { ...chat, stream: true }, headers),
				await call("/v1/models", undefined, headers),
				await call("/v1/nothing", undefined, headers),
			];
			await Promise.all(responses.map((response) => response.text()));
			return responses.map((response) => [response.status, ...cors(response)]);
		};
		const statuses = [200, 200, 200, 404];
		const none = [null, null, null];

		for (const origin of ["https://example.com", "null", "http://192.168.1.50:3000"]) {
			assert.deepEqual(await preflight(origin), [204, ...none], origin);
			assert.deepEqual(
				await answers(origin),
				statuses.map((status) => [status, ...none]),
				origin,
			);
			// Without a key the page can't read the refusal either.
			const refused = await call("/v1/chat/completions", chat, { origin });
			assert.deepEqual([refused.status, ...cors(refused)], [requireKey ? 401 : 403, ...none], origin);
		}
		const local = "http://localhost:3000";
		const allowed = [local, "GET, POST, OPTIONS"];
		assert.deepEqual(await preflight(local), [204, ...allowed, "authorization, content-type"]);
		assert.deepEqual(
			await answers(local),
			statuses.map((status) => [status, ...allowed, "authorization, content-type, x-api-key, anthropic-version"]),
		);

		// Pages on the network count as local once it is allowed.
		await proxy.saveOptions({ lan: true });
		assert.equal((await preflight("http://192.168.1.50:3000"))[1], "http://192.168.1.50:3000");
		assert.equal((await preflight("https://example.com"))[1], null);
	}
});

/** Where the proxy's socket really is, or undefined when it has none. */
const socketOf = (proxy: ProxyService): string | undefined => {
	const { server } = proxy as unknown as { server?: { address(): AddressInfo } };
	return server && `${server.address().address}:${server.address().port}`;
};

const quiet = { models: async () => MODELS, stream: async function* () {} };

/** A proxy with nothing set up, or with what a file says. */
async function bare(t: TestContext, saved?: Json): Promise<{ proxy: ProxyService; file: string; emitted: Json[] }> {
	const file = join(await mkdtemp(join(tmpdir(), "trivium-proxy-")), "proxy.json");
	if (saved) await writeFile(file, JSON.stringify(saved));
	const emitted: Json[] = [];
	const proxy = new ProxyService({ file, backend: quiet, emit: (status) => emitted.push(status), addresses: () => [] });
	t.after(() => proxy.dispose());
	return { proxy, file, emitted };
}

/** What happens instead of writing, or of putting in place, a new version of a file. Each is given what would do it. */
const writing = new Map<string, (write: () => Promise<void>, text: string) => Promise<void>>();
const placing = new Map<string, (place: () => void) => void>();
const { writeFile: realWrite } = fsPromises;
const { renameSync: realRename } = fs;
fsPromises.writeFile = ((...args: Parameters<typeof realWrite>) => {
	const path = String(args[0]);
	const file = [...writing.keys()].find((entry) => path.startsWith(`${entry}.`));
	const write = () => realWrite(...args);
	return file ? writing.get(file)!(write, String(args[1])) : write();
}) as typeof realWrite;
fs.renameSync = (from, to) => {
	const hook = placing.get(String(to));
	const place = () => realRename(from, to);
	if (hook) hook(place);
	else place();
};
syncBuiltinESMExports();

/** Makes every save fail until the function it returns is called. */
function breakSaving(file: string): () => void {
	writing.set(file, async () => {
		throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
	});
	return () => void writing.delete(file);
}

/** The files being written that were left beside the file. */
const drafts = async (file: string): Promise<string[]> => (await readdir(dirname(file))).filter((name) => name !== basename(file) && name !== `${basename(file)}.lock.sqlite`);

test("a start and a change of reach at the same time leave the socket where the settings say", async (t) => {
	const { proxy, file } = await bare(t);
	const check = async (lan: boolean, running = true) => {
		const status = await proxy.status();
		assert.deepEqual([status.lan, status.running, status.enabled], [lan, running, running]);
		assert.equal(socketOf(proxy), running ? `${lan ? "0.0.0.0" : "127.0.0.1"}:${status.port}` : undefined);
		const saved = JSON.parse(await readFile(file, "utf8"));
		assert.deepEqual([saved.lan, saved.enabled], [lan, running]);
	};
	const port = await freePort();
	await proxy.saveOptions({ port, lan: true });
	await Promise.all([proxy.setEnabled(true), proxy.saveOptions({ lan: false })]);
	await check(false);

	// Whichever was asked for last wins, and the key requirement stays beside it.
	const { status } = await proxy.saveKey(undefined, "Tests", "");
	await Promise.all([proxy.saveOptions({ requireKey: true }), proxy.saveOptions({ lan: true }), proxy.saveOptions({ lan: false }), proxy.saveOptions({ lan: true })]);
	await check(true);
	assert.equal((await proxy.status()).requireKey, true);
	await Promise.all([proxy.setEnabled(false), proxy.setEnabled(true), proxy.saveOptions({ lan: false }), proxy.setEnabled(false)]);
	await check(false, false);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/`));

	// Starting with Trivium takes its turn too.
	await proxy.setEnabled(true);
	await proxy.saveOptions({ lan: true });
	proxy.dispose();
	const again = new ProxyService({ file, backend: quiet, addresses: () => [] });
	t.after(() => again.dispose());
	await Promise.all([again.init(), again.saveOptions({ lan: false })]);
	assert.equal(socketOf(again), `127.0.0.1:${port}`);
	assert.equal((await again.status()).lan, false);

	// A change that fails doesn't hold up the next.
	const outcomes = await Promise.allSettled([again.saveOptions({ port: 1 }), again.removeKey(status.keys[0]!.id), again.saveOptions({ requireKey: false })]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["rejected", "fulfilled", "fulfilled"],
	);
});

test("a status never pairs one moment's settings with another's socket", async (t) => {
	const { file } = await bare(t);
	const waiting: (() => void)[] = [];
	const proxy = new ProxyService({
		file,
		addresses: () => [],
		backend: { ...quiet, models: () => new Promise((resolve) => waiting.push(() => resolve(MODELS))) },
	});
	t.after(() => proxy.dispose());
	const port = await freePort();
	const before = proxy.status();
	// Listing the models hangs, which holds up neither change.
	const changes = [proxy.saveOptions({ port, lan: true }), proxy.setEnabled(true)];
	while (!socketOf(proxy)) await new Promise((resolve) => setTimeout(resolve, 5));
	waiting.shift()!();
	const status = await before;
	assert.deepEqual([status.lan, status.port, status.enabled, status.running], [true, port, true, true]);
	while (waiting.length < changes.length) await new Promise((resolve) => setTimeout(resolve, 5));
	for (const answer of waiting) answer();
	await Promise.all(changes);
});

test("no request is served by a socket whose settings aren't in force, or after Trivium quits", async (t) => {
	const { proxy } = await bare(t);
	const port = await freePort();
	await proxy.saveOptions({ port });
	const inner = proxy as unknown as { listen(options: Json): Promise<{ close(done: () => void): void }> };
	const early = await inner.listen({ port, lan: false });
	const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
	assert.deepEqual([response.status, response.headers.get("retry-after")], [503, "1"]);
	await new Promise<void>((resolve) => early.close(resolve));

	const opening = proxy.setEnabled(true);
	proxy.dispose();
	await opening;
	assert.equal(socketOf(proxy), undefined);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/models`));
});

test("changing one option keeps the others, even ones changed at the same moment", async (t) => {
	const { proxy, file } = await bare(t);
	await proxy.saveKey(undefined, "Tests", "");
	const port = await freePort();
	await Promise.all([proxy.saveOptions({ requireKey: true }), proxy.saveOptions({ anthropic: false }), proxy.saveOptions({ port }), proxy.saveOptions({ lan: true })]);
	const expected = { port, openai: true, anthropic: false, lan: true, requireKey: true };
	const options = ({ port, openai, anthropic, lan, requireKey }: Json) => ({ port, openai, anthropic, lan, requireKey });
	assert.deepEqual(options(await proxy.status()), expected);
	assert.deepEqual(options(JSON.parse(await readFile(file, "utf8"))), expected);

	// Only true or false changes a switch, and what isn't an option isn't kept.
	await proxy.saveOptions({ requireKey: undefined, lan: null, enabled: true, keys: [] } as Json);
	const status = await proxy.status();
	assert.deepEqual(options(status), expected);
	assert.deepEqual([status.enabled, status.keys.length], [false, 1]);

	// Each is checked against the options as they then stand: these two would leave no format.
	await proxy.saveOptions({ anthropic: true });
	const outcomes = await Promise.allSettled([proxy.saveOptions({ openai: false }), proxy.saveOptions({ anthropic: false })]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["fulfilled", "rejected"],
	);
	assert.equal((await proxy.status()).anthropic, true);
});

test("a change that can't be saved isn't made", async (t) => {
	const { proxy, file, key, call } = await start(t);
	const before = await proxy.status();
	const [only] = before.keys;
	const disk = await readFile(file, "utf8");
	const spare = await freePort();
	const repair = breakSaving(file);
	const changes: [string, () => Promise<unknown>][] = [
		["requireKey", () => proxy.saveOptions({ requireKey: false })],
		["reach", () => proxy.saveOptions({ lan: true, requireKey: false })],
		["port", () => proxy.saveOptions({ port: spare })],
		["off", () => proxy.setEnabled(false)],
		["add", () => proxy.saveKey(undefined, "Other", "my-own-key-0123456789")],
		["replace", () => proxy.saveKey(only!.id, "Tests", "my-own-key-0123456789")],
		["disable", () => proxy.setKeyEnabled(only!.id, false)],
		["remove", () => proxy.removeKey(only!.id)],
		["aliases", () => proxy.saveAliases([{ alias: "a", model: "acme/big" }])],
	];
	for (const [name, change] of changes) {
		await assert.rejects(change(), { code: "ENOSPC" }, name);
		assert.deepEqual(await proxy.status(), before, name);
		assert.equal(socketOf(proxy), `127.0.0.1:${before.port}`, name);
		assert.equal(await readFile(file, "utf8"), disk, name);
		assert.equal((await call("/v1/models", undefined, {})).status, 401, name);
		assert.equal((await call("/v1/models", undefined, { "x-api-key": "my-own-key-0123456789" })).status, 401, name);
	}
	await assert.rejects(fetch(`http://127.0.0.1:${spare}/`));
	assert.equal((await call("/v1/models", undefined, { "x-api-key": key })).status, 200);
	repair();
	await proxy.saveOptions({ requireKey: false });
	assert.equal((await call("/v1/models", undefined, {})).status, 200);

	// Nor is a requirement that couldn't be saved enforced, or a proxy that couldn't be turned on left listening.
	breakSaving(file);
	await assert.rejects(proxy.saveOptions({ requireKey: true }));
	assert.equal((await call("/v1/models", undefined, {})).status, 200);
	const idle = await bare(t);
	await idle.proxy.saveOptions({ port: spare });
	breakSaving(idle.file);
	await assert.rejects(idle.proxy.setEnabled(true));
	const status = await idle.proxy.status();
	assert.deepEqual([status.enabled, status.running, socketOf(idle.proxy)], [false, false, undefined]);
	await assert.rejects(fetch(`http://127.0.0.1:${spare}/`));
});

/** Another Trivium with the same profile. */
function second(t: TestContext, file: string): ProxyService {
	const proxy = new ProxyService({ file, backend: quiet, addresses: () => [] });
	t.after(() => proxy.dispose());
	return proxy;
}

test("a Trivium with stale settings doesn't undo what another with the same profile saved", async (t) => {
	const { proxy: one, file } = await bare(t);
	const two = second(t, file);
	const disk = async () => JSON.parse(await readFile(file, "utf8"));
	const { status } = await one.saveKey(undefined, "One", "");
	await one.saveOptions({ requireKey: true });
	// The other read the file before any of that.
	const changed = await two.saveOptions({ anthropic: false });
	assert.deepEqual([changed.requireKey, changed.anthropic, changed.keys.length], [true, false, 1]);
	const saved = await disk();
	assert.deepEqual([saved.requireKey, saved.anthropic, saved.keys.length], [true, false, 1]);
	assert.equal((await second(t, file).status()).requireKey, true);

	// Either way around, for every kind of change, and for the requirement being lifted.
	const other = await two.saveKey(undefined, "Two", "my-own-key-0123456789");
	await one.saveAliases([{ alias: "a", model: "acme/big" }]);
	await two.setKeyEnabled(status.keys[0]!.id, false);
	const port = await freePort();
	await one.saveOptions({ port });
	await two.removeKey(status.keys[0]!.id);
	await assert.rejects(one.setKeyEnabled(status.keys[0]!.id, true), /gone/);
	await assert.rejects(one.saveKey(undefined, "Two", ""), /already/);
	const end = await disk();
	assert.deepEqual([end.requireKey, end.anthropic, end.port, end.aliases.length], [true, false, port, 1]);
	assert.deepEqual(
		end.keys.map((key: Json) => key.id),
		[other.status.keys[1]!.id],
	);
	await one.saveOptions({ requireKey: false });
	await two.saveOptions({ anthropic: true });
	assert.equal((await disk()).requireKey, false);

	// Each is checked against what the other saved. Asked to at once, they take turns.
	await one.saveOptions({ requireKey: true });
	await Promise.all(
		Array.from({ length: 12 }, (_, n) => [one, two][n % 2]!).map((proxy, n) => (n < 2 ? proxy.saveOptions(n ? { lan: true } : { openai: false }) : proxy.saveKey(undefined, `Key ${n}`, ""))),
	);
	const both = await disk();
	assert.deepEqual([both.requireKey, both.openai, both.lan, both.keys.length], [true, false, true, 11]);
	await assert.rejects(two.saveOptions({ anthropic: false }), /at least one format/);
	assert.deepEqual(
		(await one.status()).keys.map((key) => key.id),
		(await two.status()).keys.map((key) => key.id),
	);
});

test("a running proxy goes by what another Trivium saved, from its next request", async (t) => {
	const { proxy, file, key, call } = await start(t, false);
	const two = second(t, file);
	const address = socketOf(proxy);
	assert.equal((await call("/v1/models", undefined, {})).status, 200);
	await two.saveOptions({ requireKey: true });
	assert.equal((await call("/v1/models", undefined, {})).status, 401);
	assert.equal((await call("/v1/models")).status, 200);
	assert.equal(socketOf(proxy), address);
	// The use just made of the key isn't lost to a change that didn't know of it.
	const used = (await proxy.status()).keys[0]!.lastUsedAt;
	assert.ok(used);
	await two.saveOptions({ anthropic: false });
	assert.equal((await proxy.status()).keys[0]!.lastUsedAt, used);
	const [only] = (await two.status()).keys;
	await two.setKeyEnabled(only!.id, false);
	assert.equal((await call("/v1/models")).status, 401);
	await two.setKeyEnabled(only!.id, true);

	// The socket moves along with the settings, and a page that shows them says so.
	const port = await freePort();
	await proxy.saveOptions({ lan: true });
	proxy.dispose();
	const running = second(t, file);
	await running.init();
	const { saved } = two as unknown as { saved: Json };
	await writeFile(file, JSON.stringify({ ...saved, port, lan: false, enabled: true }));
	const status = await running.status();
	assert.deepEqual([status.port, status.lan, status.running, status.requireKey], [port, false, true, true]);
	assert.equal(socketOf(running), `127.0.0.1:${port}`);
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "x-api-key": key } })).status, 200);
	await two.setEnabled(false);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/models`));
	assert.equal(socketOf(running), undefined);
	assert.equal((await running.status()).enabled, false);

	// A file that was damaged or deleted doesn't lift the requirement.
	for (const damage of [() => writeFile(file, '{"requireKey": fal'), () => writeFile(file, "[]"), () => rm(file)]) {
		await damage();
		assert.equal((await running.saveOptions({ anthropic: true })).requireKey, true);
		assert.equal(JSON.parse(await readFile(file, "utf8")).requireKey, true);
	}
});

/**
 * Another process with the same profile, which makes a change and then says so. At "pause" it stops right before its
 * change is put in place, with everything before that done, until a file appears: as when the system suspends it.
 */
function other(t: TestContext, file: string, change: string, at: "pause" | "exit" | "go on" = "go on") {
	const code = `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		const [file, at] = process.argv.slice(1);
		const say = (text) => fs.writeSync(1, text + "\\n");
		const wait = (name) => {
			while (!fs.existsSync(file + name)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		};
		const rename = fs.renameSync;
		fs.renameSync = (from, to) => {
			if (at !== "go on") say("placing");
			if (at === "exit") process.exit(0);
			if (at === "pause") wait(".resume");
			rename(from, to);
		};
		syncBuiltinESMExports();
		const { ProxyService } = await import(${JSON.stringify(new URL("../src/main/proxy.ts", import.meta.url).href)});
		const proxy = new ProxyService({ file, backend: { models: async () => [], stream: async function* () {} }, addresses: () => [] });
		try {
			${change}
			say("done");
		} catch (error) {
			say(error.message);
		}
		// Ends like any process does, without giving anything up by itself.
	`;
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", code, file, at], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => child.kill("SIGKILL"));
	let output = "";
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const placing = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (data) => {
			output += data;
			if (output.includes("placing\n")) resolve();
		});
		void exited.then(() => reject(new Error(`It ended: ${output}`)));
	});
	placing.catch(() => {});
	return {
		placing,
		/** What it said last, once it has ended. */
		ended: exited.then(() => output.trim().split("\n").pop()!),
		resume: () => realWrite(`${file}.resume`, ""),
		kill: async () => (child.kill("SIGKILL"), await exited),
	};
}

test("a process suspended just before saving keeps every other from saving, however long", async (t) => {
	const { proxy, file } = await bare(t);
	await proxy.saveKey(undefined, "Tests", "");
	const before = await readFile(file, "utf8");
	const lock = `${file}.lock.sqlite`;
	const suspended = other(t, file, "await proxy.saveOptions({ openai: false });", "pause");
	await suspended.placing;
	// What would make a lock that expires look like it did.
	const old = new Date(Date.now() - 3_600_000);
	await utimes(lock, old, old);
	const id = (await stat(lock, { bigint: true })).ino;

	// Here and in another process, which then ends: that gives up nothing it didn't have.
	const refused = assert.rejects(proxy.saveOptions({ requireKey: true }), /Another Trivium/);
	assert.match(await other(t, file, "await proxy.saveOptions({ lan: true });").ended, /Another Trivium/);
	await refused;
	assert.equal((await stat(lock, { bigint: true })).ino, id);
	await assert.rejects(proxy.saveAliases([{ alias: "a", model: "acme/big" }]), /Another Trivium/);
	assert.equal(await readFile(file, "utf8"), before);

	// So it overwrites nothing when it goes on, and the next change is made to what it saved.
	await suspended.resume();
	assert.equal(await suspended.ended, "done");
	await proxy.saveOptions({ requireKey: true });
	const { openai, requireKey, lan, aliases } = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual([openai, requireKey, lan, aliases], [false, true, false, []]);
	assert.equal((await stat(lock, { bigint: true })).ino, id);
});

test("a process that ends while saving lets the next one save at once", async (t) => {
	for (const how of ["killed", "exit"] as const) {
		const { proxy, file } = await bare(t);
		await proxy.saveOptions({ port: await freePort() });
		const child = other(t, file, "await proxy.saveOptions({ openai: false });", how === "exit" ? "exit" : "pause");
		await child.placing;
		const change = proxy.saveOptions({ anthropic: false });
		if (how === "killed") await child.kill();
		const started = Date.now();
		await change;
		assert.ok(Date.now() - started < 4000, how);
		const { openai, anthropic } = JSON.parse(await readFile(file, "utf8"));
		assert.deepEqual([openai, anthropic], [true, false], how);
	}
});

test("a process that has saved before doesn't give up the lock of another when it ends", async (t) => {
	const { proxy, file } = await bare(t);
	const first = other(
		t,
		file,
		`
			await proxy.saveOptions({ lan: true });
			say("placing");
			wait(".resume");
		`,
	);
	await first.placing;
	let write!: () => void;
	const mayWrite = new Promise<void>((resolve) => (write = resolve));
	await new Promise<void>((resolve) => {
		writing.set(file, async (go) => {
			resolve();
			await mayWrite;
			await go();
		});
		void proxy.saveOptions({ openai: false }).catch(() => {});
	});
	await first.resume();
	assert.equal(await first.ended, "done");
	assert.match(await other(t, file, "await proxy.saveOptions({ anthropic: false });").ended, /Another Trivium/);
	writing.delete(file);
	write();
	await proxy.saveOptions({ requireKey: false });
	const { lan, openai, anthropic } = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual([lan, openai, anthropic], [true, false, true]);
});

test("processes that change the settings at the same moment all have theirs saved", async (t) => {
	const { proxy, file } = await bare(t);
	const names = ["a", "b", "c", "d"];
	const children = names.map((name) => other(t, file, `for (let n = 0; n < 6; n++) await proxy.saveKey(undefined, "${name}" + n, "");`));
	for (const child of children) assert.equal(await child.ended, "done");
	const expected = names.flatMap((name) => Array.from({ length: 6 }, (_, n) => name + n));
	assert.deepEqual((await proxy.status()).keys.map((key) => key.name).sort(), expected);
	assert.deepEqual(await drafts(file), []);
});

test("a change isn't made to settings that something else changed meanwhile", async (t) => {
	const { proxy, file } = await bare(t);
	await proxy.saveKey(undefined, "Tests", "");
	const inner = proxy as unknown as { listen(options: Json): Promise<unknown> };
	const listen = inner.listen.bind(proxy);
	const port = await freePort();
	await proxy.saveOptions({ port });
	const theirs = JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), aliases: [{ alias: "theirs", model: "acme/big" }] });
	inner.listen = async (options) => {
		await writeFile(file, theirs);
		return listen(options);
	};
	await assert.rejects(proxy.setEnabled(true), /Another Trivium/);
	assert.equal(await readFile(file, "utf8"), theirs);
	assert.equal(socketOf(proxy), undefined);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
	inner.listen = listen;
	const status = await proxy.setEnabled(true);
	assert.deepEqual([status.running, status.aliases.length], [true, 1]);
});

test("a change that can't be put in place yet is checked each time it is tried", async (t) => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	t.after(() => Object.defineProperty(process, "platform", platform));
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	const { proxy, file } = await bare(t);
	await proxy.saveOptions({ port: await freePort() });
	/** Fails the first attempt, as while a scanner has the file open, and does something before the next. */
	const meanwhile = (action: () => void) => {
		let attempts = 0;
		placing.set(file, (place) => {
			attempts++;
			if (attempts > 1) return place();
			action();
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		});
		return () => attempts;
	};
	const before = await readFile(file, "utf8");
	// Also by settings of the same length.
	const theirs = before.replace('"requireKey": false', '"requireKey": true ');
	assert.deepEqual([theirs.length, theirs === before], [before.length, false]);
	const changed = meanwhile(() => fs.writeFileSync(file, theirs));
	await assert.rejects(proxy.saveOptions({ openai: false }), /Another Trivium/);
	assert.equal(changed(), 1);
	assert.equal(await readFile(file, "utf8"), theirs);
	const status = await proxy.status();
	assert.deepEqual([status.openai, status.requireKey], [true, true]);
	assert.deepEqual(await drafts(file), []);
	const attempts = meanwhile(() => {});
	await proxy.saveOptions({ openai: false });
	assert.equal(attempts(), 2);
	assert.equal(JSON.parse(await readFile(file, "utf8")).openai, false);
	placing.delete(file);
});

/** Takes away the right to read a file, and nothing else. Returns what gives it back. */
function denyReading(file: string): () => void {
	if (process.platform !== "win32") {
		const { mode } = fs.statSync(file);
		fs.chmodSync(file, 0o000);
		return () => fs.chmodSync(file, mode & 0o777);
	}
	// Everyone, by the ID that is the same in every language.
	const icacls = (...args: string[]) => execFileSync("icacls", [file, ...args], { stdio: "pipe" });
	icacls("/deny", "*S-1-1-0:(RD)");
	return () => icacls("/remove:d", "*S-1-1-0");
}

test("a running proxy answers nobody, and changes nothing, once it may not read its settings", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root may read every file");
	const { proxy, file, key, call } = await start(t, false);
	const inner = proxy as unknown as { emit(status: Json): void; usedTimer?: NodeJS.Timeout };
	const emitted: Json[] = [];
	const statuses = async () => [(await call("/v1/models", undefined, {})).status, (await call("/v1/models")).status];
	const stamp = async () => {
		const { ino, size, mtimeNs } = await stat(file, { bigint: true });
		return [ino, size, mtimeNs];
	};
	assert.deepEqual(await statuses(), [200, 200]);
	// Its use is yet to be noted.
	assert.ok(inner.usedTimer);
	inner.emit = (status) => emitted.push(status);
	const before = await readFile(file, "utf8");
	assert.equal(JSON.parse(before).keys[0].lastUsedAt, undefined);
	const intact = await stamp();
	const allow = denyReading(file);
	try {
		await assert.rejects(readFile(file, "utf8"), (error: NodeJS.ErrnoException) => error.code === "EACCES" || error.code === "EPERM");
		assert.deepEqual(await stamp(), intact);
		assert.deepEqual(await statuses(), [503, 503]);
		const status = await proxy.status();
		assert.equal(status.running, true);
		assert.match(status.error!, /can't be read, so it refuses every request and nothing here can be changed: (EACCES|EPERM)/);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual([emitted.length, emitted[0]?.error], [1, status.error]);

		// Nothing puts other settings in its place, which the directory would still allow.
		await new Promise((resolve) => setTimeout(resolve, 3500));
		assert.equal(inner.usedTimer, undefined);
		for (const change of [() => proxy.saveOptions({ requireKey: true }), () => proxy.saveKey(undefined, "Other", ""), () => proxy.setEnabled(false)]) {
			await assert.rejects(change(), { code: /EACCES|EPERM/ });
		}
		assert.deepEqual(await stamp(), intact);
		assert.deepEqual(await statuses(), [503, 503]);
		assert.deepEqual(await drafts(file), []);

		// One that starts then says so too.
		const started = second(t, file);
		await assert.rejects(started.init());
		assert.match((await started.status()).error!, /can't be read/);
	} finally {
		allow();
	}
	assert.equal(await readFile(file, "utf8"), before);
	assert.deepEqual(await statuses(), [200, 200]);
	assert.equal((await proxy.status()).error, undefined);
});

test("a proxy that couldn't start says first that it may not read its settings, for as long as that goes on", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root may read every file");
	const blocker = createServer();
	await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
	t.after(() => blocker.close());
	const { port } = blocker.address() as { port: number };
	const { proxy, file } = await bare(t, { enabled: true, port, openai: true, anthropic: true, lan: false, requireKey: false, keys: [], aliases: [] });
	await proxy.init();
	const inUse = (await proxy.status()).error!;
	assert.match(inUse, /in use by another app/);
	const allow = denyReading(file);
	try {
		const status = await proxy.status();
		assert.equal(status.running, false);
		assert.match(status.error!, /can't be read, so it refuses every request and nothing here can be changed: (EACCES|EPERM)/);
	} finally {
		allow();
	}
	const status = await proxy.status();
	assert.deepEqual([status.running, status.error], [false, inUse]);
});

test("a change that loses the right to read the settings before it is put in place isn't", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root may read every file");
	const { proxy, file } = await bare(t);
	await proxy.saveOptions({ port: await freePort() });
	const before = await readFile(file, "utf8");
	let allow!: () => void;
	writing.set(file, async (write) => {
		await write();
		allow = denyReading(file);
	});
	try {
		await assert.rejects(proxy.saveOptions({ openai: false }), { code: /EACCES|EPERM/ });
	} finally {
		writing.delete(file);
		allow();
	}
	assert.equal(await readFile(file, "utf8"), before);
	assert.deepEqual(await drafts(file), []);
});

test("a running proxy answers nobody while what another Trivium saved can't be read", async (t) => {
	const { proxy, file, key, call } = await start(t, false);
	const emitted: Json[] = [];
	// Noting that a key was used is left for last.
	const inner = proxy as unknown as { emit(status: Json): void; usedTimer?: NodeJS.Timeout };
	inner.emit = (status) => emitted.push(status);
	inner.usedTimer = setTimeout(() => {}, 60_000).unref();
	const statuses = async () => [(await call("/v1/models", undefined, {})).status, (await call("/v1/models", undefined, { "x-api-key": key })).status];
	const open = JSON.parse(await readFile(file, "utf8"));
	const required = { ...open, requireKey: true };
	const address = socketOf(proxy);
	assert.deepEqual(await statuses(), [200, 200]);
	const damages: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
		["cut short", () => writeFile(file, '{"requireKey": tr'), () => rm(file)],
		["not settings", () => writeFile(file, "[]"), () => rm(file)],
		["gone", () => rm(file), async () => {}],
		["unreadable", async () => (await rm(file), await mkdir(file)), () => rmdir(file)],
	];
	for (const [name, damage, clear] of damages) {
		// What the next settings turn out to be decides, whichever were in force before.
		for (const [next, expected] of [[open, [200, 200]], [required, [401, 200]], [required, [401, 200]], [open, [200, 200]]] as const) {
			emitted.length = 0;
			await damage();
			assert.deepEqual(await statuses(), [503, 503], name);
			// Also once it is known to be damaged.
			assert.deepEqual(await statuses(), [503, 503], name);
			const status = await proxy.status();
			assert.deepEqual([status.running, socketOf(proxy)], [true, address], name);
			assert.match(status.error!, /can't be read/, name);
			await new Promise((resolve) => setTimeout(resolve, 10));
			// Said once, not for every request.
			assert.deepEqual([emitted.length, /can't be read/.test(emitted[0]!.error)], [1, true], name);
			await clear();
			await writeFile(file, JSON.stringify(next));
			assert.deepEqual(await statuses(), expected, name);
			assert.equal((await proxy.status()).error, undefined, name);
		}
	}

	// That doesn't put the settings from before back in force; a change does.
	inner.usedTimer = undefined;
	assert.deepEqual(await statuses(), [200, 200]);
	await writeFile(file, '{"requireKey": tr');
	await new Promise((resolve) => setTimeout(resolve, 3500));
	assert.equal(await readFile(file, "utf8"), '{"requireKey": tr');
	assert.deepEqual(await statuses(), [503, 503]);
	await proxy.saveOptions({ requireKey: true });
	assert.deepEqual(await statuses(), [401, 200]);
	await writeFile(file, "[]");
	assert.deepEqual(await statuses(), [503, 503]);
	await proxy.saveOptions({ anthropic: false });
	assert.deepEqual(await statuses(), [401, 200]);
});

test("a key added in order to require one is required from the first request on", async (t) => {
	/** A proxy that is on and requires no key, but found its port in use, which it no longer is. */
	const stuck = async (extra: Json = {}) => {
		const port = await freePort();
		const { proxy, file } = await bare(t, { enabled: true, port, openai: true, anthropic: true, lan: false, requireKey: false, keys: [], aliases: [], ...extra });
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
		await proxy.init();
		assert.match((await proxy.status()).error!, /in use by another app/);
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		return { proxy, file, port, url: `http://127.0.0.1:${port}/v1/models` };
	};
	const closed = async ({ proxy, url }: { proxy: ProxyService; url: string }) => {
		assert.equal(socketOf(proxy), undefined);
		await assert.rejects(fetch(url));
	};

	const { proxy, file, url } = await stuck();
	// What is on disk as the socket opens, in case Trivium closes right then.
	const inner = proxy as unknown as { listen(options: Json): Promise<unknown> };
	const listen = inner.listen.bind(proxy);
	const opened: Json[] = [];
	inner.listen = async (options) => {
		opened.push(JSON.parse(await readFile(file, "utf8")));
		return listen(options);
	};
	// A client that has been trying all along, without a key.
	const answers: number[] = [];
	let trying = true;
	t.after(() => (trying = false));
	const client = (async () => {
		while (trying) {
			await fetch(url, { headers: { connection: "close" } }).then(
				(response) => answers.push(response.status),
				() => new Promise((resolve) => setTimeout(resolve, 1)),
			);
		}
	})();
	const { status, key } = await proxy.saveKey(undefined, "Tests", "", "require");
	assert.deepEqual([status.running, status.requireKey, status.error, status.keys.length], [true, true, undefined, 1]);
	while (!answers.includes(401)) await new Promise((resolve) => setTimeout(resolve, 5));
	trying = false;
	await client;
	// 503 is the socket before its settings are in force.
	assert.deepEqual(
		answers.filter((answer) => answer !== 401 && answer !== 503),
		[],
	);
	assert.equal(answers.find((answer) => answer !== 503), 401);
	assert.deepEqual(
		opened.map((saved) => [saved.requireKey, saved.keys.length]),
		[[true, 1]],
	);
	assert.equal((await fetch(url, { headers: { "x-api-key": key! } })).status, 200);

	// Both or neither: nothing opens when they can't be saved.
	const failing = await stuck();
	const repair = breakSaving(failing.file);
	await assert.rejects(failing.proxy.saveKey(undefined, "Tests", "", "require"));
	await closed(failing);
	const before = await failing.proxy.status();
	assert.deepEqual([before.requireKey, before.keys.length], [false, 0]);
	repair();
	await failing.proxy.saveKey(undefined, "Tests", "", "require");
	assert.equal((await fetch(failing.url)).status, 401);

	// Nor does it open over a key added, or turned on, before one is required.
	const added = await stuck();
	const plain = await added.proxy.saveKey(undefined, "Tests", "");
	await closed(added);
	await added.proxy.setKeyEnabled(plain.status.keys[0]!.id, false);
	await added.proxy.setKeyEnabled(plain.status.keys[0]!.id, true);
	await closed(added);
	assert.equal((await added.proxy.saveOptions({ requireKey: true })).running, true);
	assert.equal((await fetch(added.url)).status, 401);

	// A key that is off requires nothing, whatever it is saved for.
	const off = await stuck({ keys: [{ id: "1", name: "App", digest: "00", hint: "…abcd", enabled: false, createdAt: 1 }] });
	await assert.rejects(off.proxy.saveKey("1", "App", "", "require"), /Every API key is off/);
	await closed(off);
	assert.equal((await off.proxy.saveKey(undefined, "New", "", "require")).status.requireKey, true);
	assert.equal((await fetch(off.url)).status, 401);
});

test("a key added in order to start the proxy starts it, or says why it can't", async (t) => {
	const port = await freePort();
	const saved = { enabled: false, port, openai: true, anthropic: true, lan: false, requireKey: true, keys: [], aliases: [] };
	const { proxy } = await bare(t, saved);
	await assert.rejects(proxy.setEnabled(true), /Add an API key first/);
	const { status } = await proxy.saveKey(undefined, "Tests", "", "start");
	assert.deepEqual([status.enabled, status.running, status.requireKey], [true, true, true]);
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);

	// The key is kept, and shown, when the port turns out to be taken.
	const late = await bare(t, saved);
	const taken = await late.proxy.saveKey(undefined, "Tests", "", "start");
	assert.ok(taken.key);
	assert.deepEqual([taken.status.enabled, taken.status.running, taken.status.keys.length], [true, false, 1]);
	assert.match(taken.status.error!, /in use by another app/);
	proxy.dispose();

	// Another Trivium stopped requiring one while it was being added: it isn't opened to everyone instead.
	const raced = await bare(t, saved);
	const two = second(t, raced.file);
	assert.equal((await raced.proxy.status()).requireKey, true);
	await two.saveOptions({ requireKey: false });
	const disk = await readFile(raced.file, "utf8");
	await assert.rejects(raced.proxy.saveKey(undefined, "Tests", "", "start"), /no longer requires an API key/);
	assert.equal(await readFile(raced.file, "utf8"), disk);
	assert.equal(socketOf(raced.proxy), undefined);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/models`));
	// Settings hears where that left it.
	while (!raced.emitted.length) await new Promise((resolve) => setTimeout(resolve, 5));
	const now = raced.emitted.at(-1)!;
	assert.deepEqual([now.requireKey, now.enabled, now.running, now.keys.length], [false, false, false, 0]);
	// It says the same however often it is tried, and starts without one only when asked to.
	await assert.rejects(raced.proxy.saveKey(undefined, "Tests", "", "start"), /no longer requires an API key/);
	const opened = await raced.proxy.setEnabled(true);
	assert.deepEqual([opened.running, opened.requireKey], [true, false]);
});

test("however it starts, a proxy that requires a key needs one that is on", async (t) => {
	const port = await freePort();
	const stored = { id: "1", name: "App", digest: "00", hint: "…abcd", enabled: false, createdAt: 1 };
	const stuck = async (keys: Json[], error: RegExp) => {
		const { proxy } = await bare(t, { enabled: true, port, openai: true, anthropic: true, lan: false, requireKey: true, aliases: [], keys });
		const check = async () => {
			const status = await proxy.status();
			assert.deepEqual([status.enabled, status.running, socketOf(proxy)], [true, false, undefined]);
			assert.match(status.error!, error);
		};
		await proxy.init();
		await check();
		await assert.rejects(proxy.setEnabled(true), error);
		await check();
		await proxy.saveOptions({ anthropic: false });
		await check();
		return proxy;
	};
	const recovered = async (proxy: ProxyService, withoutKey: number) => {
		const status = await proxy.status();
		assert.deepEqual([status.running, status.error], [true, undefined]);
		assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, withoutKey);
		proxy.dispose();
	};
	const none = await stuck([], /Add an API key first/);
	await none.saveKey(undefined, "New", "");
	await recovered(none, 401);
	const off = await stuck([stored], /Every API key is off/);
	await off.setKeyEnabled("1", true);
	await recovered(off, 401);
	const opened = await stuck([stored], /Every API key is off/);
	await opened.saveOptions({ requireKey: false });
	await recovered(opened, 200);

	// The last key of a running proxy can still be turned off or removed, which shuts everyone out until there is another.
	const { proxy, file, key, call } = await start(t);
	const [only] = (await proxy.status()).keys;
	assert.equal((await proxy.setKeyEnabled(only!.id, false)).running, true);
	assert.equal((await call("/v1/models")).status, 401);
	// Moving it isn't starting it.
	assert.equal((await proxy.saveOptions({ lan: true })).running, true);
	assert.equal((await proxy.saveOptions({ lan: false })).running, true);
	await proxy.setKeyEnabled(only!.id, true);
	assert.equal((await call("/v1/models")).status, 200);
	await proxy.removeKey(only!.id);
	assert.equal((await call("/v1/models")).status, 401);
	proxy.dispose();
	const again = new ProxyService({ file, backend: quiet });
	t.after(() => again.dispose());
	await again.init();
	assert.match((await again.status()).error!, /Add an API key first/);
	await again.saveKey(undefined, "Tests", key);
	assert.equal((await call("/v1/models")).status, 200);
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
	// Where a key is required and there is none, nobody could connect, so it doesn't turn on.
	const [only] = (await taken.status()).keys;
	await taken.removeKey(only!.id);
	await assert.rejects(taken.setEnabled(true), /Add an API key first/);

	const port = await freePort();
	const moved = await proxy.saveOptions({ ...(await proxy.status()), port });
	assert.deepEqual([moved.running, moved.port, moved.addresses], [true, port, []]);
	await assert.rejects(fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${key}` } }));
	assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
	assert.deepEqual((await proxy.saveOptions({ ...moved, lan: true })).addresses, ["192.168.1.20", "100.101.102.103"]);

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
