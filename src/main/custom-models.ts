import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomApi, CustomModel, CustomProvider, PresetProvider, PresetProviderChanges } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";

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

let catalog: Map<string, Provider> | undefined;
const catalogProvider = (id: string) => (catalog ??= new Map(builtinProviders().map((provider) => [provider.id, provider]))).get(id);
export const isBuiltIn = (id: string) => catalogProvider(id) !== undefined;

function readConfig(path: string): Json {
	if (!existsSync(path)) return {};
	try {
		return obj(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(t("{path} isn't plain JSON, so Trivium won't rewrite it. Edit it directly.", { path }));
	}
}

/** A models.json `models` list as written, leaving out what pi fills in. */
function readModels(models: unknown): CustomModel[] {
	return (Array.isArray(models) ? models : []).map(obj).flatMap((model): CustomModel[] => {
		const id = str(model.id);
		if (!id) return [];
		return [
			{
				id,
				name: str(model.name),
				contextWindow: num(model.contextWindow),
				maxTokens: num(model.maxTokens),
				images: strings(model.input)?.includes("image") ?? false,
				reasoning: model.reasoning === true,
			},
		];
	});
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
		const models = readModels(entry.models);
		const apiKey = typeof entry.apiKey === "string" && entry.apiKey !== NO_KEY ? entry.apiKey : "";
		return [{ id, name: str(entry.name) ?? id, baseUrl: entry.baseUrl as string, api, apiKey, models }];
	});
}

function validate(provider: CustomProvider): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider.id)) throw new Error("The ID can use letters, digits, dots, dashes and underscores.");
	if (isBuiltIn(provider.id)) throw new Error(t("“{id}” is one of pi's own providers. Choose another ID.", { id: provider.id }));
	if (!CUSTOM_APIS.includes(provider.api)) throw new Error(`Unknown API: ${provider.api}`);
	validateUrl(provider.baseUrl);
	validateModels(provider.models);
}

function validateUrl(baseUrl: string): void {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error(t("The base URL isn't a valid URL."));
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(t("The base URL must start with http:// or https://."));
}

