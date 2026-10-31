import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createBashToolDefinition,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type Extension,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type InlineExtension,
	DefaultPackageManager,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	type SessionMessageEntry,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AppDetails,
	AppId,
	CompletionItem,
	ContextInfo,
	ExtensionInfo,
	ExtensionSource,
	FileChange,
	FileReview,
	GitDiff,
	GitFile,
	GitStatus,
	HostEvent,
	ModelOption,
	NewSessionInput,
	PermissionSettings,
	QueueInfo,
	SessionSummary,
	SessionView,
	SlashCommand,
	TrustChoice,
} from "../shared/protocol.ts";
import { APP_IDS } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { chatsDir, profileFor, profileInfo, triviumDir } from "./apps.ts";
import type { ServiceTracker } from "./services.ts";
import { activeBuiltIns, dropClashingBuiltIns } from "./builtin-packages.ts";
import { permissionGate } from "./permission-gate.ts";
import { DEFAULT_PERMISSION_MODE } from "../shared/permissions.ts";
import { packageName } from "../shared/packages.ts";
import { ChangeTracker } from "./changes.ts";
import { readGitDiff, readGitStatus } from "./git.ts";
import { isInside } from "./reader.ts";
import type { ExportInfo } from "./export.ts";
import { createUiContext, type DialogBroker } from "./dialogs.ts";
import type { SettingsStore } from "./settings.ts";
import { attachmentsOf, branchMessages, type MessageFile, messageFiles, RunTracker, splitAttachments, type Thumbnail } from "./transcript.ts";

interface Live {
	path: string;
	app: AppId;
	cwd: string;
	session: AgentSession;
	tracker: RunTracker;
	changes: ChangeTracker;
	running: boolean;
	/** Between compaction_start and compaction_end, whether started by /compact or automatically. */
	compacting: boolean;
	unread: boolean;
	unsubscribe: () => void;
	flushTimer?: ReturnType<typeof setTimeout>;
	sentRuns: number;
	lastActive: number;
	/** The git status last sent to the renderer, as JSON, so an unchanged one is not sent again. */
	git?: string;
	gitTimer?: ReturnType<typeof setTimeout>;
	/** When the reply being written sent its first token. */
	firstTokenAt?: number;
}

/** A session forked before a message, and that message taken back out to edit and send. */
export interface Rewound {
	view: SessionView;
	prompt: string;
	files: MessageFile[];
}

type UserEntry = SessionMessageEntry & { message: Extract<AgentMessage, { role: "user" }> };

const FLUSH_MS = 40;
/** Several tool calls in a row read git once. */
const GIT_MS = 300;
const devFaux = fileURLToPath(new URL("../dev/faux-extension.ts", import.meta.url));

function isChat(cwd: string): boolean {
	return Boolean(cwd) && resolve(cwd) === resolve(chatsDir);
}

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * A readable name: the file name without extension, or the folder name for index files. A package's
 * index often sits in a build folder such as dist; the package's own name says more, without its scope.
 */
function extensionName(path: string, packageSource?: string): string {
	if (path.includes(":") && !path.includes(sep)) return path.split(":").pop() ?? path;
	const file = basename(path).replace(/\.(ts|js|mjs)$/, "");
	const name = file === "index" ? basename(join(path, "..")) : file;
	if (packageSource && /^(src|dist|lib|bundle|build|out|extensions?)$/.test(name)) return packageName(packageSource).split("/").pop()!;
	return name;
}

/**
 * The extensions the pi CLI loads on its own: codemode, tool search and MCP. SDK sessions only get
 * them when asked. Marked built-in and replaceable like the CLI's, so pi's `extensions` setting can
 * turn them off and a third-party MCP extension can take over. Fresh per session, since each keeps
 * its own connections.
 */
