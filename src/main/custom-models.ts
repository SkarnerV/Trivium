import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomApi, CustomModel, CustomProvider } from "../shared/protocol.ts";

type Json = Record<string, unknown>;

export const CUSTOM_APIS: readonly CustomApi[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/**
 * pi only offers a provider's models once it has a key, so an endpoint without auth, such as a local Ollama,
 * gets this one. Trivium shows it as no key.
 */
const NO_KEY = "none";

const FETCH_TIMEOUT_MS = 15_000;
/** Local servers are asked about each model; past this many, the rest keep pi's defaults. */
const DETAIL_LIMIT = 60;

export const modelsPath = (agentDir: string): string => join(agentDir, "models.json");

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()) : undefined;
const num = (...values: unknown[]): number | undefined =>
	values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
const format = (config: unknown) => `${JSON.stringify(config, null, "\t")}\n`;

let builtIn: Set<string> | undefined;
const isBuiltIn = (id: string) => (builtIn ??= new Set(builtinProviders().map((provider) => provider.id))).has(id);

function readConfig(path: string): Json {
	if (!existsSync(path)) return {};
	try {
		return obj(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(`${path} isn't plain JSON, so Trivium won't rewrite it. Edit it directly.`);
	}
}

/** The endpoints in models.json that Trivium can edit: added providers on one of the APIs it offers. */
export function readCustomProviders(agentDir: string): CustomProvider[] {
	let config: Json;
	try {
		config = readConfig(modelsPath(agentDir));
	} catch {
		return [];
	}
	return Object.entries(obj(config.providers)).flatMap(([id, value]) => {
		const entry = obj(value);
		const api = entry.api as CustomApi;
		if (isBuiltIn(id) || !str(entry.baseUrl) || !CUSTOM_APIS.includes(api)) return [];
		const models = (Array.isArray(entry.models) ? entry.models : []).map(obj).flatMap((model): CustomModel[] => {
			const modelId = str(model.id);
			if (!modelId) return [];
			return [
				{
					id: modelId,
					name: str(model.name),
					contextWindow: num(model.contextWindow),
					maxTokens: num(model.maxTokens),
					images: strings(model.input)?.includes("image") ?? false,
					reasoning: model.reasoning === true,
				},
			];
		});
		const apiKey = typeof entry.apiKey === "string" && entry.apiKey !== NO_KEY ? entry.apiKey : "";
		return [{ id, name: str(entry.name) ?? id, baseUrl: entry.baseUrl as string, api, apiKey, models }];
	});
}

function validate(provider: CustomProvider): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider.id)) throw new Error("The ID can use letters, digits, dots, dashes and underscores.");
	if (isBuiltIn(provider.id)) throw new Error(`“${provider.id}” is one of pi's own providers. Choose another ID.`);
	if (!CUSTOM_APIS.includes(provider.api)) throw new Error(`Unknown API: ${provider.api}`);
	let url: URL;
	try {
		url = new URL(provider.baseUrl);
	} catch {
		throw new Error("The base URL isn't a valid URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The base URL must start with http:// or https://.");
	const seen = new Set<string>();
	for (const model of provider.models) {
		if (!model.id.trim()) throw new Error("Every model needs an ID.");
		if (seen.has(model.id)) throw new Error(`${model.id} is listed twice.`);
		seen.add(model.id);
	}
}

/** A models.json entry for a model, keeping fields Trivium doesn't edit, such as cost or compat. */
function modelEntry(model: CustomModel, previous: Json): Json {
	return {
		...previous,
		id: model.id,
		name: model.name?.trim() || undefined,
		reasoning: model.reasoning || undefined,
		input: model.images ? ["text", "image"] : undefined,
		contextWindow: num(model.contextWindow),
		maxTokens: num(model.maxTokens),
	};
}

async function writeConfig(path: string, config: Json): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(`${path}.tmp`, format(config));
	await rename(`${path}.tmp`, path);
}

