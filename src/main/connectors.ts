import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { SERVER_NAME } from "../shared/connectors.ts";
import { t } from "../shared/i18n.ts";
import type { ConnectorInfo, ConnectorInput, ConnectorsView, McpExposure } from "../shared/protocol.ts";

type Json = Record<string, unknown>;

/** What `pi mcp list --json` reports of a server. */
interface ListedServer {
	name: string;
	state: string;
	tools: string[];
	resources?: boolean;
	error?: string;
}

interface ConfigModule {
	loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
	addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean;
	removeMcpServerConfig(path: string, name: string): boolean;
	updateMcpServerConfig(path: string, name: string, patch: { enabled?: boolean; exposure?: McpExposure }): void;
}

interface ServersModule {
	validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string;
	getMcpToolExposure(config: McpServerConfig, tool: string): McpExposure;
}

interface CliModule {
	runMcpCommand(
		args: string[],
		options: { cwd: string; agentDir: string; openUrl?: (url: string) => void; log?: (line: string) => void; error?: (line: string) => void },
	): Promise<number>;
}

/** pi's own MCP code, which its package doesn't export: the same modules `pi mcp` and /mcp run. */
const piModule = <T>(path: string): Promise<T> =>
	import(pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), path)).href) as Promise<T>;
const configModule = () => piModule<ConfigModule>("extensions/mcp/config.js");
const serversModule = () => piModule<ServersModule>("core/mcp-servers.js");
const cliModule = () => piModule<CliModule>("extensions/mcp/cli.js");

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The `mcpServers` of an mcp.json as written, before pi checks or changes anything. */
function rawServers(path: string): Json {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
	return isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
}

/** The entry to write: the page's fields, then what it doesn't edit, such as exposure, a timeout or OAuth settings. */
export function entryFor(input: ConnectorInput, previous: Json = {}): Json {
	const kept = { ...previous };
	for (const key of ["type", "command", "args", "env", "url", "headers", "description"]) delete kept[key];
	if (input.transport === "http") delete kept.cwd;
	else {
		delete kept.oauth;
		delete kept.auth;
	}
	const description = input.description.trim();
	const fields: Json =
		input.transport === "stdio"
			? {
					command: input.command.trim(),
					...(input.args.length ? { args: input.args } : {}),
					...(Object.keys(input.env).length ? { env: input.env } : {}),
				}
			: { url: input.url.trim(), ...(Object.keys(input.headers).length ? { headers: input.headers } : {}) };
	return { ...fields, ...(description ? { description } : {}), ...kept };
}

/**
 * Server entries from pasted JSON: an `mcpServers` object, as Claude, Cursor and pi write it, VS Code's
 * `servers`, a bare map of entries, or one entry on its own, which takes `name`.
 */
export function parseImport(json: string, name?: string): Json {
	const text = json.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// A `"name": { ... }` pair copied out of a larger file.
		try {
			parsed = JSON.parse(`{${text.replace(/,\s*$/, "")}}`);
		} catch {
			throw new Error(t("That isn't valid JSON: {error}", { error: messageOf(error) }));
		}
	}
	if (!isRecord(parsed)) throw new Error(t("Paste a JSON object: an mcpServers block, or one server's entry."));
	if (isRecord(parsed.mcpServers)) return parsed.mcpServers;
	if (isRecord(parsed.servers)) return parsed.servers;
	if ("command" in parsed || "url" in parsed || "type" in parsed) {
		if (!name) throw new Error(t("That is one server's entry. Give it a name."));
		return { [name]: parsed };
	}
	return parsed;
}

function stateOf(listed: ListedServer): ConnectorInfo["state"] {
	if (listed.state === "connected" || listed.state === "needs-auth") return listed.state;
	return listed.state === "disabled" ? undefined : "failed";
}

/**
 * MCP servers in pi's global mcp.json, the file the pi CLI and every session read. Edits go through pi's
 * own config code, and checks connect as `pi mcp list` does, with the sign-ins pi keeps in mcp-auth.json.
 */
export class ConnectorStore {
	/** The last check, by server name. */
	private listed = new Map<string, ListedServer>();
	private checked?: number;
	private checking?: Promise<ConnectorsView>;
	private readonly agentDir: string;
	private readonly openUrl: (url: string) => void;

	constructor(agentDir: string, openUrl: (url: string) => void) {
		this.agentDir = agentDir;
		this.openUrl = openUrl;
	}

	get path(): string {
		return join(this.agentDir, "mcp.json");
	}