function validateModels(models: CustomModel[]): void {
	const seen = new Set<string>();
	for (const model of models) {
		if (!model.id.trim()) throw new Error(t("Every model needs an ID."));
		if (seen.has(model.id)) throw new Error(t("{id} is listed twice.", { id: model.id }));
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

const modelsById = (models: unknown) => new Map((Array.isArray(models) ? models : []).map(obj).map((model) => [model.id, model] as const));

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
	if (provider.id !== previousId && provider.id in providers) throw new Error(t("models.json already has a provider called “{id}”.", { id: provider.id }));
	const previous = obj(providers[previousId ?? provider.id]);
	if (previousId) delete providers[previousId];
	const previousModels = modelsById(previous.models);
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

/** The model details Trivium edits, as models.json names them. */
const EDITED_KEYS = ["name", "contextWindow", "maxTokens", "input", "reasoning"];

const describeModel = (model: Model<Api>): CustomModel => ({
	id: model.id,
	name: model.name !== model.id ? model.name : undefined,
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
	images: model.input.includes("image"),
	reasoning: model.reasoning,
});

/** The API most of the provider's models speak, which models added to it speak too. */
function mainApi(models: readonly Model<Api>[]): string | undefined {
	const counts = new Map<string, number>();
	for (const model of models) counts.set(model.api, (counts.get(model.api) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** A built-in provider's models as pi offers them now, split into its catalog's and those models.json adds. */
export function readPresetProvider(agentDir: string, runtime: ModelRuntime, id: string): PresetProvider & { mainApi?: string } {
	const base = catalogProvider(id);
	const provider = runtime.getProvider(id);
	if (!base || !provider) throw new Error(t("{id} isn't one of pi's own providers.", { id }));
	const entry = obj(obj(readConfig(modelsPath(agentDir)).providers)[id]);
	const added = modelsById(entry.models);
	const overrides = obj(entry.modelOverrides);
	const models = runtime.getModels(id);
	const builtIn = models.filter((model) => !added.has(model.id));
	const api = mainApi(builtIn);
	return {
		id,
		name: provider.name,
		defaultBaseUrl: base.baseUrl ?? base.getModels()[0]?.baseUrl ?? "",
		baseUrl: str(entry.baseUrl) ?? "",
		api: CUSTOM_APIS.includes(api as CustomApi) ? (api as CustomApi) : undefined,
		mainApi: api,
		builtIn: builtIn.map((model) => ({
			...describeModel(model),
			edited: EDITED_KEYS.some((key) => key in obj(overrides[model.id])),
		})),
		added: readModels(entry.models),
	};
}

/** Asks a built-in provider which models it serves, with the credentials pi resolves for it. */
export async function fetchPresetModels(agentDir: string, runtime: ModelRuntime, id: string, baseUrl: string): Promise<CustomModel[]> {
	const preset = readPresetProvider(agentDir, runtime, id);
	if (!preset.api) throw new Error(t("Trivium can't ask {name} for its models. Add them by ID instead.", { name: preset.name }));
	const result = await runtime.getAuth(id);
	if (!result) throw new Error(t("Log in to {name} first.", { name: preset.name }));
	const headers = Object.fromEntries(
		Object.entries(result.auth.headers ?? {}).filter((header): header is [string, string] => header[1] !== null),
	);
	return fetchModels(
		{ baseUrl: baseUrl.trim() || result.auth.baseUrl || preset.defaultBaseUrl, api: preset.api, apiKey: "" },
		{ key: result.auth.apiKey ?? "", headers },
	);
}

/**
 * Writes a built-in provider's base URL, model changes and added models to models.json. Catalog models change
 * through modelOverrides, field by field, so pi's later catalog updates still reach the rest of each model.
 */
export async function savePresetProvider(agentDir: string, runtime: ModelRuntime, id: string, changes: PresetProviderChanges): Promise<void> {
	const preset = readPresetProvider(agentDir, runtime, id);
	const baseUrl = changes.baseUrl.trim().replace(/\/+$/, "");
	if (baseUrl) validateUrl(baseUrl);
	validateModels(changes.added);
	const catalogIds = new Set(preset.builtIn.map((model) => model.id));
	const taken = changes.added.find((model) => catalogIds.has(model.id));
	if (taken) throw new Error(t("{id} is one of {name}'s own models already.", { id: taken.id, name: preset.name }));

	const path = modelsPath(agentDir);
	const config = readConfig(path);
	const providers = { ...obj(config.providers) };
	const previous = obj(providers[id]);
	const previousModels = modelsById(previous.models);
	const overrides = { ...obj(previous.modelOverrides) };
	for (const edit of changes.edits) {
		if (!catalogIds.has(edit.id)) continue;
		const override = { ...obj(overrides[edit.id]) };
		if (edit.reset) for (const key of EDITED_KEYS) delete override[key];
		const set = (key: string, value: unknown) => {
			if (value === undefined) delete override[key];
			else override[key] = value;
		};
		const { name, contextWindow, maxTokens, images, reasoning } = edit.fields;
		if (name !== undefined) set("name", name?.trim() || undefined);
		if (contextWindow !== undefined) set("contextWindow", num(contextWindow));
		if (maxTokens !== undefined) set("maxTokens", num(maxTokens));
		if (images !== undefined) set("input", images === null ? undefined : images ? ["text", "image"] : ["text"]);
		if (reasoning !== undefined) set("reasoning", reasoning ?? undefined);
		if (Object.keys(override).length) overrides[edit.id] = override;
		else delete overrides[edit.id];
	}
	const entry = Object.fromEntries(
		Object.entries({
			...previous,
			baseUrl: baseUrl || undefined,
			models: changes.added.length
				? changes.added.map((model) => modelEntry(model, { api: preset.mainApi, ...obj(previousModels.get(model.id)) }))
				: undefined,
			modelOverrides: Object.keys(overrides).length ? overrides : undefined,
		}).filter(([, value]) => value !== undefined),
	);
	// pi rejects an entry for a built-in provider that changes nothing.
	if (Object.keys(entry).length) providers[id] = entry;
	else delete providers[id];
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
 * architecture, Anthropic's display_name and max_input_tokens, Gemini's inputTokenLimit, vLLM's max_model_len,
 * and OpenAI, for a ChatGPT plan login, a `models` list keyed by slug.
 * Whatever a listing leaves out stays unset, for pi's defaults or the user to fill in.
 */
export function parseListing(api: CustomApi, body: unknown): CustomModel[] {
	const root = obj(body);
	const entries = [root.data, root.models, body].find(Array.isArray) ?? [];
	const models = entries.map(obj).flatMap((entry): CustomModel[] => {
		const id = (str(entry.id) ?? str(entry.name) ?? str(entry.slug))?.replace(/^models\//, "");
		// A ChatGPT plan lists models it keeps out of its own model picker too.
		if (!id || entry.visibility === "hide") return [];
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
					(entry.thinking === true ||
						capabilities.reasoning === true ||
						obj(capabilities.thinking).supported === true ||
						(Array.isArray(entry.supported_reasoning_levels) && entry.supported_reasoning_levels.length > 0)),
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

/**
 * Asks an endpoint which models it serves. `auth` holds a hosted provider's resolved key and headers, used
 * in place of the endpoint's own key.
 */
export async function fetchModels(
	endpoint: Pick<CustomProvider, "baseUrl" | "api" | "apiKey">,
	auth?: { key: string; headers: Record<string, string> },
): Promise<CustomModel[]> {
	try {
		new URL(endpoint.baseUrl);
	} catch {
		throw new Error(t("Enter the endpoint's base URL first."));
	}
	const key = auth ? auth.key : await resolveKey(endpoint.apiKey);
	const request = listRequest(endpoint.api, endpoint.baseUrl, key);
	const { url } = request;
	const headers = { ...auth?.headers, ...request.headers };
	let body: unknown;
	try {
		body = await getJson(url, { headers });
	} catch (error) {
		const message = error instanceof Error ? (error.name === "TimeoutError" ? "no answer in 15 seconds" : error.message) : String(error);
		throw new Error(t("Couldn't list models from {url}: {error}", { url, error: message }));
	}
	const models = parseListing(endpoint.api, body);
	if (!models.length) throw new Error(t("{url} answered, but listed no models.", { url }));
	// Only a local server has the APIs beside /v1 that describe its models.
	return !auth && (endpoint.api === "openai-completions" || endpoint.api === "openai-responses")
		? describeLocal(endpoint.baseUrl, models, headers)
		: models;
}