/**
 * Adds or replaces a provider in models.json, keeping everything else in the file and the fields Trivium
 * doesn't edit, such as headers and compat. `previousId` is the provider's ID before a rename.
 */
export async function saveCustomProvider(agentDir: string, provider: CustomProvider, previousId?: string): Promise<void> {
	validate(provider);
	const path = modelsPath(agentDir);
	const config = readConfig(path);
	const providers = { ...obj(config.providers) };
	if (provider.id !== previousId && provider.id in providers) throw new Error(`models.json already has a provider called “${provider.id}”.`);
	const previous = obj(providers[previousId ?? provider.id]);
	if (previousId) delete providers[previousId];
	const previousModels = new Map(
		(Array.isArray(previous.models) ? previous.models : []).map(obj).map((model) => [model.id, model] as const),
	);
	providers[provider.id] = {
		...previous,
		name: provider.name.trim() || provider.id,
		baseUrl: provider.baseUrl.trim().replace(/\/+$/, ""),
		api: provider.api,
		apiKey: provider.apiKey.trim() || NO_KEY,
		models: provider.models.map((model) => modelEntry(model, obj(previousModels.get(model.id)))),
	};
	await writeConfig(path, { ...config, providers });
}

export async function removeCustomProvider(agentDir: string, id: string): Promise<void> {
	const path = modelsPath(agentDir);
	const config = readConfig(path);
	const providers = { ...obj(config.providers) };
	if (!(id in providers)) return;
	delete providers[id];
	await writeConfig(path, { ...config, providers });
}

/** The key as pi would resolve it: literal, $NAME or ${NAME} from the environment, or !command's output. */
export async function resolveKey(apiKey: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const key = apiKey.trim();
	if (!key || key === NO_KEY) return "";
	if (key.startsWith("!")) {
		const { stdout } = await promisify(exec)(key.slice(1), { timeout: 10_000, windowsHide: true });
		return stdout.trim();
	}
	return key.replace(/\$\$|\$\{(\w+)\}|\$(\w+)/g, (match, braced?: string, bare?: string) =>
		match === "$$" ? "$" : (env[braced ?? bare ?? ""] ?? ""),
	);
}