	async view(): Promise<ConnectorsView> {
		const [{ loadMcpConfig }, { getMcpToolExposure }] = await Promise.all([configModule(), serversModule()]);
		// The global file only: Settings has no project. A project's own .pi/mcp.json loads in its sessions once trusted.
		const loaded = loadMcpConfig({ agentDir: this.agentDir, cwd: this.agentDir, projectTrusted: false });
		const describe = ({ name, config }: McpServerEntry): ConnectorInfo => {
			const listed = this.listed.get(name);
			const enabled = config.enabled !== false;
			const http = "url" in config ? config : undefined;
			const stdio = "command" in config ? config : undefined;
			const headers = http?.headers ?? {};
			return {
				name,
				transport: http ? "http" : "stdio",
				command: stdio?.command ?? "",
				args: stdio?.args ?? [],
				env: stdio?.env ?? {},
				url: http?.url ?? "",
				headers,
				description: config.description ?? "",
				enabled,
				exposure: config.exposure ?? "codemode",
				oauth: Boolean(http && !http.auth && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")),
				state: enabled ? listed && stateOf(listed) : "disabled",
				tools: (listed?.tools ?? []).map((tool) => ({ name: tool, exposure: getMcpToolExposure(config, tool) })),
				resources: Boolean(listed?.resources),
				error: enabled && listed?.state !== "connected" ? listed?.error : undefined,
			};
		};
		return { path: this.path, servers: loaded.servers.map(describe), errors: loaded.errors, checked: this.checked };
	}

	/** Connects to every enabled server and lists its tools. A check already going is shared. */
	check(): Promise<ConnectorsView> {
		this.checking ??= this.list().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	private async list(): Promise<ConnectorsView> {
		const output: string[] = [];
		const problems: string[] = [];
		// Exits with 1 whenever a server isn't connected; the report says which.
		await (await cliModule()).runMcpCommand(["list", "--json"], {
			cwd: this.agentDir,
			agentDir: this.agentDir,
			log: (line) => output.push(line),
			error: (line) => problems.push(line),
		});
		if (!output.length) throw new Error(problems.join("\n") || t("pi couldn't check the MCP servers."));
		const report = JSON.parse(output.join("\n")) as { servers: ListedServer[] };
		this.listed = new Map(report.servers.map((server) => [server.name, server]));
		this.checked = Date.now();
		return this.view();
	}

	async save(input: ConnectorInput, previousName?: string): Promise<ConnectorsView> {
		const name = input.name.trim();
		if (input.transport === "stdio" ? !input.command.trim() : !input.url.trim()) {
			throw new Error(t(input.transport === "stdio" ? "Enter the command that starts the server." : "Enter the server's URL."));
		}
		const raw = rawServers(this.path);
		if (name !== previousName && raw[name] !== undefined) throw new Error(t("A server called “{name}” exists already.", { name }));
		const entry = entryFor(input, previousName && isRecord(raw[previousName]) ? raw[previousName] : {});
		await this.write({ [name]: entry });
		if (previousName && previousName !== name) {
			(await configModule()).removeMcpServerConfig(this.path, previousName);
			this.listed.delete(previousName);
		}
		return this.view();
	}

	async import(json: string, name?: string): Promise<{ view: ConnectorsView; added: string[] }> {
		const entries = parseImport(json, name?.trim() || undefined);
		const added = Object.keys(entries);
		if (!added.length) throw new Error(t("There are no servers in that JSON."));
		const raw = rawServers(this.path);
		const taken = added.filter((entry) => raw[entry] !== undefined);
		if (taken.length) {
			const names = taken.map((entry) => t("“{title}”", { title: entry })).join(t(", "));
			throw new Error(t(taken.length === 1 ? "{names} exists already. Rename or remove it first." : "{names} exist already. Rename or remove them first.", { names }));
		}
		await this.write(entries);
		return { view: await this.view(), added };
	}

	async remove(name: string): Promise<ConnectorsView> {
		(await configModule()).removeMcpServerConfig(this.path, name);
		this.listed.delete(name);
		return this.view();
	}

	async set(name: string, patch: { enabled?: boolean; exposure?: McpExposure }): Promise<ConnectorsView> {
		(await configModule()).updateMcpServerConfig(this.path, name, patch);
		return this.view();
	}

	async setToolExposure(name: string, tool: string, exposure: McpExposure): Promise<ConnectorsView> {
		const entry = rawServers(this.path)[name];
		if (!isRecord(entry)) throw new Error(`${this.path} has no server called “${name}”.`);
		const toolExposure: Json = { ...(isRecord(entry.toolExposure) ? entry.toolExposure : {}) };
		delete toolExposure[tool];
		// Without an entry of its own the tool follows its server, or a pattern that matches it.
		const { getMcpToolExposure } = await serversModule();
		if (getMcpToolExposure({ ...entry, toolExposure } as unknown as McpServerConfig, tool) !== exposure) toolExposure[tool] = exposure;
		const next: Json = { ...entry, toolExposure };
		if (!Object.keys(toolExposure).length) delete next.toolExposure;
		await this.write({ [name]: next });
		return this.view();
	}

	async signIn(name: string): Promise<ConnectorsView> {
		await this.run(["login", name], t("Signing in to {name} didn't finish.", { name }));
		return this.check();
	}

	async signOut(name: string): Promise<ConnectorsView> {
		await this.run(["logout", name], t("Signing out of {name} failed.", { name }));
		return this.check();
	}

	private async run(args: string[], fallback: string): Promise<void> {
		const problems: string[] = [];
		const code = await (await cliModule()).runMcpCommand(args, {
			cwd: this.agentDir,
			agentDir: this.agentDir,
			openUrl: this.openUrl,
			log: () => {},
			error: (line) => problems.push(line),
		});
		if (code !== 0) throw new Error(problems.join("\n") || fallback);
	}

	/** Checks every entry as pi will read it before writing any, so one bad entry adds nothing. */
	private async write(entries: Json): Promise<void> {
		const [{ addMcpServerConfig }, { validateMcpServerConfig }] = await Promise.all([configModule(), serversModule()]);
		for (const [name, entry] of Object.entries(entries)) {
			if (!SERVER_NAME.test(name)) throw new Error(`“${name}” can't be a server name. Use only letters, digits, - and _.`);
			const valid = validateMcpServerConfig(name, entry);
			if (typeof valid === "string") throw new Error(valid);
		}
		for (const [name, entry] of Object.entries(entries)) addMcpServerConfig(this.path, name, entry as McpServerConfig);
	}
}
