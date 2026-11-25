import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProxyAlias, ProxyKeyInfo, ProxyKeyPurpose, ProxyOptions, ProxyStatus } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import {
	anthropicResponse,
	anthropicStream,
	estimateTokens,
	fromAnthropic,
	fromOpenAI,
	modelEntry,
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

const DEFAULTS: Saved = { enabled: false, port: 8787, openai: true, anthropic: true, lan: false, requireKey: false, keys: [], aliases: [] };

const MAX_BODY = 32_000_000;
const MAX_KEYS = 100;
/** How long a request's headers may be altogether. Node's own default, whatever it was started with. */
const MAX_HEADER = 16 * 1024;
/** A quiet stream gets a line this often, so nothing between the client and the proxy gives up on it. */
const PING_MS = 15_000;
/** How long after a request a key's last use is written down, so a busy client doesn't write the file per request. */
const USED_FLUSH_MS = 3000;
/** How long a change waits for another Trivium to finish its own. */
const LOCK_WAIT_MS = 5000;
/** How long it waits on Windows for something that only still has the file open. */
const EPERM_WAIT_MS = 2000;

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* The file */

/** What the file holds, or undefined when there is none. Throws when it can't be read. */
function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** The settings in what the file holds, or undefined when there is no file or it is damaged. */
function parseSaved(text: string | undefined): Saved | undefined {
	if (text === undefined) return undefined;
	let saved: Partial<Saved>;
	try {
		saved = JSON.parse(text) as Partial<Saved>;
	} catch {
		return undefined;
	}
	if (!saved || typeof saved !== "object" || Array.isArray(saved)) return undefined;
	return {
		...DEFAULTS,
		...saved,
		// Files from before this option come from proxies that always required a key. One that was set up goes on
		// requiring it, so an update doesn't open it to everyone.
		requireKey: typeof saved.requireKey === "boolean" ? saved.requireKey : saved.enabled === true || (Array.isArray(saved.keys) && saved.keys.length > 0),
		keys: Array.isArray(saved.keys) ? saved.keys.filter((key) => key && typeof key.digest === "string" && typeof key.id === "string") : [],
		aliases: Array.isArray(saved.aliases) ? saved.aliases.filter((entry) => entry && typeof entry.alias === "string" && typeof entry.model === "string") : [],
	};
}

/**
 * Puts a new version, written to a file of its own, in the file's place. Checks that it may each time it tries, in the
 * same go as trying.
 */
async function replace(from: string, file: string, check: () => void): Promise<void> {
	const started = Date.now();
	for (;;) {
		check();
		try {
			return renameSync(from, file);
		} catch (error) {
			if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM" || Date.now() - started >= EPERM_WAIT_MS) throw error;
			await sleep(20);
		}
	}
}

const conflict = () => new Error(t("Another Trivium is changing the proxy's settings. Try again."));

/** SQLite's code for a lock that another connection has. */
const SQLITE_BUSY = 5;

/**
 * Takes the lock that Trivium processes with the same profile change the file under, until the connection returned is
 * closed. It is SQLite's write lock on a database that stays empty, which the operating system holds for the process.
 * So a process that has it keeps it however long it is held up, rather than going on without it, and one that ends in
 * any way gives it up. Nothing is cleaned up by name: the database file is left where it is, since a lock on one that
 * was deleted and made again would be another lock. Only SQLite may open it: on POSIX systems a process that closes a
 * file loses its locks on it, which SQLite sees to among its own connections.
 */
async function acquire(file: string): Promise<DatabaseSync> {
	const started = Date.now();
	const lock = new DatabaseSync(`${file}.lock.sqlite`);
	try {
		// Nothing is ever committed, so it needs no journal file either.
		lock.exec("PRAGMA journal_mode = MEMORY");
		for (;;) {
			try {
				lock.exec("BEGIN IMMEDIATE");
				return lock;
			} catch (error) {
				// The low byte of an extended code is the code it extends.
				if (((error as { errcode?: number }).errcode ?? 0) % 256 !== SQLITE_BUSY) throw error;
				if (Date.now() - started >= LOCK_WAIT_MS) throw conflict();
			}
			await sleep(20 + Math.random() * 30);
		}
	} catch (error) {
		lock.close();
		throw error;
	}
}

/** What came of looking for settings another Trivium saved. When it failed there may be some that aren't known here. */
type Refresh = "unchanged" | "updated" | "failed";

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

/** This computer, by the addresses and names reserved for loopback. */
const isLoopback = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");

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
	return isLoopback(host) || (lan && isPrivateAddress(host));
}