function builtinExtensions(): InlineExtension[] {
	return [
		{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
		{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
		{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
	];
}

/** Commands Trivium handles itself, because pi's SDK leaves them to the terminal UI. */
const TRIVIUM_COMMANDS: SlashCommand[] = [
	{
		name: "compact",
		description: "Summarize the conversation so far to free up context",
		argumentHint: "[instructions]",
		source: "trivium",
		completes: false,
	},
	{ name: "name", description: "Rename this session", argumentHint: "<title>", source: "trivium", completes: false },
];

/** The description in a package's package.json, if it has one. */
async function packageDescription(dir: string | undefined): Promise<string | undefined> {
	if (!dir) return undefined;
	try {
		const { description } = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		return typeof description === "string" && description.trim() ? description.trim() : undefined;
	} catch {
		return undefined;
	}
}

function registers(extension: Extension): string[] {
	return [
		...[...extension.tools.keys()].map((name) => `tool ${name}`),
		...[...extension.commands.keys()].map((name) => `/${name}`),
		...[...extension.handlers.keys()].map((name) => `on ${name}`),
	];
}

/** The first line the user typed, without the <file> tags of attachments; their names when that is all there is. */
function titleOf(text: string | undefined): string {
	const { prompt, attachments } = splitAttachments(text ?? "");
	// A stored first message can be cut short inside a text file's tag; its name still makes a title.
	const cut = /^<file name="([^"]*)">/.exec(prompt.trimStart())?.[1]?.split(/[\\/]/).pop();
	const line = cut ?? (prompt.trim().split("\n")[0] || attachments?.map((file) => file.name).join(", ") || "");
	return line.length > 80 ? `${line.slice(0, 79)}…` : line || "New session";
}

/**
 * Owns every live pi session. Sessions keep running when the user switches
 * to another session or app; the renderer only chooses which one it shows.
 */
export class SessionHost {
	private live = new Map<string, Live>();
	private appIndex: Record<string, AppId> = {};
	/** Sessions unloaded before their first message was saved, so they can start again where they were. */
	private unsaved = new Map<string, { app: AppId; cwd: string }>();
	private summaries: SessionSummary[] = [];
	private modelRuntime!: ModelRuntime;
	private readonly agentDir = getAgentDir();
	/** The sessions on screen, as the window last said: their runs finish read, and they are never unloaded for being idle. */
	private viewing = new Set<string>();
	private listTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly emit: (event: HostEvent) => void;
	private readonly broker: DialogBroker;
	private readonly indexFile: string;
	private readonly settings: SettingsStore;
	private readonly onDone: (path: string, title: string) => void;
	private readonly thumbnail: Thumbnail | undefined;
	private readonly services: ServiceTracker;
	private idleTimer: ReturnType<typeof setInterval> | undefined;
	private trustStore!: ProjectTrustStore;
	/** Decisions made for this run of the app only. */
	private sessionTrust = new Map<string, boolean>();
	/** One question per project, shared by sessions that start while it is open. */
	private trustAsks = new Map<string, Promise<boolean>>();
	private trustAnswers = new Map<string, { cwd: string; resolve: (choice: TrustChoice | undefined) => void }>();
	/** Extension info and warnings already shown in this run of the app, such as pi-memory's qmd setup at every session start. */
	private extensionNotices = new Set<string>();

	constructor(options: {
		emit: (event: HostEvent) => void;
		broker: DialogBroker;
		indexFile: string;
		settings: SettingsStore;
		/** Called when a run settles, for system notifications. */
		onDone: (path: string, title: string) => void;
		/** Previews for images in the transcript. */
		thumbnail?: Thumbnail;
		/** Runs agent commands and keeps the processes they leave running. */
		services: ServiceTracker;
	}) {
		this.emit = options.emit;
		this.broker = options.broker;
		this.indexFile = options.indexFile;
		this.settings = options.settings;
		this.onDone = options.onDone;
		this.thumbnail = options.thumbnail;
		this.services = options.services;
	}

	get runtime(): ModelRuntime {
		return this.modelRuntime;
	}

	async init(): Promise<void> {
		this.modelRuntime = await ModelRuntime.create();
		this.trustStore = new ProjectTrustStore(this.agentDir);
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
				chat: isChat(info.cwd),
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
				chat: isChat(live.cwd),
			});
		}
		summaries.sort((a, b) => b.modified - a.modified);
		this.summaries = summaries;
		return summaries;
	}

	recentProjects(): string[] {
		const seen = new Set<string>();
		for (const summary of this.summaries) if (summary.cwd && !summary.chat) seen.add(summary.cwd);
		return [...seen].slice(0, 8);
	}

	async listModels(): Promise<ModelOption[]> {
		const hidden = new Set(this.settings.get().hiddenModels);
		const models = (await this.modelRuntime.getAvailable()).filter((model) => !hidden.has(`${model.provider}/${model.id}`));
		return models.map((model) => ({
			key: `${model.provider}/${model.id}`,
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
			thinkingLevels: getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]),
			images: Boolean((model as { input?: string[] }).input?.includes("image")),
		}));
	}

	setVisible(paths: string[]): void {
		this.viewing = new Set(paths);
	}

	async openSession(path: string): Promise<SessionView> {
		let live = this.live.get(path);
		if (live) live.lastActive = Date.now();
		if (!live) {
			const unsaved = this.unsaved.get(path);
			// pi would start a new, empty session at a path that is gone, and it would show under Code.
			if (!unsaved && !existsSync(path)) throw new Error(t("This session no longer exists."));
			const manager = SessionManager.open(path, undefined, unsaved?.cwd);
			const app = unsaved?.app ?? this.appIndex[manager.getSessionId()] ?? "code";
			live = await this.start(app, manager.getCwd(), manager);
			if (unsaved) {
				this.unsaved.delete(path);
				this.appIndex[manager.getSessionId()] = app;
				await this.saveIndex();
			}
		}
		if (live.unread) {
			live.unread = false;
			this.scheduleList();
		}
		return this.view(live, await live.changes.list());
	}

	async newSession(input: NewSessionInput): Promise<SessionView> {
		const cwd = input.cwd ?? chatsDir;
		if (!input.cwd) mkdirSync(chatsDir, { recursive: true });
		const live = await this.start(input.app, cwd, SessionManager.create(cwd), true);
		this.appIndex[live.session.sessionId] = input.app;
		await this.saveIndex();
		if (input.message?.trim()) await this.send(live.path, input.message, "prompt");
		this.scheduleList();
		return this.view(live, []);
	}

	async send(
		path: string,
		text: string,
		mode: "prompt" | "steer" | "followUp",
		attachments?: { prefix: string; images: ImageContent[] },
	): Promise<void> {
		const live = this.require(path);
		const { session } = live;
		if (text.startsWith("/") && !attachments?.prefix) {
			this.runCommand(live, text, mode);
			return;
		}
		// Attached files go in front of the message as <file> tags, like pi's CLI sends them.
		const message = (attachments?.prefix ?? "") + text;
		const images = attachments?.images.length ? attachments.images : undefined;
		if (mode === "steer") {
			await session.steer(message, images);
			return;
		}
		// A message sent while a run is going waits for the run to finish.
		if (mode === "followUp" || live.running) {
			await session.followUp(message, images);
			return;
		}
		// prompt() resolves when the run finishes, so the run continues in the background.
		void session.prompt(message, { images }).catch((error: unknown) => {
			this.notice(error instanceof Error ? error.message : String(error), "error");
		});
	}

	/**
	 * Sends a new version of an earlier message: the conversation goes back to just before it, then the new
	 * text goes out with the files and images the original carried. pi keeps the replies that followed on
	 * their own branch of the session file. Files on disk stay as they are.
	 */
	async editMessage(path: string, index: number, text: string): Promise<void> {
		const live = this.require(path);
		if (live.running) throw new Error(t("Stop the run before editing an earlier message."));
		const entry = this.userEntry(live, index);
		const original = attachmentsOf(entry.message.content);
		const attached = original.prefix || original.images.length ? original : undefined;
		if (!text.trim() && !attached) throw new Error(t("Write a message to send."));
		const result = await live.session.navigateTree(entry.id);
		if (result.cancelled) return;
		live.tracker = new RunTracker(branchMessages(live.session.sessionManager.getBranch()), this.thumbnail);
		// The shorter transcript must reach the window before the new run's events do.
		this.emit({ type: "view", view: this.view(live, await live.changes.list()) });
		this.scheduleList();
		await this.send(path, text, "prompt", attached);
	}

	/**
	 * Copies the conversation before a run's message into a new session in the same project, and shows that
	 * one with the message ready to edit. This session stays as it is, and keeps running if it was.
	 */
	async fork(path: string, index: number): Promise<Rewound | undefined> {
		const live = this.require(path);
		const entry = this.userEntry(live, index);
		const runner = live.session.extensionRunner;
		if (runner.hasHandlers("session_before_fork")) {
			const result = await runner.emit({ type: "session_before_fork", entryId: entry.id, position: "before" });
			if (result?.cancel) return undefined;
		}
		if (!existsSync(path)) throw new Error(t("This session has not been saved yet. Send a message before forking it."));
		// A second manager on the same file, as pi's own fork does, so the live session is left alone.
		const source = SessionManager.open(path);
		let manager = source;
		if (entry.parentId) {
			source.createBranchedSession(entry.parentId);
		} else {
			manager = SessionManager.create(live.cwd, source.getSessionDir());
			manager.newSession({ parentSession: path });
		}
		const forked = await this.start(live.app, manager.getCwd(), manager);
		this.appIndex[forked.session.sessionId] = live.app;
		await this.saveIndex();
		this.scheduleList();
		return { view: this.view(forked, []), ...messageFiles(entry.message.content) };
	}

	/** The user message a run began with, on the session's current branch. */
	private userEntry(live: Live, index: number): UserEntry {
		const wanted = live.tracker.userMessage(index);
		// Counted from the end of the branch, which the transcript holds in full.
		const entries = live.session.sessionManager
			.getBranch()
			.filter((entry): entry is UserEntry => entry.type === "message" && entry.message.role === "user");
		const entry = wanted ? entries[entries.length - 1 - wanted.later] : undefined;
		if (!entry || splitAttachments(entry.message.content).prompt !== wanted?.prompt) {
			throw new Error(t("That message is no longer in this session."));
		}
		return entry;
	}

	/**
	 * Trivium's own commands run here. Everything else starting with "/" goes through prompt(),
	 * which runs extension commands at once, even mid-run, and expands prompt templates and skills.
	 * steer() would reject an extension command.
	 */
	private runCommand(live: Live, text: string, mode: "prompt" | "steer" | "followUp"): void {
		const { session } = live;
		const [, name = "", args = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
		const fail = (error: unknown) => this.notice(error instanceof Error ? error.message : String(error), "error");
		if (name === "compact") {
			if (live.running) throw new Error(t("Wait for the run to finish, or stop it, before compacting."));
			// compaction_start and compaction_end show the progress and the outcome, as they do for automatic compaction.
			void session.compact(args.trim() || undefined).catch(() => {});
			return;
		}
		if (name === "name") {
			if (!args.trim()) throw new Error(t("Give the session a name: /name <title>"));
			session.setSessionName(args.trim());
			return;
		}
		const options = live.running ? { streamingBehavior: mode === "steer" ? ("steer" as const) : ("followUp" as const) } : undefined;
		void session.prompt(text, options).catch(fail);
	}

	commands(path: string): SlashCommand[] {
		const { session } = this.require(path);
		const commands: SlashCommand[] = [...TRIVIUM_COMMANDS];
		const taken = new Set(commands.map((command) => command.name));
		const add = (command: SlashCommand) => {
			if (taken.has(command.name)) return;
			taken.add(command.name);
			commands.push(command);
		};
		for (const command of session.extensionRunner.getRegisteredCommands()) {
			add({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				completes: Boolean(command.getArgumentCompletions),
			});
		}
		for (const template of session.promptTemplates) {
			add({
				name: template.name,
				description: template.description,
				argumentHint: template.argumentHint,
				source: "prompt",
				completes: false,
			});
		}
		for (const skill of session.resourceLoader.getSkills().skills) {
			add({ name: `skill:${skill.name}`, description: skill.description, source: "skill", completes: false });
		}
		return commands;
	}

	async completeCommand(path: string, name: string, prefix: string): Promise<CompletionItem[]> {
		const { session } = this.require(path);
		const command = session.extensionRunner.getRegisteredCommands().find((c) => c.invocationName === name);
		if (!command?.getArgumentCompletions) return [];
		try {
			const items = await command.getArgumentCompletions(prefix);
			return (items ?? []).map((item) => ({ value: item.value, label: item.label, description: item.description }));
		} catch {
			// A failing completion source only means no suggestions.
			return [];
		}
	}

	async abort(path: string): Promise<void> {
		await this.require(path).session.abort();
	}

	async setModel(path: string, modelKey: string, thinkingLevel: string): Promise<void> {
		const { session } = this.require(path);
		const slash = modelKey.indexOf("/");
		const model = this.modelRuntime.getModel(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(t("Unknown model {model}", { model: modelKey }));
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
		if (live.running) throw new Error(t("Stop the run before reverting its changes."));
		await live.changes.revert(files);
		return this.emitChanges(live);
	}

	/** A transcript image of this session, by the id the transcript gave it. */
	image(path: string, id: string): { data: string; mimeType: string } {
		const image = this.require(path).tracker.image(id);
		if (!image) throw new Error(t("That image is no longer in this session."));
		return image;
	}

	async readChangedFile(path: string, file: string): Promise<string> {
		const live = this.require(path);
		// Only files this session changed, so the renderer cannot read arbitrary paths.
		if (!live.changes.has(file)) throw new Error(t("This session did not change that file."));
		return existsSync(file) ? readFile(file, "utf8") : "";
	}

	/** The project folder a session works in. */
	cwdOf(path: string): string {
		return this.require(path).cwd;
	}

	/**
	 * A file the Preview panel may show: one in the session's project, or one this session changed. Resolves
	 * it past any links, with the folder its page may load from and the name the panel gives it.
	 */
	async previewTarget(path: string, file: string): Promise<{ file: string; root: string; rel: string }> {
		const live = this.require(path);
		const absolute = isAbsolute(file) ? file : resolve(live.cwd, file);
		const real = await realpath(absolute).catch(() => {
			throw new Error(t("There's no file at {path}.", { path: file }));
		});
		const project = isChat(live.cwd) ? undefined : await realpath(live.cwd).catch(() => undefined);
		if (project && isInside(project, real)) return { file: real, root: project, rel: relative(project, real).split(sep).join("/") };
		if (live.changes.has(absolute) || live.changes.has(real)) return { file: real, root: dirname(real), rel: real };
		throw new Error(t("Only files in this session's project can be previewed."));
	}

	reviewFile(path: string, file: string): Promise<FileReview> {
		return this.require(path).changes.review(file);
	}

	async resolveChange(
		path: string,
		file: string,
		id: number,
		action: "accept" | "reject",
		expect: { del: string; ins: string },
	): Promise<FileReview> {
		const live = this.require(path);
		if (live.running && action === "reject") throw new Error(t("Stop the run before rejecting changes."));
		const review = await live.changes.resolve(file, id, action, expect);
		await this.emitChanges(live);
		return review;
	}

	private async emitChanges(live: Live): Promise<FileChange[]> {
		const changes = await live.changes.list();
		this.emit({ type: "changes", path: live.path, changes });
		this.scheduleGit(live);
		return changes;
	}

	/** Chats and the Research and Write apps have no repository to show. */
	private hasGit(live: Live): boolean {
		return live.app === "code" && !isChat(live.cwd);
	}

	async gitStatus(path: string): Promise<GitStatus | null> {
		const live = this.require(path);
		const git = this.hasGit(live) ? await readGitStatus(live.cwd) : null;
		live.git = JSON.stringify(git);
		return git;
	}

	async gitDiff(path: string, file: Pick<GitFile, "rel" | "area">): Promise<GitDiff> {
		const live = this.require(path);
		const git = this.hasGit(live) ? await readGitStatus(live.cwd) : null;
		// Only files git lists as changed, so the renderer cannot read arbitrary paths.
		const listed = git?.files.find((f) => f.rel === file.rel && f.area === file.area);
		if (!git || !listed) {
			this.scheduleGit(live);
			throw new Error(t("That file has no changes any more."));
		}
		return readGitDiff(git.root, listed);
	}

	/** Reads git again once files may have changed, and sends the status when it differs from the last one. */
	private scheduleGit(live: Live): void {
		if (!this.hasGit(live) || live.gitTimer) return;
		live.gitTimer = setTimeout(() => {
			live.gitTimer = undefined;
			if (!this.live.has(live.path)) return;
			readGitStatus(live.cwd)
				.then((git) => {
					const text = JSON.stringify(git);
					if (text === live.git) return;
					live.git = text;
					this.emit({ type: "git", path: live.path, git });
				})
				// The last status stays up; the next run or window focus reads again.
				.catch(() => {});
		}, GIT_MS);
	}

	/** The conversation on a session's current branch, read from its file, for export. Compacted messages are kept. */
	exportInfo(path: string): ExportInfo {
		const manager = SessionManager.open(path);
		const title = this.summaries.find((summary) => summary.path === path)?.title ?? manager.getSessionName() ?? "Session";
		return { title, id: manager.getSessionId(), cwd: manager.getCwd(), messages: branchMessages(manager.getBranch()) };
	}

	/**
	 * Deletes sessions: unloads them, stops the services they left running, moves their files with `trash`
	 * (the system Trash), and drops Trivium's own records of them. Refuses while any of them is running.
	 */
	async deleteSessions(paths: string[], trash: (path: string) => Promise<void>): Promise<string[]> {
		for (const path of paths) {
			const live = this.live.get(path);
			if (live?.running) throw new Error(t("“{title}” is still running. Stop it before deleting.", { title: this.titleFor(live) }));
		}
		const deleted: string[] = [];
		for (const path of paths) {
			const live = this.live.get(path);
			const id = live?.session.sessionId ?? this.summaries.find((summary) => summary.path === path)?.id;
			if (live) this.unload(live);
			await this.services.stopSession(path);
			this.unsaved.delete(path);
			this.viewing.delete(path);
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

	/** Unloads a session from memory. Its file stays; opening it again reloads it. Its services keep running. */
	private unload(live: Live): void {
		this.broker.cancelAll(live.path);
		clearTimeout(live.gitTimer);
		live.unsubscribe();
		live.session.dispose();
		this.live.delete(live.path);
		if (!live.path.startsWith("memory:") && !existsSync(live.path)) this.unsaved.set(live.path, { app: live.app, cwd: live.cwd });
	}

	private unloadIdle(): void {
		const minutes = this.settings.get().idleMinutes;
		if (!minutes) return;
		const cutoff = Date.now() - minutes * 60_000;
		const paths: string[] = [];
		for (const live of this.live.values()) {
			if (live.running || this.viewing.has(live.path) || live.lastActive > cutoff || live.path.startsWith("memory:")) continue;
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

	/**
	 * Whether to load a project's own .pi settings, extensions, skills, prompts and MCP servers.
	 * Follows pi's CLI: a decision saved in pi's trust.json, then the defaultProjectTrust setting,
	 * then a question. Projects with nothing in .pi need no decision.
	 */
	private projectTrusted(cwd: string, ask: boolean): Promise<boolean> {
		if (!hasTrustRequiringProjectResources(cwd)) return Promise.resolve(true);
		const known = this.sessionTrust.get(cwd) ?? this.trustStore.get(cwd);
		if (known !== null && known !== undefined) return Promise.resolve(known);
		const fallback = SettingsManager.create(homedir(), this.agentDir).getDefaultProjectTrust();
		if (fallback === "always") return Promise.resolve(true);
		if (fallback === "never" || !ask) return Promise.resolve(false);
		const pending = this.trustAsks.get(cwd);
		if (pending) return pending;
		const id = randomUUID();
		const asked = new Promise<boolean>((resolve) => {
			this.trustAnswers.set(id, {
				cwd,
				resolve: (choice) => {
					this.trustAnswers.delete(id);
					this.trustAsks.delete(cwd);
					this.emit({ type: "trust_closed", id });
					if (choice === "trust") this.trustStore.set(cwd, true);
					else if (choice === "never") this.trustStore.set(cwd, false);
					else this.sessionTrust.set(cwd, choice === "once");
					resolve(choice === "trust" || choice === "once");
				},
			});
		});
		this.trustAsks.set(cwd, asked);
		const resources = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes"].filter((entry) =>
			existsSync(join(cwd, ".pi", entry)),
		);
		this.emit({ type: "trust", request: { id, cwd, resources } });
		return asked;
	}

	answerTrust(id: string, choice: TrustChoice): void {
		this.trustAnswers.get(id)?.resolve(choice);
	}

	/**
	 * Installs a pi package as `pi install` does: fetched from npm, git or a URL and recorded in pi's own
	 * settings, so every app and the pi CLI load it. Each app can still turn its extensions off.
	 */
	async installPackage(source: string): Promise<void> {
		const settingsManager = SettingsManager.create(homedir(), this.agentDir, { projectTrusted: false });
		const manager = new DefaultPackageManager({ cwd: homedir(), agentDir: this.agentDir, settingsManager });
		try {
			await manager.installAndPersist(source);
		} catch (error) {
			// pi reports only the command and its exit code; npm and git print the reason to the console.
			const message = error instanceof Error ? error.message : String(error);
			const tool = /\bspawn (npm|git)\b.*ENOENT/i.exec(message)?.[1] ?? (/ENOENT/.test(message) ? /^(npm|git)\b/.exec(message)?.[1] : undefined);
			if (tool) throw new Error(t("Installing {source} needs {tool}, and it isn't installed or isn't on your PATH.", { source, tool }));
			if (/^npm install /.test(message)) throw new Error(t("npm couldn't install {name}. Check the package name and your network connection.", { name: source.replace(/^npm:/, "") }));
			if (/^git clone /.test(message)) throw new Error(t("git couldn't clone {name}. Check the address and that you can access the repository.", { name: source.replace(/^git:/, "") }));
			throw error;
		}
		await settingsManager.flush();
		const [failed] = settingsManager.drainErrors();
		if (failed) throw new Error(t("Installed, but pi's settings could not be saved: {error}", { error: failed.error.message }));
	}

	/** What a new session in this app would load, with every extension pi finds, on or off. */
	async describeApp(app: AppId): Promise<AppDetails> {
		const projectDir = this.summaries.find((summary) => summary.app === app && summary.cwd)?.cwd ?? homedir();
		const settingsManager = SettingsManager.create(projectDir, this.agentDir, { projectTrusted: false });
		const loader = this.resourceLoader(app, projectDir, settingsManager, { keepDisabled: true });
		// Settings shows what would load without asking; an undecided project counts as untrusted.
		await loader.reload({ resolveProjectTrust: () => this.projectTrusted(projectDir, false) });
		const profile = profileInfo(app);
		const appSettings = this.settings.app(app);
		const disabled = new Set(appSettings.disabled);
		const added = new Set(appSettings.added);
		const builtIns = activeBuiltIns(app, appSettings.removed, settingsManager.getPackages());
		const builtInOf = (path: string) => builtIns.find((entry) => path.startsWith(entry.dir + sep))?.name;
		const sourceOf = (path: string, extension?: Extension): ExtensionSource => {
			if (path === devFaux) return "Dev";
			if (path.startsWith(profile.extensionDir + sep)) return "App";
			if (builtInOf(path)) return "Trivium";
			if ([...added].some((entry) => path === entry || path.startsWith(entry + sep))) return "Added";
			if (path.startsWith("builtin:")) return "Built-in";
			if (extension?.sourceInfo.origin === "package") return "Package";
			if (extension?.sourceInfo.scope === "project") return "Project";
			return "Global";
		};
		const result = loader.getExtensions();
		const extensions: ExtensionInfo[] = await Promise.all(
			result.extensions
				.filter((extension) => !extension.hidden && !extension.path.startsWith("<"))
				.map(async (extension) => {
					const builtIn = builtIns.find((entry) => extension.resolvedPath.startsWith(entry.dir + sep));
					const fromPackage = extension.sourceInfo.origin === "package";
					return {
						path: extension.resolvedPath,
						name: extensionName(extension.resolvedPath, builtIn?.name ?? (fromPackage ? extension.sourceInfo.source : undefined)),
						display: builtIn?.name ?? (fromPackage ? extension.sourceInfo.source : shortPath(extension.resolvedPath)),
						// pi sets baseDir to an installed package's root.
						description: await packageDescription(builtIn?.dir ?? (fromPackage ? extension.sourceInfo.baseDir : undefined)),
						source: sourceOf(extension.resolvedPath, extension),
						on: !disabled.has(extension.resolvedPath),
						registers: registers(extension),
						builtIn: builtIn?.name,
					};
				}),
		);
		for (const error of result.errors) {
			extensions.push({
				path: error.path,
				name: extensionName(error.path),
				display: shortPath(error.path),
				source: sourceOf(error.path),
				on: !disabled.has(error.path),
				registers: [],
				error: error.error,
				builtIn: builtInOf(error.path),
			});
		}
		const order: ExtensionSource[] = ["App", "Added", "Trivium", "Global", "Package", "Project", "Built-in", "Dev"];
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
			packages: new DefaultPackageManager({ cwd: projectDir, agentDir: this.agentDir, settingsManager })
				.listConfiguredPackages()
				.filter((entry) => entry.scope === "user")
				.map((entry) => entry.source),
			permissions: this.permissionsOf(app),
		};
	}

	dispose(): void {
		if (this.idleTimer) clearInterval(this.idleTimer);
		for (const pending of [...this.trustAnswers.values()]) pending.resolve(undefined);
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
		const builtIns = activeBuiltIns(app, appSettings.removed, settingsManager.getPackages());
		const extensions = [
			...profile.extensions,
			...builtIns.map((entry) => entry.dir),
			...appSettings.added.filter((path) => existsSync(path)),
		];
		// First, so its scripted subagent tool wins over pi-subagents' own, which registers the same name.
		if (process.env.TRIVIUM_DEV_FAUX) extensions.unshift(devFaux);
		const disabled = new Set(appSettings.disabled);
		const appendPrompt = profile.appendSystemPrompt;
		return new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			additionalExtensionPaths: extensions,
			appendSystemPromptOverride: appendPrompt ? (base) => [...base, appendPrompt] : undefined,
			extensionFactories: [...builtinExtensions(), ...(options.factories ?? [])],
			extensionsOverride: (loaded) => {
				// A shipped package gives way to the user's own extension with the same tools, unless that one is off here.
				const base = dropClashingBuiltIns(loaded, builtIns.map((entry) => entry.dir), disabled);
				if (options.keepDisabled || disabled.size === 0) return base;
				// Extensions turned off for this app still load from pi's discovery; drop them here.
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
		// Untrusted until the reload hook below decides: project settings must not apply before that.
		const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: false });
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
				...(app === "code" ? [{ name: "permissions", factory: permissionGate(() => this.permissionMode()) }] : []),
			],
		});
		// Global extensions load first; project resources only once the project is trusted.
		await resourceLoader.reload({ resolveProjectTrust: () => this.projectTrusted(cwd, true) });
		// A new session starts on the app's model when one is set; a reopened session keeps its own.
		const appSettings = this.settings.app(app);
		const slash = appSettings.model?.indexOf("/") ?? -1;
		// pi's bash tool, running commands so the processes they leave show as services. An extension's own bash wins.
		let sessionPath = "";
		const ownBash = resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("bash"));
		const shell = { shellPath: settingsManager.getShellPath(), commandPrefix: settingsManager.getShellCommandPrefix() };
		const customTools =
			profileInfo(app).tools.includes("bash") && !ownBash
				? [createBashToolDefinition(cwd, { ...shell, operations: this.services.bashOperations(() => sessionPath, shell) }) as ToolDefinition<any, any>]
				: undefined;
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
			customTools,
			model,
			thinkingLevel: model ? (appSettings.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]) : undefined,
		});
		const path = session.sessionFile ?? `memory:${randomUUID()}`;
		sessionPath = path;
		const live: Live = {
			path,
			app,
			cwd,
			session,
			// The whole branch rather than session.messages, so messages from before a compaction still show.
			tracker: new RunTracker(branchMessages(sessionManager.getBranch()), this.thumbnail),
			changes,
			running: false,
			compacting: false,
			unread: false,
			unsubscribe: () => {},
			sentRuns: 0,
			lastActive: Date.now(),
		};
		live.sentRuns = live.tracker.length;
		this.live.set(path, live);
		await session.bindExtensions({
			uiContext: createUiContext(this.broker, () => path, (message, level) => this.extensionNotice(message, level)),
			mode: "rpc",
			onError: (error) => this.notice(`${error.extensionPath}: ${error.error}`, "error"),
		});
		live.unsubscribe = session.subscribe((event) => this.onEvent(live, event));
		return live;
	}

	private onEvent(live: Live, event: AgentSessionEvent): void {
		live.lastActive = Date.now();
		// Before the tracker, so the finished reply it shows carries its first token's time.
		this.timeFirstToken(live, event);
		if (live.tracker.apply(event)) this.scheduleFlush(live, event.type === "message_start");
		switch (event.type) {
			case "agent_start":
				live.running = true;
				this.emitStatus(live);
				this.scheduleList();
				break;
			case "agent_settled":
				live.running = false;
				live.unread = !this.viewing.has(live.path);
				this.onDone(live.path, this.titleFor(live));
				this.flush(live);
				this.emitStatus(live);
				this.scheduleList();
				this.scheduleGit(live);
				break;
			case "tool_execution_end":
				if (event.toolName === "edit" || event.toolName === "write") {
					void this.emitChanges(live).catch((error: unknown) => this.notice(String(error), "error"));
				} else if (event.toolName === "bash") {
					// A command can change files, commit or switch branches.
					this.scheduleGit(live);
				}
				break;
			case "compaction_start":
				live.compacting = true;
				this.emitStatus(live);
				break;
			case "compaction_end":
				live.compacting = false;
				this.emitStatus(live);
				if (event.errorMessage) this.notice(event.errorMessage, "error");
				else if (event.result) this.notice(t("Conversation compacted"), "info");
				break;
			case "queue_update":
			case "message_end":
				this.emitStatus(live);
				break;
			case "session_info_changed":
				this.emitStatus(live);
				this.scheduleList();
				break;
		}
	}

	/**
	 * pi saves how long each reply took but not when its first token came, so it is noted here on the reply before pi
	 * saves it: listeners hear message_end before the session file is written. The usage page reads it back.
	 */
	private timeFirstToken(live: Live, event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "assistant") {
			live.firstTokenAt = undefined;
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			if (event.assistantMessageEvent.type.endsWith("_delta")) live.firstTokenAt ??= Date.now();
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as typeof event.message & { firstTokenMs?: number };
			if (live.firstTokenAt !== undefined && message.firstTokenMs === undefined) {
				message.firstTokenMs = Math.max(0, live.firstTokenAt - message.timestamp);
			}
			live.firstTokenAt = undefined;
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
			compacting: live.compacting,
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
			chat: isChat(live.cwd),
			app: live.app,
			title: this.titleFor(live),
			runs: live.tracker.all(),
			running: live.running,
			compacting: live.compacting,
			// pi uses an "unknown" placeholder when no model is configured; show that as no model.
			model:
				session.model && session.model.provider !== "unknown" ? `${session.model.provider}/${session.model.id}` : undefined,
			thinkingLevel: session.thinkingLevel,
			context: this.contextOf(live),
			queue: this.queueOf(live),
			changes,
			permissions: this.permissionsOf(live.app),
		};
	}

	private permissionMode() {
		return this.settings.get().permissionMode ?? DEFAULT_PERMISSION_MODE;
	}

	/** Code's sessions run behind the permission gate; the other apps have no bash and keep pi's own behavior. */
	private permissionsOf(app: AppId): PermissionSettings | undefined {
		return app === "code" ? { level: this.permissionMode() } : undefined;
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

	/** Errors always show; an extension repeating the same info or warning in every session shows it once. */
	private extensionNotice(message: string, level: "info" | "warning" | "error"): void {
		if (level !== "error") {
			if (this.extensionNotices.has(message)) return;
			this.extensionNotices.add(message);
		}
		this.notice(message, level);
	}

	private require(path: string): Live {
		const live = this.live.get(path);
		if (!live) throw new Error(t("This session is not open."));
		return live;
	}

	private async saveIndex(): Promise<void> {
		const tmp = `${this.indexFile}.tmp`;
		await writeFile(tmp, JSON.stringify(this.appIndex, null, 2), { mode: 0o600 });
		await rename(tmp, this.indexFile);
	}
}