/** Where an API lists its models, and the headers that authenticate the request. */
export function listRequest(api: CustomApi, baseUrl: string, key: string): { url: string; headers: Record<string, string> } {
	const base = baseUrl.trim().replace(/\/+$/, "");
	switch (api) {
		case "anthropic-messages":
			// pi's Anthropic base URL stops before /v1, which the SDK adds.
			return {
				url: `${/\/v1$/.test(base) ? base : `${base}/v1`}/models?limit=1000`,
				headers: { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
			};
		case "google-generative-ai":
			return { url: `${base}/models?pageSize=1000`, headers: key ? { "x-goog-api-key": key } : {} };
		default:
			return { url: `${base}/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
	}
}

/**
 * Reads a model listing. Endpoints describe models in their own words: OpenRouter's context_length and
 * architecture, Anthropic's display_name and max_input_tokens, Gemini's inputTokenLimit, vLLM's max_model_len.
 * Whatever a listing leaves out stays unset, for pi's defaults or the user to fill in.
 */
export function parseListing(api: CustomApi, body: unknown): CustomModel[] {
	const root = obj(body);
	const entries = [root.data, root.models, body].find(Array.isArray) ?? [];
	const models = entries.map(obj).flatMap((entry): CustomModel[] => {
		const id = (str(entry.id) ?? str(entry.name))?.replace(/^models\//, "");
		if (!id) return [];
		// Gemini lists embedding and other models too; only those that chat are any use here.
		const methods = strings(entry.supportedGenerationMethods);
		if (methods && !methods.includes("generatecontent")) return [];
		const top = obj(entry.top_provider);
		const architecture = obj(entry.architecture);
		const capabilities = obj(entry.capabilities);
		const inputs =
			strings(architecture.input_modalities) ?? strings(entry.input_modalities) ?? strings(obj(entry.modalities).input) ?? strings(entry.modalities);
		const parameters = strings(entry.supported_parameters);
		const name = str(entry.display_name) ?? str(entry.displayName) ?? (str(entry.id) && entry.name !== entry.id ? str(entry.name) : undefined);
		return [
			{
				id,
				name,
				contextWindow: num(
					entry.context_length,
					top.context_length,
					entry.context_window,
					entry.max_context_length,
					entry.max_model_len,
					entry.max_input_tokens,
					entry.inputTokenLimit,
				),
				maxTokens: num(top.max_completion_tokens, entry.max_output_tokens, entry.max_completion_tokens, entry.outputTokenLimit, entry.max_tokens),
				// Every Claude and Gemini chat model reads images; other APIs have to say so.
				images:
					inputs?.includes("image") ??
					(capabilities.vision === true ||
						obj(capabilities.image_input).supported === true ||
						entry.type === "vlm" ||
						api === "anthropic-messages" ||
						api === "google-generative-ai"),
				reasoning:
					parameters?.some((parameter) => parameter === "reasoning" || parameter === "include_reasoning") ??
					(entry.thinking === true || capabilities.reasoning === true || obj(capabilities.thinking).supported === true),
			},
		];
	});
	return [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) {
		const text = (await response.text().catch(() => "")).trim().slice(0, 300);
		throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
	}
	return response.json();
}

/**
 * The OpenAI-style /v1/models of Ollama and LM Studio lists only IDs. Their own APIs, beside /v1, say how
 * much context each model takes and whether it sees images or thinks; anything else simply doesn't answer.
 */
async function describeLocal(baseUrl: string, models: CustomModel[], headers: Record<string, string>): Promise<CustomModel[]> {
	const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
	if (root === baseUrl.trim().replace(/\/+$/, "") || models.some((model) => model.contextWindow)) return models;
	try {
		const studio = parseListing("openai-completions", await getJson(`${root}/api/v0/models`, { headers }));
		const byId = new Map(studio.map((model) => [model.id, model]));
		if (studio.length) return models.map((model) => ({ ...model, ...byId.get(model.id), name: model.name }));
	} catch {
		// Not LM Studio.
	}
	const described = await Promise.all(
		models.slice(0, DETAIL_LIMIT).map(async (model) => {
			try {
				const show = obj(
					await getJson(`${root}/api/show`, {
						method: "POST",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify({ model: model.id }),
					}),
				);
				const info = obj(show.model_info);
				const capabilities = strings(show.capabilities) ?? [];
				const context = Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1];
				return {
					...model,
					contextWindow: num(context) ?? model.contextWindow,
					images: model.images || capabilities.includes("vision"),
					reasoning: model.reasoning || capabilities.includes("thinking"),
				};
			} catch {
				return model;
			}
		}),
	);
	return [...described, ...models.slice(DETAIL_LIMIT)];
}

/** Asks an endpoint which models it serves. */
export async function fetchModels(endpoint: Pick<CustomProvider, "baseUrl" | "api" | "apiKey">): Promise<CustomModel[]> {
	try {
		new URL(endpoint.baseUrl);
	} catch {
		throw new Error("Enter the endpoint's base URL first.");
	}
	const key = await resolveKey(endpoint.apiKey);
	const { url, headers } = listRequest(endpoint.api, endpoint.baseUrl, key);
	let body: unknown;
	try {
		body = await getJson(url, { headers });
	} catch (error) {
		const message = error instanceof Error ? (error.name === "TimeoutError" ? "no answer in 15 seconds" : error.message) : String(error);
		throw new Error(`Couldn't list models from ${url}: ${message}`);
	}
	const models = parseListing(endpoint.api, body);
	if (!models.length) throw new Error(`${url} answered, but listed no models.`);
	return endpoint.api === "openai-completions" || endpoint.api === "openai-responses"
		? describeLocal(endpoint.baseUrl, models, headers)
		: models;
}
