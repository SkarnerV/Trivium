import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProxyAlias, ProxyKeyInfo, ProxyOptions, ProxyStatus } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import {
	anthropicResponse,
	anthropicStream,
	estimateTokens,
	fromAnthropic,
	fromOpenAI,
	openAIResponse,
	openAIStream,
	ProxyError,
	type StreamEncoder,
	upstreamError,
} from "./proxy-protocol.ts";

type Json = Record<string, unknown>;

/** What the proxy needs of pi: the models to offer, and a reply from one of them. */
export interface ProxyBackend {
	models(): Promise<readonly Model<Api>[]>;
	stream(model: Model<Api>, context: Context, options: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent>;
}

/** A key as saved: its SHA-256 digest, never the key itself. */
interface StoredKey extends ProxyKeyInfo {
	digest: string;
}

interface Saved extends ProxyOptions {
	enabled: boolean;
	keys: StoredKey[];
	aliases: ProxyAlias[];
}

const DEFAULTS: Saved = { enabled: false, port: 8787, openai: true, anthropic: true, lan: false, keys: [], aliases: [] };

const MAX_BODY = 32_000_000;
const MAX_KEYS = 100;
/** A quiet stream gets a line this often, so nothing between the client and the proxy gives up on it. */
const PING_MS = 15_000;
/** How long after a request a key's last use is written down, so a busy client doesn't write the file per request. */
const USED_FLUSH_MS = 3000;

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});

/* Keys */

export const generateKey = (): string => `trv-${randomBytes(32).toString("base64url")}`;

const digestOf = (key: string): string => createHash("sha256").update(key).digest("hex");

function validateKey(value: string): string {
	if (!/^[A-Za-z0-9._~-]{16,256}$/.test(value)) throw new Error(t("A key is 16 to 256 letters, digits, dots, dashes, underscores or tildes."));
	return value;
}

function validateName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 80 || /[\u0000-\u001f]/.test(trimmed)) throw new Error(t("Give the key a name of up to 80 characters."));
	return trimmed;
}

/* Models */

const keyOf = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

/** The model a client means: an alias, a provider/id, or an ID only one provider offers. */
export function resolveModel(name: string, models: readonly Model<Api>[], aliases: readonly ProxyAlias[]): Model<Api> {
	const target = aliases.find((entry) => entry.alias === name)?.model ?? name;
	const exact = models.find((model) => keyOf(model) === target);
	if (exact) return exact;
	const byId = models.filter((model) => model.id === target);
	if (byId.length === 1) return byId[0]!;
	if (byId.length > 1) {
		throw new ProxyError(400, `Several providers offer "${target}". Ask for it as provider/id, such as "${keyOf(byId[0]!)}".`);
	}
	throw new ProxyError(404, `No model called "${name}" is on offer. GET /v1/models lists the ones that are.`, "not_found_error");
}

function validateAliases(aliases: ProxyAlias[]): ProxyAlias[] {
	const seen = new Set<string>();
	return aliases.map((entry) => {
		const alias = String(entry.alias ?? "").trim();
		const model = String(entry.model ?? "").trim();
		if (!alias || alias.length > 200 || /\s/.test(alias)) throw new Error(t("A model name is up to 200 characters, without spaces."));
		if (!model) throw new Error(t("Choose the model {alias} stands for.", { alias }));
		if (seen.has(alias)) throw new Error(t("{id} is listed twice.", { id: alias }));
		seen.add(alias);
		return { alias, model };
	});
}

/* Addresses */

const VIRTUAL = /^(docker|veth|virbr|br-|tun|tap|utun|tailscale|wg|zt|vethernet|vmware|virtualbox|vboxnet|hyper-v|loopback)/i;

/**
 * This computer's IPv4 addresses on its networks, with real network cards before the adapters of Docker, VPNs
 * and virtual machines. Read from the system; nothing is sent anywhere.
 */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
	const found: { address: string; virtual: boolean }[] = [];
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.") || entry.address === "0.0.0.0") continue;
			if (!found.some((item) => item.address === entry.address)) found.push({ address: entry.address, virtual: VIRTUAL.test(name) });
		}
	}
	return found.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((item) => item.address);
}

function isPrivateAddress(host: string): boolean {
	if (isIP(host) !== 4) return false;
	const [a, b] = host.split(".").map(Number) as [number, number];
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A web page may call the proxy when it is served from this computer or, with the network allowed, from that network. */
function originAllowed(origin: string, lan: boolean): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const host = url.hostname.replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || (lan && isPrivateAddress(host));
}

/* HTTP */