/** What Docker calls the computer it runs on. A container reaches that computer's loopback by it. */
const DOCKER_HOST = "host.docker.internal";

/** A Host header: a name or an IPv4 address, or an IPv6 address in brackets, and a port if not the usual one. */
const HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i;

/** The name or address in a Host header, or undefined when it isn't a valid one. */
function hostName(host: string): string | undefined {
	const match = HOST.exec(host);
	if (!match) return undefined;
	const port = match[1];
	if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return undefined;
	try {
		// Settles how addresses are written. The check above leaves nothing but the host and port to take apart.
		return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
	} catch {
		return undefined;
	}
}

/**
 * Whether a request with no key may be addressed to this Host. A page whose own domain was pointed at this computer
 * (DNS rebinding) is same-origin to the browser, which then may send no Origin, so only its domain in Host gives it
 * away. Names that others on the network can claim, such as ones under .local, are no better than a public domain.
 *
 * This computer only: loopback, and Docker's name for this computer. With the network allowed: also private IPv4
 * addresses, and whichever others this computer has, since Settings gives those out as the base URL. A request with
 * any other Host, with none, or with several needs a key.
 *
 * This keeps web pages from being turned on the proxy. It says nothing of who is calling: a reverse proxy may rewrite
 * Host, and any other client may send what it likes. Only requiring a key decides that.
 */
function hostAllowed(hosts: string[] | undefined, lan: boolean, addresses: () => string[]): boolean {
	const name = hosts?.length === 1 ? hostName(hosts[0]!) : undefined;
	if (!name) return false;
	if (isLoopback(name) || name === DOCKER_HOST) return true;
	return lan && (isPrivateAddress(name) || addresses().includes(name));
}

/* HTTP */

const ERROR_KINDS: Record<number, string> = {
	401: "authentication_error",
	403: "permission_error",
	404: "not_found_error",
	413: "request_too_large",
	429: "rate_limit_error",
};

