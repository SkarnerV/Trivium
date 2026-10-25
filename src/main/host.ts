import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	type Extension,
	type InlineExtension,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AppDetails,
	AppId,
	ContextInfo,
	ExtensionInfo,
	ExtensionSource,
	FileChange,
	HostEvent,
	ModelOption,
	NewSessionInput,
	QueueInfo,
	SessionSummary,
	SessionView,
} from "../shared/protocol.ts";
import { APP_IDS } from "../shared/protocol.ts";
import { profileFor, profileInfo, triviumDir } from "./apps.ts";
import { ChangeTracker } from "./changes.ts";
import { createUiContext, type DialogBroker } from "./dialogs.ts";
import type { SettingsStore } from "./settings.ts";
import { RunTracker } from "./transcript.ts";

interface Live {
	path: string;
	app: AppId;
	cwd: string;
	session: AgentSession;
	tracker: RunTracker;
	changes: ChangeTracker;
	running: boolean;
	unread: boolean;
	unsubscribe: () => void;
	flushTimer?: ReturnType<typeof setTimeout>;
	sentRuns: number;
	lastActive: number;
}

const FLUSH_MS = 40;
const devFaux = fileURLToPath(new URL("../dev/faux-extension.ts", import.meta.url));

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** A readable name: the file name without extension, or the folder name for index files. */
function extensionName(path: string): string {
	if (path.includes(":") && !path.includes(sep)) return path.split(":").pop() ?? path;
	const file = basename(path).replace(/\.(ts|js|mjs)$/, "");
	return file === "index" ? basename(join(path, "..")) : file;
}

function registers(extension: Extension): string[] {
	return [
		...[...extension.tools.keys()].map((name) => `tool ${name}`),
		...[...extension.commands.keys()].map((name) => `/${name}`),
		...[...extension.handlers.keys()].map((name) => `on ${name}`),
	];
}

function titleOf(text: string | undefined): string {
	const line = (text ?? "").trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line || "New session";
}

/**
 * Owns every live pi session. Sessions keep running when the user switches
 * to another session or app; the renderer only chooses which one it shows.
 */