const ERROR_KINDS: Record<number, string> = {
	401: "authentication_error",
	403: "permission_error",
	404: "not_found_error",
	413: "request_too_large",
	429: "rate_limit_error",
};

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new ProxyError(413, "The request is larger than 32 MB.", "request_too_large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

/**
 * A local server that answers OpenAI Chat Completions and Anthropic Messages requests with the models set up in
 * Trivium, so other apps can use them. It listens on this computer only unless the network is allowed, and
 * every request needs one of its own keys: the providers' credentials stay with pi.
 */
export class ProxyService {
	private saved: Saved;
	private server: Server | undefined;
	private error: string | undefined;
	private saving = Promise.resolve();
	private usedTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly file: string;
	private readonly backend: ProxyBackend;
	private readonly emit: (status: ProxyStatus) => void;
	private readonly addresses: () => string[];

	constructor(options: { file: string; backend: ProxyBackend; emit?: (status: ProxyStatus) => void; addresses?: () => string[] }) {
		this.file = options.file;
		this.backend = options.backend;
		this.emit = options.emit ?? (() => {});
		this.addresses = options.addresses ?? lanAddresses;
		this.saved = structuredClone(DEFAULTS);
		if (!existsSync(this.file)) return;
		try {
			const saved = obj(JSON.parse(readFileSync(this.file, "utf8"))) as Partial<Saved>;
			this.saved = {
				...this.saved,
				...saved,
				keys: Array.isArray(saved.keys) ? saved.keys.filter((key) => key && typeof key.digest === "string" && typeof key.id === "string") : [],
				aliases: Array.isArray(saved.aliases) ? saved.aliases.filter((entry) => entry && typeof entry.alias === "string" && typeof entry.model === "string") : [],
			};
		} catch {
			// A damaged file starts over with no keys, which lets nobody in.
		}
	}

	/** Starts the proxy if it was on when Trivium last ran. */
	async init(): Promise<void> {
		if (!this.saved.enabled) return;
		try {
			await this.listen();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	/** The port it listens on now, which differs from the saved one only when that is 0. */
	get port(): number | undefined {
		const address = this.server?.address();
		return address && typeof address === "object" ? address.port : undefined;
	}

	async status(): Promise<ProxyStatus> {
		const { keys, ...rest } = this.saved;
		let models = 0;
		try {
			models = (await this.backend.models()).length;
		} catch {
			// The page still shows the rest.
		}
		return {
			...rest,
			aliases: rest.aliases.map((entry) => ({ ...entry })),
			running: Boolean(this.server),
			error: this.error,
			keys: keys.map(({ digest: _digest, ...key }) => key),
			addresses: this.saved.lan ? this.addresses() : [],
			models,
		};
	}

	async setEnabled(on: boolean): Promise<ProxyStatus> {
		if (on && !this.server) {
			if (!this.saved.keys.some((key) => key.enabled)) throw new Error(t("Add an API key first. Clients need one to connect."));
			this.error = undefined;
			await this.listen();
		} else if (!on) {
			await this.close();
			this.error = undefined;
		}
		this.saved.enabled = on;
		return this.changed();
	}

	async saveOptions(options: ProxyOptions): Promise<ProxyStatus> {
		const port = Number(options.port);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(t("Choose a port from 1024 to 65535."));
		if (!options.openai && !options.anthropic) throw new Error(t("Keep at least one format on."));
		const previous: ProxyOptions = { port: this.saved.port, openai: this.saved.openai, anthropic: this.saved.anthropic, lan: this.saved.lan };
		const next: ProxyOptions = { port, openai: Boolean(options.openai), anthropic: Boolean(options.anthropic), lan: Boolean(options.lan) };
		Object.assign(this.saved, next);
		// Formats apply to the next request; a new port or reach needs a new socket.
		if (this.server && (previous.port !== next.port || previous.lan !== next.lan)) {
			await this.close();
			try {
				await this.listen();
			} catch (error) {
				Object.assign(this.saved, previous);
				// The proxy goes back to where it listened, so clients set up for it keep working.
				await this.listen().catch((restoreError: unknown) => {
					this.error = restoreError instanceof Error ? restoreError.message : String(restoreError);
				});
				await this.changed();
				throw error;
			}
		} else if (this.saved.enabled && !this.server) {
			// It was on but couldn't start, such as on a port in use. The new settings may let it.
			try {
				await this.listen();
				this.error = undefined;
			} catch (error) {
				this.error = error instanceof Error ? error.message : String(error);
			}
		}
		return this.changed();
	}

	async saveKey(id: string | undefined, name: string, value: string): Promise<{ status: ProxyStatus; key?: string }> {
		const existing = id ? this.saved.keys.find((key) => key.id === id) : undefined;
		if (id && !existing) throw new Error(t("That key is gone."));
		if (!existing && this.saved.keys.length >= MAX_KEYS) throw new Error(t("The proxy keeps up to {n} keys. Remove one first.", { n: MAX_KEYS }));
		const label = validateName(name);
		// A new key always has a value; an existing one changes only when given a new value.
		const fresh = value.trim() ? validateKey(value.trim()) : existing ? undefined : generateKey();
		const digest = fresh ? digestOf(fresh) : existing!.digest;
		const others = this.saved.keys.filter((key) => key !== existing);
		if (others.some((key) => key.name === label)) throw new Error(t("Another key is called “{name}” already.", { name: label }));
		if (others.some((key) => key.digest === digest)) throw new Error(t("Another key has this value already."));
		const hint = fresh ? `…${fresh.slice(-4)}` : existing!.hint;
		if (existing) Object.assign(existing, { name: label, digest, hint });
		else this.saved.keys.push({ id: randomUUID(), name: label, digest, hint, enabled: true, createdAt: Date.now() });
		return { status: await this.changed(), key: fresh };
	}

	async setKeyEnabled(id: string, enabled: boolean): Promise<ProxyStatus> {
		const key = this.saved.keys.find((entry) => entry.id === id);
		if (!key) throw new Error(t("That key is gone."));
		key.enabled = Boolean(enabled);
		return this.changed();
	}

	async removeKey(id: string): Promise<ProxyStatus> {
		this.saved.keys = this.saved.keys.filter((key) => key.id !== id);
		return this.changed();
	}

	async saveAliases(aliases: ProxyAlias[]): Promise<ProxyStatus> {
		this.saved.aliases = validateAliases(Array.isArray(aliases) ? aliases : []);
		return this.changed();
	}

	/** Stops listening and drops open connections. Synchronous, for use while quitting. */
	dispose(): void {
		clearTimeout(this.usedTimer);
		this.server?.close();
		this.server?.closeAllConnections();
		this.server = undefined;
	}

	private async changed(): Promise<ProxyStatus> {
		await this.save();
		const status = await this.status();
		this.emit(status);
		return status;
	}

	private save(): Promise<void> {
		const contents = JSON.stringify(this.saved, null, 2);
		this.saving = this.saving
			.catch(() => {})
			.then(async () => {
				await writeFile(`${this.file}.tmp`, contents, { mode: 0o600 });
				await rename(`${this.file}.tmp`, this.file);
			});
		return this.saving;
	}

	private listen(): Promise<void> {
		const { port, lan } = this.saved;
		return new Promise((resolve, reject) => {
			const server = createServer((request, response) => void this.handle(request, response));
			server.once("error", (error: NodeJS.ErrnoException) => {
				reject(
					new Error(
						error.code === "EADDRINUSE"
							? t("Port {port} is in use by another app. Choose another port.", { port })
							: t("The proxy couldn't listen on port {port}: {error}", { port, error: error.message }),
					),
				);
			});
			// 0.0.0.0 is every IPv4 network this computer is on; clients still reach it by one of its addresses.
			server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
				this.server = server;
				resolve();
			});
		});
	}

	private close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return Promise.resolve();
		return new Promise((resolve) => {
			server.close(() => resolve());
			// Requests in flight end here; a client sees its stream cut.
			server.closeAllConnections();
		});
	}

	/** Whether the request carries one of the keys that are on. Notes when the key was used. */
	private authorized(request: IncomingMessage): boolean {
		const bearer = request.headers.authorization;
		const header = request.headers["x-api-key"];
		const supplied = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : typeof header === "string" ? header.trim() : "";
		if (!supplied || supplied.length > 256) return false;
		const digest = createHash("sha256").update(supplied).digest();
		// Every key is compared, so the time taken doesn't say which one came close.
		let match: StoredKey | undefined;
		for (const key of this.saved.keys) {
			const expected = Buffer.from(key.digest, "hex");
			if (key.enabled && expected.length === digest.length && timingSafeEqual(expected, digest)) match = key;
		}
		if (!match) return false;
		match.lastUsedAt = Date.now();
		this.usedTimer ??= setTimeout(() => {
			this.usedTimer = undefined;
			void this.changed().catch(() => {});
		}, USED_FLUSH_MS);
		this.usedTimer.unref?.();
		return true;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.on("error", () => {});
		const path = new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
		const anthropic = /\/messages(\/count_tokens)?$/.test(path) || "anthropic-version" in request.headers;
		const origin = request.headers.origin;
		if (origin && originAllowed(origin, this.saved.lan)) {
			response.setHeader("Access-Control-Allow-Origin", origin);
			response.setHeader("Vary", "Origin");
			response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] ?? "authorization, content-type, x-api-key, anthropic-version");
		}
		const json = (status: number, body: unknown) => {
			const raw = JSON.stringify(body);
			response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(raw), "Cache-Control": "no-store" });
			response.end(raw);
		};
		const fail = (error: unknown) => {
			if (response.headersSent || response.destroyed) return;
			const known = error instanceof ProxyError ? error : error instanceof SyntaxError ? new ProxyError(400, "The request body isn't valid JSON.") : undefined;
			const status = known?.status ?? 502;
			const kind = known?.kind ?? "api_error";
			const message = known?.message ?? (error instanceof Error ? error.message : String(error));
			json(status, anthropic ? { type: "error", error: { type: ERROR_KINDS[status] ?? kind, message } } : { error: { message, type: ERROR_KINDS[status] ?? kind, code: null } });
		};

		try {
			if (request.method === "OPTIONS") {
				response.writeHead(204, { "Content-Length": 0 });
				response.end();
				return;
			}
			if (!this.authorized(request)) throw new ProxyError(401, "Invalid API key. Create one in Trivium under Settings, API proxy.", "authentication_error");
			if (request.method === "GET") {
				if (path === "/") return json(200, { name: "Trivium", status: "running" });
				if (path === "/v1/models" || path === "/models") return json(200, await this.listing());
				throw new ProxyError(404, "Not found.", "not_found_error");
			}
			if (request.method !== "POST") throw new ProxyError(405, "Use GET or POST.");
			const chat = path === "/v1/chat/completions" || path === "/chat/completions";
			const messages = path === "/v1/messages" || path === "/messages";
			const count = path === "/v1/messages/count_tokens" || path === "/messages/count_tokens";
			if (!chat && !messages && !count) throw new ProxyError(404, "Not found.", "not_found_error");
			if (chat ? !this.saved.openai : !this.saved.anthropic) {
				throw new ProxyError(404, `The ${chat ? "OpenAI" : "Anthropic"} format is turned off in Trivium's API proxy settings.`, "not_found_error");
			}
			const body = obj(JSON.parse(await readBody(request)));
			if (count) return json(200, { input_tokens: estimateTokens(body) });
			if (typeof body.model !== "string" || !body.model) throw new ProxyError(400, "model is required.");
			const name = body.model;
			const model = resolveModel(name, await this.backend.models(), this.saved.aliases);
			const parsed = messages ? fromAnthropic(body, model) : fromOpenAI(body, model);

			// A client that goes away stops the provider's reply, and what it would have cost.
			const abort = new AbortController();
			response.on("close", () => {
				if (!response.writableEnded) abort.abort();
			});
			const events = this.backend
				.stream(model, parsed.context, {
					signal: abort.signal,
					maxTokens: parsed.maxTokens,
					temperature: parsed.temperature,
					reasoning: parsed.reasoning,
					toolChoice: parsed.toolChoice,
				})
				[Symbol.asyncIterator]();

			if (!parsed.stream) {
				let reply: AssistantMessage | undefined;
				for (let next = await events.next(); !next.done; next = await events.next()) {
					if (next.value.type === "error") throw upstreamError(next.value.error);
					if (next.value.type === "done") reply = next.value.message;
				}
				if (!reply) throw new ProxyError(502, "The provider ended the reply without finishing it.", "api_error");
				return json(200, messages ? anthropicResponse(reply, name, model) : openAIResponse(reply, name));
			}

			// The first event comes before the 200, so a provider that refuses outright still answers with its error's status.
			const first = await events.next();
			if (first.done) throw new ProxyError(502, "The provider sent no reply.", "api_error");
			if (first.value.type === "error") throw upstreamError(first.value.error);
			const encoder: StreamEncoder = messages ? anthropicStream(name, model) : openAIStream(name, parsed.includeUsage);
			response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
			// Nothing is written once the client has gone.
			const write = (frames: string) => {
				if (frames && !response.destroyed) response.write(frames);
			};
			const ping = setInterval(() => write(messages ? 'event: ping\ndata: {"type": "ping"}\n\n' : ": keep-alive\n\n"), PING_MS);
			try {
				write(encoder.push(first.value));
				for (let next = await events.next(); !next.done; next = await events.next()) write(encoder.push(next.value));
			} catch (error) {
				write(encoder.fail(error instanceof Error ? error.message : String(error)));
			} finally {
				clearInterval(ping);
				response.end();
			}
		} catch (error) {
			fail(error);
		}
	}

	/** The models on offer, in a shape both OpenAI's and Anthropic's clients read. */
	private async listing(): Promise<Json> {
		const models = await this.backend.models();
		const byKey = new Map(models.map((model) => [keyOf(model), model]));
		const entry = (id: string, model: Model<Api>) => ({
			id,
			object: "model",
			type: "model",
			display_name: model.name || model.id,
			created: 0,
			created_at: "1970-01-01T00:00:00Z",
			owned_by: model.provider,
		});
		const data = [
			// A name that stands for a model Trivium no longer offers isn't listed; asking for it says why.
			...this.saved.aliases.flatMap((alias) => {
				const model = byKey.get(alias.model);
				return model ? [entry(alias.alias, model)] : [];
			}),
			...models.map((model) => entry(keyOf(model), model)),
		];
		return { object: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
	}
}