/** Closes a socket. Requests in flight end here; a client sees its stream cut. */
function stop(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

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
 * Trivium, so other apps can use them. It listens on this computer only unless the network is allowed, and can
 * require one of its own keys of every request. The providers' credentials stay with pi either way.
 */
export class ProxyService {
	private saved: Saved;
	/** What the file held when its settings were last taken up or saved, which `saved` goes with. */
	private text: string | undefined;
	/** Whether that has no settings in it, being damaged or gone: `saved` is from before, and may be out of date. */
	private damaged = false;
	/** Why the file can't be read, when it can't. */
	private unreadable: string | undefined;
	/** Whether the last request was refused since the settings couldn't be read. */
	private refusing = false;
	private server: Server | undefined;
	private error: string | undefined;
	private disposed = false;
	/** The last change asked for. Each waits for the one before, so the settings and the socket move together. */
	private queue: Promise<unknown> = Promise.resolve();
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
		// A damaged file starts over turned off, which lets nobody in.
		this.saved = structuredClone(DEFAULTS);
		try {
			this.text = this.read();
			this.saved = parseSaved(this.text) ?? this.saved;
		} catch {
			// One that can't be read right now is tried again before the proxy starts or changes.
		}
	}

	/** Starts the proxy if it was on when Trivium last ran. */
	async init(): Promise<void> {
		await this.serialize(async () => {
			await this.adopt();
			await this.startIfOn();
		});
	}

	/** The port it listens on now, which differs from the saved one only when that is 0. */
	get port(): number | undefined {
		const address = this.server?.address();
		return address && typeof address === "object" ? address.port : undefined;
	}

	async status(): Promise<ProxyStatus> {
		const failed = (await this.sync()) === "failed";
		let models = 0;
		try {
			models = (await this.backend.models()).length;
		} catch {
			// The page still shows the rest.
		}
		// Read in one go, so the settings are the ones that go with the socket.
		const { keys, ...rest } = this.saved;
		return {
			...rest,
			aliases: rest.aliases.map((entry) => ({ ...entry })),
			running: Boolean(this.server),
			// Until the settings can be read, that comes first: what else went wrong can't be put right before then.
			error: this.unreadError(failed) ?? this.error,
			keys: keys.map(({ digest: _digest, ...key }) => key),
			addresses: this.saved.lan ? this.addresses() : [],
			models,
		};
	}

	/** Says that what is saved isn't known. Damaged settings a change replaces; ones that can't be read it leaves. */
	private unreadError(failed: boolean): string | undefined {
		if (!failed) return undefined;
		if (this.unreadable) return t("The proxy's saved settings can't be read, so it refuses every request and nothing here can be changed: {error}", { error: this.unreadable });
		return this.server ? t("The proxy's saved settings can't be read, so it refuses every request. If that goes on, change any option here to save them again.") : undefined;
	}

	setEnabled(on: boolean): Promise<ProxyStatus> {
		return this.change(async () => {
			if (!on) {
				await this.commit({ enabled: false });
				this.error = undefined;
				await this.close();
			} else if (this.server) {
				await this.commit({ enabled: true });
			} else {
				this.assertCanStart();
				await this.commit({ enabled: true }, await this.listen(this.saved));
				this.error = undefined;
			}
		});
	}

	/** Changes the options given, leaving the others as they are by the time it is this change's turn. */
	saveOptions(patch: Partial<ProxyOptions>): Promise<ProxyStatus> {
		return this.change(async () => {
			const previous = this.saved;
			const flag = (value: unknown, current: boolean) => (typeof value === "boolean" ? value : current);
			const next: ProxyOptions = {
				port: patch.port === undefined ? previous.port : Number(patch.port),
				openai: flag(patch.openai, previous.openai),
				anthropic: flag(patch.anthropic, previous.anthropic),
				lan: flag(patch.lan, previous.lan),
				requireKey: flag(patch.requireKey, previous.requireKey),
			};
			if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) throw new Error(t("Choose a port from 1024 to 65535."));
			if (!next.openai && !next.anthropic) throw new Error(t("Keep at least one format on."));
			// Requiring a key when there is none would shut every client out.
			if (next.requireKey && !previous.requireKey) this.assertKey();
			// Formats and the key apply to the next request; a new port or reach needs a new socket.
			if (!this.server || (previous.port === next.port && previous.lan === next.lan)) {
				await this.commit(next);
				await this.startIfOn();
				return;
			}
			await this.close();
			try {
				await this.commit(next, await this.listen(next));
				this.error = undefined;
			} catch (error) {
				// The proxy goes back to where it listened, so clients set up for it keep working.
				try {
					this.install(await this.listen(previous));
				} catch (restoreError) {
					this.error = messageOf(restoreError);
				}
				throw error;
			}
		});
	}

	/**
	 * Adds a key, or changes one. What the key was added for, requiring one or starting the proxy, is saved along with
	 * it: a proxy that is on but couldn't listen may try again here, and must not answer anyone without the key first.
	 * Starting one is for a proxy that requires a key, as it did when the key was asked for. If it no longer does, it
	 * isn't opened to everyone instead.
	 */
	async saveKey(id: string | undefined, name: string, value: string, purpose?: ProxyKeyPurpose): Promise<{ status: ProxyStatus; key?: string }> {
		// A new key always has a value; an existing one changes only when given a new value.
		const fresh = value.trim() ? validateKey(value.trim()) : id ? undefined : generateKey();
		const status = await this.change(async () => {
			const { keys, requireKey } = this.saved;
			if (purpose === "start" && !requireKey) {
				throw new Error(t("The proxy no longer requires an API key, so nothing was saved and it wasn't started. Close this and turn it on again to run it without one."));
			}
			const existing = id ? keys.find((key) => key.id === id) : undefined;
			if (id && !existing) throw new Error(t("That key is gone."));
			if (!existing && keys.length >= MAX_KEYS) throw new Error(t("The proxy keeps up to {n} keys. Remove one first.", { n: MAX_KEYS }));
			const label = validateName(name);
			const digest = fresh ? digestOf(fresh) : existing!.digest;
			const others = keys.filter((key) => key !== existing);
			if (others.some((key) => key.name === label)) throw new Error(t("Another key is called “{name}” already.", { name: label }));
			if (others.some((key) => key.digest === digest)) throw new Error(t("Another key has this value already."));
			const changed = { name: label, digest, hint: fresh ? `…${fresh.slice(-4)}` : existing!.hint };
			const next = existing
				? keys.map((key) => (key === existing ? { ...key, ...changed } : key))
				: [...keys, { id: randomUUID(), ...changed, enabled: true, createdAt: Date.now() }];
			const change: Partial<Saved> = { keys: next };
			if (purpose === "start") change.enabled = true;
			if (purpose === "require") {
				this.assertKey(next);
				change.requireKey = true;
			}
			await this.commit(change);
			await this.startForKey();
		});
		return { status, key: fresh };
	}

	setKeyEnabled(id: string, enabled: boolean): Promise<ProxyStatus> {
		return this.change(async () => {
			const { keys } = this.saved;
			if (!keys.some((key) => key.id === id)) throw new Error(t("That key is gone."));
			await this.commit({ keys: keys.map((key) => (key.id === id ? { ...key, enabled: Boolean(enabled) } : key)) });
			await this.startForKey();
		});
	}

	removeKey(id: string): Promise<ProxyStatus> {
		return this.change(() => this.commit({ keys: this.saved.keys.filter((key) => key.id !== id) }));
	}

	saveAliases(aliases: ProxyAlias[]): Promise<ProxyStatus> {
		return this.change(() => this.commit({ aliases: validateAliases(Array.isArray(aliases) ? aliases : []) }));
	}

	private assertKey(keys: StoredKey[] = this.saved.keys): void {
		if (keys.some((key) => key.enabled)) return;
		throw new Error(t(keys.length ? "Every API key is off. Turn one on or add another first. Clients need one to connect." : "Add an API key first. Clients need one to connect."));
	}

	/**
	 * Every way of starting checks this, so a proxy nobody could connect to says so instead of running. One that is
	 * running already goes on when its last key goes: its clients are told why, and the next key lets them in.
	 */
	private assertCanStart(): void {
		if (this.saved.requireKey) this.assertKey();
	}

	/** Starts the proxy if it is on but isn't listening, such as once a change made that possible. Notes why it can't. */
	private async startIfOn(): Promise<void> {
		if (!this.saved.enabled || this.server) return;
		try {
			this.assertCanStart();
			this.install(await this.listen(this.saved));
			this.error = undefined;
		} catch (error) {
			this.error = messageOf(error);
		}
	}

	/**
	 * Starts the proxy if a key is what it lacked. Where none is required, a key has no bearing on why it isn't
	 * listening, and may be there to be required next: it doesn't open in between.
	 */
	private async startForKey(): Promise<void> {
		if (this.saved.requireKey) await this.startIfOn();
	}

	/** Stops listening and drops open connections. Synchronous, for use while quitting. */
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.usedTimer);
		void this.close();
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => {});
		return run;
	}

	/**
	 * Reads the file, noting why when it can't. Every look at it does, since only reading it tells whether it may still
	 * be read: losing that changes neither its size nor its modification time, and Windows checks it on opening.
	 */
	private read(): string | undefined {
		try {
			const text = readText(this.file);
			this.unreadable = undefined;
			return text;
		} catch (error) {
			this.unreadable = messageOf(error);
			throw error;
		}
	}

	/**
	 * Takes up what another Trivium with this profile saved since, moving the socket along if there is one. Runs in the
	 * queue. Throws when the file can't be read; one that is gone or damaged leaves the settings as they are.
	 */
	private async adopt(): Promise<Refresh> {
		const text = this.read();
		if (text === this.text) return this.damaged ? "failed" : "unchanged";
		const next = parseSaved(text);
		if (!next) {
			this.text = text;
			this.damaged = true;
			return "failed";
		}
		const { enabled, port, lan } = this.saved;
		const moved = next.enabled !== enabled || next.port !== port || next.lan !== lan;
		const listening = Boolean(this.server);
		// Closed first: what may be open to this computer needn't be open to where it listened until now.
		if (moved) {
			this.error = undefined;
			await this.close();
		}
		for (const key of next.keys) {
			const used = this.saved.keys.find((entry) => entry.id === key.id)?.lastUsedAt;
			if (used && used > (key.lastUsedAt ?? 0)) key.lastUsedAt = used;
		}
		this.saved = next;
		this.text = text;
		this.damaged = false;
		if (moved && listening) await this.startIfOn();
		return "updated";
	}

	/** Adopts what another Trivium saved, outside of a change. */
	private async sync(): Promise<Refresh> {
		try {
			if (this.read() === this.text) return this.damaged ? "failed" : "unchanged";
			return await this.serialize(() => this.adopt());
		} catch {
			return "failed";
		}
	}

	/**
	 * Makes a change once those before it are done, and reports where that left the proxy, also when it failed. It is
	 * made to the latest settings, with other Triviums kept from changing them, so none undoes what another saved.
	 */
	private async change(task: () => Promise<void>): Promise<ProxyStatus> {
		try {
			await this.serialize(async () => {
				const lock = await acquire(this.file);
				try {
					await this.adopt();
					await task();
				} finally {
					lock.close();
				}
			});
		} catch (error) {
			void this.status()
				.then((status) => this.emit(status))
				.catch(() => {});
			throw error;
		}
		// Not part of the turn: listing the models can be slow, and the next change needn't wait for it.
		const status = await this.status();
		this.emit(status);
		return status;
	}

	/**
	 * Writes a change down, then applies it, along with the socket that goes with it if that is new. When the write
	 * fails nothing is applied and the new socket closes, so what is enforced is always what was saved. Only a change
	 * does this, under its lock.
	 */
	private async commit(change: Partial<Saved>, server?: Server): Promise<void> {
		const next: Saved = { ...this.saved, ...change };
		const text = JSON.stringify(next, null, 2);
		// A crash may leave it behind, so each has a name of its own.
		const draft = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(draft, text, { mode: 0o600, flag: "wx" });
			await replace(draft, this.file, () => {
				// Other Triviums are kept out by the lock. This is for whatever else changes the file, or who may read it.
				if (this.read() !== this.text) throw conflict();
			});
		} catch (error) {
			await unlink(draft).catch(() => {});
			if (server) await stop(server);
			throw error;
		}
		// A request may have used a key in the meantime.
		for (const key of next.keys) key.lastUsedAt = this.saved.keys.find((entry) => entry.id === key.id)?.lastUsedAt ?? key.lastUsedAt;
		this.saved = next;
		this.text = text;
		this.damaged = false;
		if (server) this.install(server);
	}

	private install(server: Server): void {
		if (this.disposed) void stop(server);
		else this.server = server;
	}

	/** Opens a socket, which serves nobody until it is installed. */
	private listen({ port, lan }: ProxyOptions): Promise<Server> {
		return new Promise((resolve, reject) => {
			const server = createServer({ maxHeaderSize: MAX_HEADER }, (request, response) => void this.receive(server, request, response));
			// Past a number of headers Node drops the rest, unseen by the checks on them. Their size is limit enough.
			server.maxHeadersCount = 0;
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
			server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => resolve(server));
		});
	}

	/**
	 * Answers a request by the latest settings, also when it was another Trivium that saved them. When those can't be
	 * read it answers none: they may be what requires a key, or took one away.
	 */
	private async receive(server: Server, request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.on("error", () => {});
		let refresh: Refresh | undefined;
		if (this.server === server) {
			refresh = await this.sync();
			const refusing = refresh === "failed";
			if (refresh === "updated" || refusing !== this.refusing) {
				this.refusing = refusing;
				void this.status()
					.then((status) => this.emit(status))
					.catch(() => {});
			}
		}
		if (this.server === server && refresh !== "failed") return this.handle(request, response);
		// The settings that go with this socket aren't in force yet, or no longer are.
		response.writeHead(503, { "Retry-After": "1", "Content-Length": 0, Connection: "close" });
		response.end();
	}

	private async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server) await stop(server);
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
			// Where the file is damaged, writing it would put settings back in force that may be out of date. Only a change does.
			void this.change(async () => {
				if (!this.damaged) await this.commit({});
			}).catch(() => {});
		}, USED_FLUSH_MS);
		this.usedTimer.unref?.();
		return true;
	}

	/**
	 * Refuses a request that may not use the proxy. With no key required, whatever a client sends as one is fine,
	 * since many SDKs insist on sending something. Web pages are the exception: a browser lets any site post to
	 * this computer, so without a key only local ones are answered.
	 *
	 * A key admits a request whatever its Origin, for clients that send one but aren't bound by CORS, such as
	 * extensions and desktop apps. It doesn't open the proxy to other sites' pages: they get no CORS headers (see
	 * handle), so a browser stops at the preflight that sending a key takes.
	 */
	private admit(request: IncomingMessage): void {
		if (this.authorized(request)) return;
		if (this.saved.requireKey) throw new ProxyError(401, "Invalid API key. Create one in Trivium under Settings, API proxy.", "authentication_error");
		const { origin } = request.headers;
		if (origin && !originAllowed(origin, this.saved.lan)) {
			throw new ProxyError(403, "Web pages from this origin can't call the proxy. A client that isn't a web page can with an API key, created in Trivium under Settings, API proxy.", "permission_error");
		}
		if (!hostAllowed(request.headersDistinct.host, this.saved.lan, this.addresses)) {
			throw new ProxyError(403, "Requests to this address need an API key. Create one in Trivium under Settings, API proxy.", "permission_error");
		}
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = new URL(request.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
		const anthropic = /\/messages(\/count_tokens)?$/.test(path) || "anthropic-version" in request.headers;
		const origin = request.headers.origin;
		// By origin alone, on answers as on preflights, which never carry a key.
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
			this.admit(request);
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
		const data = [
			// A name that stands for a model Trivium no longer offers isn't listed; asking for it says why.
			...this.saved.aliases.flatMap((alias) => {
				const model = byKey.get(alias.model);
				return model ? [modelEntry(alias.alias, model)] : [];
			}),
			...models.map((model) => modelEntry(keyOf(model), model)),
		];
		return { object: "list", data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
	}
}