export class SessionHost {
	private live = new Map<string, Live>();
	private appIndex: Record<string, AppId> = {};
	private summaries: SessionSummary[] = [];
	private modelRuntime!: ModelRuntime;
	private readonly agentDir = getAgentDir();
	private viewing: string | undefined;
	private listTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly emit: (event: HostEvent) => void;
	private readonly broker: DialogBroker;
	private readonly indexFile: string;
	private readonly settings: SettingsStore;
	private readonly onDone: (path: string, title: string) => void;
	private idleTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: {
		emit: (event: HostEvent) => void;
		broker: DialogBroker;
		indexFile: string;
		settings: SettingsStore;
		/** Called when a run settles, for system notifications. */
		onDone: (path: string, title: string) => void;
	}) {
		this.emit = options.emit;
		this.broker = options.broker;
		this.indexFile = options.indexFile;
		this.settings = options.settings;
		this.onDone = options.onDone;
	}

	get runtime(): ModelRuntime {
		return this.modelRuntime;
	}

	async init(): Promise<void> {
		this.modelRuntime = await ModelRuntime.create();
		this.idleTimer = setInterval(() => this.unloadIdle(), 60_000);
		if (existsSync(this.indexFile)) {
			try {
				const parsed = JSON.parse(await readFile(this.indexFile, "utf8")) as Record<string, string>;
				for (const [id, app] of Object.entries(parsed)) {
					if ((APP_IDS as readonly string[]).includes(app)) this.appIndex[id] = app as AppId;
				}
			} catch {
				// A damaged index only loses the app grouping; sessions themselves stay in pi's storage.
			}
		}
	}

	async listSessions(): Promise<SessionSummary[]> {
		const infos = await SessionManager.listAll();
		const onDisk = new Set(infos.map((info) => info.path));
		const summaries: SessionSummary[] = infos.map((info) => {
			const live = this.live.get(info.path);
			return {
				path: info.path,
				id: info.id,
				cwd: info.cwd,
				title: live?.session.sessionName ?? info.name ?? titleOf(info.firstMessage),
				app: this.appIndex[info.id] ?? "code",
				modified: info.modified.getTime(),
				messageCount: info.messageCount,
				running: live?.running ?? false,
				unread: live?.unread ?? false,
			};
		});
		for (const live of this.live.values()) {
			if (onDisk.has(live.path)) continue;
			summaries.push({
				path: live.path,
				id: live.session.sessionId,
				cwd: live.cwd,
				title: this.titleFor(live),
				app: live.app,
				modified: Date.now(),
				messageCount: live.session.messages.length,
				running: live.running,
				unread: live.unread,
			});
		}
		summaries.sort((a, b) => b.modified - a.modified);
		this.summaries = summaries;
		return summaries;
	}

	recentProjects(): string[] {
		const seen = new Set<string>();
		for (const summary of this.summaries) if (summary.cwd) seen.add(summary.cwd);
		return [...seen].slice(0, 8);
	}

	async listModels(): Promise<ModelOption[]> {
		const models = await this.modelRuntime.getAvailable();
		return models.map((model) => ({
			key: `${model.provider}/${model.id}`,
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
			thinkingLevels: getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]),
		}));
	}

	async openSession(path: string): Promise<SessionView> {
		this.viewing = path;
		let live = this.live.get(path);
		if (live) live.lastActive = Date.now();
		if (!live) {
			const manager = SessionManager.open(path);
			const app = this.appIndex[manager.getSessionId()] ?? "code";
			live = await this.start(app, manager.getCwd(), manager);
		}
		if (live.unread) {
			live.unread = false;
			this.scheduleList();
		}
		return this.view(live, await live.changes.list());
	}

	async newSession(input: NewSessionInput): Promise<SessionView> {
		const live = await this.start(input.app, input.cwd, SessionManager.create(input.cwd), true);
		this.viewing = live.path;
		this.appIndex[live.session.sessionId] = input.app;
		await this.saveIndex();
		if (input.message?.trim()) await this.send(live.path, input.message, "prompt");
		this.scheduleList();
		return this.view(live, []);
	}

	async send(path: string, text: string, mode: "prompt" | "steer" | "followUp"): Promise<void> {
		const live = this.require(path);
		const { session } = live;
		if (mode === "steer" || (mode === "prompt" && live.running)) {
			await session.steer(text);
			return;
		}
		if (mode === "followUp") {
			await session.followUp(text);
			return;
		}
		// prompt() resolves when the run finishes, so the run continues in the background.
		void session.prompt(text).catch((error: unknown) => {
			this.notice(error instanceof Error ? error.message : String(error), "error");
		});
	}

	async abort(path: string): Promise<void> {
		await this.require(path).session.abort();
	}

	clearQueue(path: string): QueueInfo {
		const live = this.require(path);
		live.session.clearQueue();
		return this.queueOf(live);
	}

	async setModel(path: string, modelKey: string, thinkingLevel: string): Promise<void> {
		const { session } = this.require(path);
		const slash = modelKey.indexOf("/");
		const model = this.modelRuntime.getModel(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(`Unknown model ${modelKey}`);
		if (session.model?.provider !== model.provider || session.model?.id !== model.id) await session.setModel(model);
		session.setThinkingLevel(thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
		this.emitStatus(this.require(path));
	}

	async keepChanges(path: string, files?: string[]): Promise<FileChange[]> {
		const live = this.require(path);
		await live.changes.keep(files);
		return this.emitChanges(live);
	}

	async revertChanges(path: string, files?: string[]): Promise<FileChange[]> {
		const live = this.require(path);
		if (live.running) throw new Error("Stop the run before reverting its changes.");
		await live.changes.revert(files);
		return this.emitChanges(live);
	}

	private async emitChanges(live: Live): Promise<FileChange[]> {
		const changes = await live.changes.list();
		this.emit({ type: "changes", path: live.path, changes });
		return changes;
	}

	/**
	 * Deletes sessions: unloads them, moves their files with `trash` (the system Trash),
	 * and drops Trivium's own records of them. Refuses while any of them is running.
	 */
	async deleteSessions(paths: string[], trash: (path: string) => Promise<void>): Promise<string[]> {
		for (const path of paths) {
			const live = this.live.get(path);
			if (live?.running) throw new Error(`"${this.titleFor(live)}" is still running. Stop it before deleting.`);
		}
		const deleted: string[] = [];
		for (const path of paths) {
			const live = this.live.get(path);
			const id = live?.session.sessionId ?? this.summaries.find((summary) => summary.path === path)?.id;
			if (live) this.unload(live);
			if (this.viewing === path) this.viewing = undefined;
			// A new session has no file until its first message.
			if (!path.startsWith("memory:") && existsSync(path)) await trash(path);
			if (id) {
				delete this.appIndex[id];
				await rm(join(triviumDir, "changes", `${id}.json`), { force: true });
			}
			deleted.push(path);
		}
		await this.saveIndex();
		this.scheduleList();
		return deleted;
	}

	/** Unloads a session from memory. Its file stays; opening it again reloads it. */
	private unload(live: Live): void {
		this.broker.cancelAll(live.path);
		live.unsubscribe();
		live.session.dispose();
		this.live.delete(live.path);
	}

	private unloadIdle(): void {
		const minutes = this.settings.get().idleMinutes;
		if (!minutes) return;
		const cutoff = Date.now() - minutes * 60_000;
		const paths: string[] = [];
		for (const live of this.live.values()) {
			if (live.running || live.path === this.viewing || live.lastActive > cutoff || live.path.startsWith("memory:")) continue;
			this.unload(live);
			paths.push(live.path);
		}
		if (paths.length) this.emit({ type: "unloaded", paths });
	}

	/** Reloads an app's idle sessions so extension and model settings take effect. Running sessions keep their setup. */
	reloadApp(app: AppId): string[] {
		const paths: string[] = [];
		for (const live of [...this.live.values()]) {
			if (live.app !== app || live.running || live.path.startsWith("memory:")) continue;
			this.unload(live);
			paths.push(live.path);
		}
		if (paths.length) this.emit({ type: "unloaded", paths });
		return paths;
	}

	/** What a new session in this app would load, with every extension pi finds, on or off. */
	async describeApp(app: AppId): Promise<AppDetails> {
		const projectDir = this.summaries.find((summary) => summary.app === app && summary.cwd)?.cwd ?? homedir();
		const settingsManager = SettingsManager.create(projectDir, this.agentDir);
		const loader = this.resourceLoader(app, projectDir, settingsManager, { keepDisabled: true });
		await loader.reload();
		const profile = profileInfo(app);
		const appSettings = this.settings.app(app);
		const disabled = new Set(appSettings.disabled);
		const added = new Set(appSettings.added);
		const sourceOf = (path: string, extension?: Extension): ExtensionSource => {
			if (path === devFaux) return "Dev";
			if (path.startsWith(profile.extensionDir + sep)) return "App";
			if ([...added].some((entry) => path === entry || path.startsWith(entry + sep))) return "Added";
			if (path.startsWith("builtin:")) return "Built-in";
			if (extension?.sourceInfo.origin === "package") return "Package";
			if (extension?.sourceInfo.scope === "project") return "Project";
			return "Global";
		};
		const result = loader.getExtensions();
		const extensions: ExtensionInfo[] = result.extensions
			.filter((extension) => !extension.hidden && !extension.path.startsWith("<"))
			.map((extension) => ({
				path: extension.resolvedPath,
				name: extensionName(extension.resolvedPath),
				display:
					extension.sourceInfo.origin === "package" ? extension.sourceInfo.source : shortPath(extension.resolvedPath),
				source: sourceOf(extension.resolvedPath, extension),
				on: !disabled.has(extension.resolvedPath),
				registers: registers(extension),
			}));
		for (const error of result.errors) {
			extensions.push({
				path: error.path,
				name: extensionName(error.path),
				display: shortPath(error.path),
				source: sourceOf(error.path),
				on: !disabled.has(error.path),
				registers: [],
				error: error.error,
			});
		}
		const order: ExtensionSource[] = ["App", "Added", "Global", "Package", "Project", "Built-in", "Dev"];
		extensions.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
		const lives = [...this.live.values()].filter((live) => live.app === app);
		return {
			id: app,
			extensionDir: profile.extensionDir,
			projectDir,
			extensions,
			tools: profile.tools,
			skills: loader.getSkills().skills.length,
			prompts: loader.getPrompts().prompts.length,
			systemPrompt: profileFor(app).appendSystemPrompt,
			running: lives.filter((live) => live.running).length,
			loaded: lives.length,
		};
	}

	dispose(): void {
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.broker.cancelAll();
		for (const live of this.live.values()) {
			live.unsubscribe();
			live.session.dispose();
		}
		this.live.clear();
	}

	private resourceLoader(
		app: AppId,
		cwd: string,
		settingsManager: SettingsManager,
		options: { keepDisabled?: boolean; factories?: InlineExtension[] } = {},
	): DefaultResourceLoader {
		const profile = profileFor(app);
		const appSettings = this.settings.app(app);
		const extensions = [...profile.extensions, ...appSettings.added.filter((path) => existsSync(path))];
		if (process.env.TRIVIUM_DEV_FAUX) extensions.push(devFaux);
		const disabled = new Set(appSettings.disabled);
		const appendPrompt = profile.appendSystemPrompt;
		return new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			additionalExtensionPaths: extensions,
			appendSystemPromptOverride: appendPrompt ? (base) => [...base, appendPrompt] : undefined,
			extensionFactories: options.factories,
			// Extensions turned off for this app still load from pi's discovery; drop them here.
			extensionsOverride:
				options.keepDisabled || disabled.size === 0
					? undefined
					: (base) => {
							const off = base.extensions.filter((extension) => disabled.has(extension.resolvedPath));
							const offPaths = new Set(off.flatMap((extension) => [extension.path, extension.resolvedPath]));
							// Providers an extension registered while loading are queued separately; drop those too.
							base.runtime.pendingProviderRegistrations = base.runtime.pendingProviderRegistrations.filter(
								(registration) => !offPaths.has(registration.extensionPath),
							);
							return {
								...base,
								extensions: base.extensions.filter((extension) => !offPaths.has(extension.resolvedPath)),
								errors: base.errors.filter((error) => !disabled.has(error.path)),
							};
						},
		});
	}

	private async start(app: AppId, cwd: string, sessionManager: SessionManager, isNew = false): Promise<Live> {
		const profile = profileFor(app);
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		const changes = new ChangeTracker(join(triviumDir, "changes", `${sessionManager.getSessionId()}.json`), cwd);
		const resourceLoader = this.resourceLoader(app, cwd, settingsManager, {
			factories: [
				(pi) => {
					// Record each file before the agent first changes it, for the Changes panel.
					pi.on("tool_call", async (event) => {
						const target = (event.input as { path?: unknown }).path;
						if ((event.toolName === "edit" || event.toolName === "write") && typeof target === "string") {
							await changes.capture(target);
						}
					});
				},
			],
		});
		await resourceLoader.reload();
		// A new session starts on the app's model when one is set; a reopened session keeps its own.
		const appSettings = this.settings.app(app);
		const slash = appSettings.model?.indexOf("/") ?? -1;
		const model =
			isNew && appSettings.model && slash > 0
				? this.modelRuntime.getModel(appSettings.model.slice(0, slash), appSettings.model.slice(slash + 1))
				: undefined;
		const { session } = await createAgentSession({
			cwd,
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager,
			tools: profile.tools,
			model,
			thinkingLevel: model ? (appSettings.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]) : undefined,
		});
		const path = session.sessionFile ?? `memory:${randomUUID()}`;
		const live: Live = {
			path,
			app,
			cwd,
			session,
			tracker: new RunTracker(session.messages),
			changes,
			running: false,
			unread: false,
			unsubscribe: () => {},
			sentRuns: 0,
			lastActive: Date.now(),
		};
		live.sentRuns = live.tracker.length;
		this.live.set(path, live);
		await session.bindExtensions({
			uiContext: createUiContext(this.broker, () => path, (message, level) => this.notice(message, level)),
			mode: "rpc",
			onError: (error) => this.notice(`${error.extensionPath}: ${error.error}`, "error"),
		});
		live.unsubscribe = session.subscribe((event) => this.onEvent(live, event));
		return live;
	}

	private onEvent(live: Live, event: AgentSessionEvent): void {
		live.lastActive = Date.now();
		if (live.tracker.apply(event)) this.scheduleFlush(live, event.type === "message_start");
		switch (event.type) {
			case "agent_start":
				live.running = true;
				this.emitStatus(live);
				this.scheduleList();
				break;
			case "agent_settled":
				live.running = false;
				live.unread = this.viewing !== live.path;
				this.onDone(live.path, this.titleFor(live));
				this.flush(live);
				this.emitStatus(live);
				this.scheduleList();
				break;
			case "tool_execution_end":
				if (event.toolName === "edit" || event.toolName === "write") {
					void this.emitChanges(live).catch((error: unknown) => this.notice(String(error), "error"));
				}
				break;
			case "queue_update":
			case "message_end":
			case "compaction_end":
				this.emitStatus(live);
				break;
			case "session_info_changed":
				this.emitStatus(live);
				this.scheduleList();
				break;
		}
	}

	private scheduleFlush(live: Live, immediate: boolean): void {
		if (immediate) {
			this.flush(live);
			return;
		}
		live.flushTimer ??= setTimeout(() => this.flush(live), FLUSH_MS);
	}

	private flush(live: Live): void {
		if (live.flushTimer) clearTimeout(live.flushTimer);
		live.flushTimer = undefined;
		const current = live.tracker.current();
		if (!current) return;
		// A run that started since the last flush means earlier runs may have changed too.
		if (current.index > live.sentRuns) {
			const all = live.tracker.all();
			for (let index = live.sentRuns; index < all.length; index++) {
				this.emit({ type: "run", path: live.path, index, run: all[index]! });
			}
		} else {
			this.emit({ type: "run", path: live.path, index: current.index, run: current.run });
		}
		live.sentRuns = current.index;
	}

	private scheduleList(): void {
		if (this.listTimer) return;
		this.listTimer = setTimeout(() => {
			this.listTimer = undefined;
			void this.listSessions()
				.then((sessions) => this.emit({ type: "sessions", sessions }))
				.catch((error: unknown) => this.notice(String(error), "error"));
		}, 150);
	}

	private emitStatus(live: Live): void {
		this.emit({
			type: "status",
			path: live.path,
			running: live.running,
			context: this.contextOf(live),
			queue: this.queueOf(live),
			title: this.titleFor(live),
		});
	}

	private view(live: Live, changes: FileChange[]): SessionView {
		const { session } = live;
		live.sentRuns = Math.max(0, live.tracker.length - 1);
		return {
			path: live.path,
			id: session.sessionId,
			cwd: live.cwd,
			app: live.app,
			title: this.titleFor(live),
			runs: live.tracker.all(),
			running: live.running,
			model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			thinkingLevel: session.thinkingLevel,
			context: this.contextOf(live),
			queue: this.queueOf(live),
			changes,
		};
	}

	private titleFor(live: Live): string {
		return live.session.sessionName ?? titleOf(live.tracker.all()[0]?.prompt);
	}

	private queueOf(live: Live): QueueInfo {
		return {
			steering: [...live.session.getSteeringMessages()],
			followUp: [...live.session.getFollowUpMessages()],
		};
	}

	private contextOf(live: Live): ContextInfo | undefined {
		const { session } = live;
		const usage = session.getContextUsage();
		if (!usage) return undefined;
		const active = new Set(session.getActiveToolNames());
		const tools = session
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
		// Roughly four characters per token: good enough for a breakdown, not for billing.
		const systemTokens = Math.ceil((session.systemPrompt.length + JSON.stringify(tools).length) / 4);
		const compaction = session.settingsManager.getCompactionSettings(session.model);
		return {
			tokens: usage.tokens,
			window: usage.contextWindow,
			systemTokens,
			compactAt: compaction.enabled
				? Math.round(((usage.contextWindow - compaction.reserveTokens) / usage.contextWindow) * 100)
				: null,
		};
	}

	private notice(message: string, level: "info" | "warning" | "error"): void {
		this.emit({ type: "notice", notice: { id: randomUUID(), message, level } });
	}

	private require(path: string): Live {
		const live = this.live.get(path);
		if (!live) throw new Error("This session is not open.");
		return live;
	}

	private async saveIndex(): Promise<void> {
		const tmp = `${this.indexFile}.tmp`;
		await writeFile(tmp, JSON.stringify(this.appIndex, null, 2), { mode: 0o600 });
		await rename(tmp, this.indexFile);
	}
}
