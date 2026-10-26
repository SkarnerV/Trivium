import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	listRequest,
	parseListing,
	readCustomProviders,
	removeCustomProvider,
	resolveKey,
	saveCustomProvider,
} from "../src/main/custom-models.ts";
import type { CustomProvider } from "../src/shared/protocol.ts";

const ollama: CustomProvider = {
	id: "ollama",
	name: "Ollama",
	baseUrl: "http://localhost:11434/v1/",
	api: "openai-completions",
	apiKey: "",
	models: [{ id: "qwen3:8b", contextWindow: 40960, images: false, reasoning: true }],
};

test("listings: OpenRouter, Anthropic and Gemini describe limits and abilities in their own fields", () => {
	assert.deepEqual(
		parseListing("openai-completions", {
			data: [
				{
					id: "z/vision",
					name: "Z Vision",
					context_length: 200000,
					top_provider: { max_completion_tokens: 32000 },
					architecture: { input_modalities: ["text", "image"] },
					supported_parameters: ["tools", "reasoning"],
				},
				{ id: "a/plain", object: "model", owned_by: "library" },
			],
		}),
		[
			{ id: "a/plain", name: undefined, contextWindow: undefined, maxTokens: undefined, images: false, reasoning: false },
			{ id: "z/vision", name: "Z Vision", contextWindow: 200000, maxTokens: 32000, images: true, reasoning: true },
		],
	);
	assert.deepEqual(parseListing("anthropic-messages", { data: [{ id: "claude-x", display_name: "Claude X", max_input_tokens: 1000000, max_tokens: 64000 }] }), [
		{ id: "claude-x", name: "Claude X", contextWindow: 1000000, maxTokens: 64000, images: true, reasoning: false },
	]);
	const gemini = parseListing("google-generative-ai", {
		models: [
			{ name: "models/gemini-x", displayName: "Gemini X", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"], thinking: true },
			{ name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
		],
	});
	assert.deepEqual(gemini, [{ id: "gemini-x", name: "Gemini X", contextWindow: 1048576, maxTokens: 65536, images: true, reasoning: true }]);
});

test("model lists are requested where each API keeps them, with its own auth header", () => {
	assert.deepEqual(listRequest("openai-completions", "http://localhost:11434/v1/", "k"), {
		url: "http://localhost:11434/v1/models",
		headers: { authorization: "Bearer k" },
	});
	assert.equal(listRequest("anthropic-messages", "https://api.anthropic.com", "k").url, "https://api.anthropic.com/v1/models?limit=1000");
	assert.equal(listRequest("anthropic-messages", "https://proxy.example/v1", "").headers["x-api-key"], undefined);
	assert.deepEqual(listRequest("google-generative-ai", "https://generativelanguage.googleapis.com/v1beta", "k").headers, { "x-goog-api-key": "k" });
});

test("keys resolve like pi resolves them", async () => {
	assert.equal(await resolveKey("$TEST_KEY", { TEST_KEY: "abc" }), "abc");
	assert.equal(await resolveKey("pre-${TEST_KEY}-$$", { TEST_KEY: "abc" }), "pre-abc-$");
	assert.equal(await resolveKey("none"), "");
	assert.equal(await resolveKey("!echo from-command"), "from-command");
});

test("custom providers round-trip through models.json, keeping what Trivium doesn't edit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "trivium-models-"));
	const file = join(dir, "models.json");
	await writeFile(
		file,
		JSON.stringify({
			providers: {
				anthropic: { baseUrl: "https://proxy.example" },
				ollama: { headers: { "x-team": "a" }, models: [{ id: "qwen3:8b", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
			},
		}),
	);
	await saveCustomProvider(dir, ollama, "ollama");
	const written = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(written.providers.anthropic, { baseUrl: "https://proxy.example" });
	assert.deepEqual(written.providers.ollama, {
		headers: { "x-team": "a" },
		name: "Ollama",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		apiKey: "none",
		models: [{ id: "qwen3:8b", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: true, contextWindow: 40960 }],
	});
	// The proxy override of a built-in provider isn't a custom provider.
	assert.deepEqual(readCustomProviders(dir), [{ ...ollama, baseUrl: "http://localhost:11434/v1", models: [{ ...ollama.models[0], name: undefined, maxTokens: undefined }] }]);

	await saveCustomProvider(dir, { ...ollama, id: "local", models: [{ id: "llava", images: true, reasoning: false }] }, "ollama");
	assert.deepEqual(readCustomProviders(dir).map((provider) => [provider.id, provider.models[0]?.images]), [["local", true]]);
	await assert.rejects(saveCustomProvider(dir, { ...ollama, id: "anthropic" }), /pi's own providers/);
	await assert.rejects(saveCustomProvider(dir, { ...ollama, id: "local" }), /already has a provider/);
	await removeCustomProvider(dir, "local");
	assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8")).providers), ["anthropic"]);
});
