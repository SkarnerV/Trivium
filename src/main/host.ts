import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
	createEventBus,
	type EventBus,
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
	GitAction,
	GitCommitDetail,
	GitCommitFile,
	GitDiff,
	GitFile,
	GitHistory,
	GitStatus,
	HostEvent,
	ModelOption,
	NewSessionInput,
	PermissionSettings,
	ProjectFile,
	ProjectTree,
	QueueInfo,
	SendOutcome,
	SendResult,
	SessionStatus,
	SessionSummary,
	SessionView,
	SkillDraft,
	SkillImport,
	SkillInfo,
	SlashCommand,
	SubagentSession,
	TrustChoice,
} from "../shared/protocol.ts";
import { APP_IDS, type Run } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { chatsDir, profileFor, profileInfo, skillDir, triviumDir } from "./apps.ts";
import * as skillFiles from "./skills.ts";
import { type BackgroundEnd, endedMessage, LONG_COMMANDS_NAME, LONG_COMMANDS_PATH, withLongCommands } from "./long-commands.ts";
import type { ServiceTracker } from "./services.ts";
import { activeBuiltIns, dropClashingBuiltIns } from "./builtin-packages.ts";
import { onlyReads, permissionGate } from "./permission-gate.ts";
import { DEFAULT_PERMISSION_MODE } from "../shared/permissions.ts";
import { bindWithChildGate, CHILD_GATE_FILE } from "./session-binding.ts";
import { AgentCountWatch, agentsOf, BackgroundRuns, hasLiveAgents, markBackground } from "./background-runs.ts";
import { delegationHooks } from "./delegation-hooks.ts";
import { Dispatcher } from "./dispatch.ts";
import { HandoffCache } from "./handoffs.ts";
import { agentSteps } from "../shared/agent-counts.ts";
import { requestBackgroundStop, sessionUsage, stopTarget, subagentRpc, SUPERVISOR_TOOL } from "./subagents.ts";
import { handoffRoots } from "./extension-paths.ts";
import { WorkModeIndex, workModeExtension } from "./work-modes.ts";
import { writerLock, writerOf } from "./writer-lock.ts";
import { isWorkMode, type WorkModeId } from "../shared/work-modes.ts";
import { packageName } from "../shared/packages.ts";
import { ChangeTracker } from "./changes.ts";
import {
	commitChanges,
	discardFiles,
	draftSource,
	fetchRemotes,
	initRepo,
	addWorktree,
	listProjectFiles,
	pullBranch,
	pushBranch,
	readFileAtCommit,
	readGitCommit,
	readGitCommitDiff,
	readGitDiff,
	readGitHistory,
	readGitStatus,
	readProjectFile,
	stageFiles,
	undoLastCommit,
	unstageFiles,
	withSessionTrailer,
} from "./git.ts";
import { isInside } from "./reader.ts";
import type { ExportInfo } from "./export.ts";
import { createUiContext, type DialogBroker } from "./dialogs.ts";
import type { SettingsStore } from "./settings.ts";
import { attachmentsOf, branchMessages, type MessageFile, messageFiles, RunTracker, splitAttachments, type Thumbnail } from "./transcript.ts";

interface Live {
	/** pi's event bus for this session's extensions, which pi-subagents takes requests on. */
	events: EventBus;
	handoffs: HandoffCache;
	background: BackgroundRuns;
	agentWatch: AgentCountWatch;
	handoffSeen: Set<string>;
	path: string;
	app: AppId;
	cwd: string;
	session: AgentSession;
	tracker: RunTracker;
	changes: ChangeTracker;
	/** From agent_start to agent_settled. pi is busy from before that, which isRunning counts in. */
	running: boolean;
	/** Between compaction_start and compaction_end, whether started by /compact or automatically. */
	compacting: boolean;
	/** What the host is doing with it that unloading it would cut off, such as starting it or sending an edit. */
	holds: number;
	dispatcher: Dispatcher;
	unread: boolean;
	unsubscribe: () => void;
	flushTimer?: ReturnType<typeof setTimeout>;
	sentRuns: number;
	lastActive: number;
	/** The git status last sent to the renderer, as JSON, so an unchanged one is not sent again. */
	git?: string;
	gitTimer?: ReturnType<typeof setTimeout>;
	/** Set while a recount of this session's agents is waiting to run. */
	agentTimer?: ReturnType<typeof setTimeout>;
	/** When the reply being written sent its first token. */
	firstTokenAt?: number;
}

/** A session forked before a message, and that message taken back out to edit and send. */
export interface Rewound {
	view: SessionView;
	prompt: string;
	files: MessageFile[];
}

/** An edited message that did not go out once the conversation had gone back for it. */
export interface Unsent {
	outcome: "returned";
	status: SessionStatus;
	prompt: string;
	files: MessageFile[];
	/** Unset when the user stopped it. */
	error?: string;
}

type UserEntry = SessionMessageEntry & { message: Extract<AgentMessage, { role: "user" }> };

const FLUSH_MS = 40;
/** Several tool calls in a row read git once. */
const GIT_MS = 300;
/** A fan-out reports each child's progress many times a second; its agents are counted at most this often. */
const AGENTS_MS = 1000;
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
	private onDeleting?: (path: string) => Promise<void>;
	private onDeleted?: (path: string) => void;
	/** Sessions being loaded, so that opening one twice loads it once. */
	private loading = new Map<string, Promise<Live>>();
	private deleting = new Set<string>();
	/** Never starts over, so what a session said before it was unloaded counts as older than what it says once reopened. */
	private rev = 0;
	private appIndex: Record<string, AppId> = {};
	private workModes: WorkModeIndex;
	/** Sessions unloaded before their first message was saved, so they can start again where they were. */
	private unsaved = new Map<string, { app: AppId; cwd: string; workMode?: WorkModeId }>();
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
		/** Told when a session is being deleted, before its services stop, so what it launched lets go. */
		onDeleting?: (path: string) => Promise<void>;
		/** Told once a session's deletion is over. */
		onDeleted?: (path: string) => void;
	}) {
		this.onDeleting = options.onDeleting;
		this.onDeleted = options.onDeleted;
		this.emit = options.emit;
		this.broker = options.broker;
		this.indexFile = options.indexFile;
		this.workModes = new WorkModeIndex(join(dirname(options.indexFile), "session-work-modes.json"));
		this.settings = options.settings;
		this.onDone = options.onDone;
		this.thumbnail = options.thumbnail;
		this.services = options.services;
	}

	get runtime(): ModelRuntime {
		return this.modelRuntime;
	}

	async setWorkMode(path: string, mode: WorkModeId): Promise<void> {
		const live = this.require(path);
		if (live.app !== "code" || isChat(live.cwd) || !isWorkMode(mode)) return;
		await this.workModes.set(live.session.sessionId, mode);
		const now = this.live.get(path);
		if (now) await this.emitView(now);
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
		const archived = new Set(this.settings.get().archivedSessions);
		const summaries: SessionSummary[] = infos.map((info) => {
			const live = this.live.get(info.path);
			return {
				...(live && live.app === "code" ? this.attentionOf(live) : {}),
				path: info.path,
				id: info.id,
				cwd: info.cwd,
				title: live?.session.sessionName ?? info.name ?? titleOf(info.firstMessage),
				app: this.appIndex[info.id] ?? "code",
				modified: info.modified.getTime(),
				messageCount: info.messageCount,
				running: live ? this.isRunning(live) : false,
				unread: live?.unread ?? false,
				chat: isChat(info.cwd),
				archived: archived.has(info.id),
			};
		});
		for (const live of this.live.values()) {
			if (onDisk.has(live.path)) continue;
			summaries.push({
				...(live.app === "code" ? this.attentionOf(live) : {}),
				path: live.path,
				id: live.session.sessionId,
				cwd: live.cwd,
				title: this.titleFor(live),
				app: live.app,
				modified: Date.now(),
				messageCount: live.session.messages.length,
				running: this.isRunning(live),
				unread: live.unread,
				chat: isChat(live.cwd),
				archived: archived.has(live.session.sessionId),
			});
		}
		summaries.sort((a, b) => b.modified - a.modified);
		this.summaries = summaries;
		return summaries;
	}

	refreshAttention(): void { this.scheduleList(); }

	/** Counted as the renderer counts: a background child only while there is evidence it runs (background-runs.ts). */
	private attentionOf(live: Live) {
		return { needsYou: this.broker.hasPending(live.path), agents: agentsOf(live.tracker.all(), live.background) };
	}

	/**
	 * A child may have started, finished or begun waiting: refresh the list, whose counts the sidebar shows when off
	 * screen. Counting builds every run of the session again, so it waits for the events to settle rather than
	 * running on each one: a fan-out sends progress for every child's every tool call.
	 */
	private noteAgents(live: Live): void {
		if (live.app !== "code" || live.agentTimer) return;
		live.agentTimer = setTimeout(() => {
			live.agentTimer = undefined;
			if (!this.isCurrent(live)) return;
			if (live.agentWatch.changed(this.attentionOf(live).agents)) this.scheduleList();
		}, AGENTS_MS);
	}

	/** What the views show beyond the transcript: captured handoffs, and whether background runs still go. */
	private decorate(live: Live, runs: Run[]): Run[] {
		return markBackground(live.handoffs.attach(runs), live.background);
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
		for (;;) {
			const live = await this.load(path);
			live.lastActive = Date.now();
			const changes = await live.changes.list();
			// Unloaded meanwhile, it has nothing to show; another may be in its place already.
			if (!this.isCurrent(live)) continue;
			if (live.unread) {
				live.unread = false;
				this.scheduleList();
			}
			return this.view(live, changes);
		}
	}

	private async load(path: string): Promise<Live> {
		if (this.deleting.has(path)) throw new Error(t("This session no longer exists."));
		const known = this.loading.get(path) ?? this.live.get(path);
		if (known) return known;
		const loading = this.startAgain(path).finally(() => this.loading.delete(path));
		this.loading.set(path, loading);
		return loading;
	}

	/** Starts a session from its file, or as it was when it has none yet. */
	private async startAgain(path: string): Promise<Live> {
		const unsaved = this.unsaved.get(path);
		// pi would start a new, empty session at a path that is gone, and it would show under Code.
		if (!unsaved && !existsSync(path)) throw new Error(t("This session no longer exists."));
		const manager = SessionManager.open(path, undefined, unsaved?.cwd);
		const app = unsaved?.app ?? this.appIndex[manager.getSessionId()] ?? "code";
		await this.workModes.reopened(manager.getSessionId(), unsaved?.workMode);
		const live = await this.start(app, manager.getCwd(), manager);
		if (unsaved) {
			this.unsaved.delete(path);
			this.appIndex[manager.getSessionId()] = app;
			await this.saveIndex();
		}
		return live;
	}

	async newSession(input: NewSessionInput): Promise<SessionView> {
		// A worktree is made before the session, so a branch git refuses leaves no empty session behind.
		const project = input.cwd && input.worktree ? await addWorktree(input.cwd, input.worktree.branch) : input.cwd;
		const cwd = project ?? chatsDir;
		if (!project) mkdirSync(chatsDir, { recursive: true });
		const manager = SessionManager.create(cwd);
		await this.workModes.created(manager.getSessionId(), input.app, Boolean(project), this.settings.app(input.app).workMode);
		const live = await this.start(input.app, cwd, manager, true);
		return this.holding(live, async () => {
			this.appIndex[live.session.sessionId] = input.app;
			await this.saveIndex();
			this.requireCurrent(live);
			// The session shows at once; its first message may wait for extensions and compaction.
			if (input.message?.trim()) void this.sendFirst(live, input.message);
			this.scheduleList();
			return this.view(live, []);
		});
	}

	/** A new session's first message. One that does not go out shows in the message box, where it can be sent again. */
	private async sendFirst(live: Live, text: string): Promise<void> {
		try {
			const { outcome } = await this.sendTo(live, text, "prompt");
			if (outcome !== "stopped") return;
		} catch (error) {
			this.failed(error);
		}
		if (this.isCurrent(live)) this.emit({ type: "returned", path: live.path, draft: { text, attachments: [] } });
	}

	/** Resolves once the message has an outcome; its run goes on by itself. Rejects when it reached none and will not. */
	async send(
		path: string,
		text: string,
		mode: "prompt" | "steer" | "followUp",
		attachments?: { prefix: string; images: ImageContent[] },
	): Promise<SendResult> {
		return this.sendTo(this.require(path), text, mode, attachments);
	}

	private sendTo(live: Live, text: string, mode: "prompt" | "steer" | "followUp", attachments?: { prefix: string; images: ImageContent[] }): Promise<SendResult> {
		return this.holding(live, async () => {
			try {
				const outcome =
					text.startsWith("/") && !attachments
						? await this.runCommand(live, text, mode)
						: // Attached files go in front of the message as <file> tags, like pi's CLI sends them.
							await this.dispatch(live, (attachments?.prefix ?? "") + text, mode, attachments?.images.length ? attachments.images : undefined);
				this.requireCurrent(live);
				if (outcome === "stopped") this.emitStatus(live);
				return { outcome, status: this.status(live) };
			} catch (error) {
				// A run that could not start may have shown as running while pi prepared it.
				this.emitStatusOf(live);
				throw error;
			}
		});
	}

	/** A message sent while a run is going steers it or waits for it to finish. */
	private dispatch(live: Live, text: string, mode: "prompt" | "steer" | "followUp", images?: ImageContent[]): Promise<SendOutcome> {
		return live.dispatcher.send(text, { mode: mode === "steer" ? "steer" : "followUp", images });
	}

	/** Keeps a session from being unloaded while the host works on it. */
	private async holding<T>(live: Live, work: () => Promise<T>): Promise<T> {
		live.holds++;
		try {
			return await work();
		} finally {
			live.holds--;
		}
	}

	/**
	 * Sends a new version of an earlier message: the conversation goes back to just before it, then the new
	 * text goes out with the files and images the original carried. pi keeps the replies that followed on
	 * their own branch of the session file. Files on disk stay as they are. Undefined when an extension refused.
	 */
	async editMessage(path: string, index: number, text: string): Promise<SendResult | Unsent | undefined> {
		const live = this.require(path);
		return this.holding(live, async () => {
			// Read first, so that nothing is waited for between going back and sending.
			const changes = await live.changes.list();
			this.requireCurrent(live);
			if (this.isRunning(live)) throw new Error(t("Stop the run before editing an earlier message."));
			const { content } = this.userEntry(live, index).message;
			const original = attachmentsOf(content);
			const attached = original.prefix || original.images.length ? original : undefined;
			if (!text.trim() && !attached) throw new Error(t("Write a message to send."));
			const result = await live.session.navigateTree(this.userEntry(live, index).id);
			this.requireCurrent(live);
			if (result.cancelled) return undefined;
			live.tracker = new RunTracker(branchMessages(live.session.sessionManager.getBranch()), this.thumbnail, live.session.sessionManager.getSessionFile() ?? path);
			// The shorter transcript must reach the window before the new run's events do.
			this.emit({ type: "view", view: this.view(live, changes) });
			this.scheduleList();
			let failure: unknown;
			try {
				const sent = await this.sendTo(live, text, "prompt", attached);
				if (sent.outcome !== "stopped") return sent;
			} catch (error) {
				this.requireCurrent(live);
				failure = error;
			}
			// The message went with the conversation, so its files and images go back with the new text.
			const { files } = messageFiles(content);
			const tagged = files.filter((file) => file.image).length;
			const untagged = original.images.slice(tagged).map((image): MessageFile => ({ label: "Image", image }));
			const error = failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure);
			return { outcome: "returned", status: this.status(live), prompt: text, files: [...files, ...untagged], error };
		});
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
		await this.workModes.forked(live.session.sessionId, manager.getSessionId());
		const forked = await this.start(live.app, manager.getCwd(), manager);
		return this.holding(forked, async () => {
			this.appIndex[forked.session.sessionId] = live.app;
			await this.saveIndex();
			this.requireCurrent(forked);
			this.scheduleList();
			return { view: this.view(forked, []), ...messageFiles(entry.message.content) };
		});
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
	private async runCommand(live: Live, text: string, mode: "prompt" | "steer" | "followUp"): Promise<SendOutcome> {
		const { session } = live;
		const [, name = "", args = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
		if (name === "compact") {
			if (this.isRunning(live)) throw new Error(t("Wait for the run to finish, or stop it, before compacting."));
			// compaction_start and compaction_end show the progress and the outcome, as they do for automatic compaction.
			await session.compact(args.trim() || undefined).catch(() => {});
			return "handled";
		}
		if (name === "name") {
			if (!args.trim()) throw new Error(t("Give the session a name: /name <title>"));
			session.setSessionName(args.trim());
			return "handled";
		}
		return this.dispatch(live, text, mode);
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

	/** Stops the run, and gives back messages that have not reached one yet. */
	async abort(path: string): Promise<void> {
		const live = this.require(path);
		live.dispatcher.stop();
		await live.session.abort();
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
		if (this.isRunning(live)) throw new Error(t("Stop the run before reverting its changes."));
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

	/** What the Launch button needs of a loaded session: its folder, whether it is a Code project, its title and shell. */
	launchSession(path: string): { cwd: string; eligible: boolean; title: string; shellPath?: string } | undefined {
		const live = this.live.get(path);
		if (!live) return undefined;
		let shellPath: string | undefined;
		try {
			// pi's own setting, from the global settings only: a project's settings are no reason to run another shell.
			shellPath = SettingsManager.create(homedir(), this.agentDir).getShellPath();
		} catch {
			// The default shell.
		}
		return { cwd: live.cwd, eligible: live.app === "code" && !isChat(live.cwd) && Boolean(live.cwd), title: this.titleFor(live), shellPath };
	}

	/** A session's title, loaded or not. */
	sessionTitle(path: string): string {
		const live = this.live.get(path);
		return live ? this.titleFor(live) : (this.summaries.find((summary) => summary.path === path)?.title ?? "Session");
	}

	/**
	 * Whether Launch is off for a project: the user said never for it, this run or for good, or no decision was made
	 * and undecided projects are set to never. Unlike loading .pi resources, a project with nothing in .pi still
	 * needs this, since Launch runs the project's own commands.
	 */
	launchTrustDenied(cwd: string): boolean {
		const known = this.sessionTrust.get(cwd) ?? this.trustStore.get(cwd);
		if (known === false) return true;
		if (known === true) return false;
		try {
			return SettingsManager.create(homedir(), this.agentDir).getDefaultProjectTrust() === "never";
		} catch {
			return false;
		}
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
		if (this.isRunning(live) && action === "reject") throw new Error(t("Stop the run before rejecting changes."));
		const review = await live.changes.resolve(file, id, action, expect);
		await this.emitChanges(live);
		return review;
	}

	private async emitChanges(live: Live): Promise<FileChange[]> {
		const changes = await live.changes.list();
		if (this.isCurrent(live)) {
			this.emit({ type: "changes", path: live.path, rev: ++this.rev, changes });
			this.scheduleGit(live);
		}
		return changes;
	}

	private async emitView(live: Live): Promise<void> {
		const changes = await live.changes.list();
		if (this.isCurrent(live)) this.emit({ type: "view", view: this.view(live, changes) });
	}

	/** Chats and the Research and Write apps have no repository to show. */
	private hasGit(live: Live): boolean {
		return live.app === "code" && !isChat(live.cwd);
	}

	async gitStatus(path: string): Promise<GitStatus | null> {
		const live = this.require(path);
		await this.dropCommitted(live);
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

	async gitHistory(path: string, limit: number): Promise<GitHistory> {
		const live = this.require(path);
		return this.hasGit(live) ? readGitHistory(live.cwd, limit) : { commits: [], more: false };
	}

	async gitCommit(path: string, id: string): Promise<GitCommitDetail> {
		return readGitCommit(this.require(path).cwd, id);
	}

	async gitCommitDiff(path: string, id: string, file: Pick<GitCommitFile, "rel" | "from">): Promise<GitDiff> {
		return readGitCommitDiff(this.require(path).cwd, id, file);
	}

	async gitFileAt(path: string, id: string, rel: string): Promise<ProjectFile> {
		return readFileAtCommit(this.require(path).cwd, id, rel);
	}

	/**
	 * Stages, commits, pushes and the rest. Files must be ones git lists as changed in that area, so the renderer
	 * cannot reach other paths. Discarding waits for the run to stop, as reverting does.
	 */
	async gitAction(path: string, action: GitAction): Promise<GitStatus | null> {
		const live = this.require(path);
		if (!this.hasGit(live)) throw new Error(t("Source control works in a Code session's project."));
		if (action.kind === "init") {
			await initRepo(live.cwd);
			return this.gitStatus(path);
		}
		const git = await readGitStatus(live.cwd);
		if (!git) throw new Error(t("This folder is not a git repository."));
		const listed = (files: Pick<GitFile, "rel" | "area">[]) => {
			const known = files.filter((file) => git.files.some((f) => f.rel === file.rel && f.area === file.area));
			if (known.length !== files.length) {
				this.scheduleGit(live);
				throw new Error(t("That file has no changes any more."));
			}
			return known;
		};
		try {
			switch (action.kind) {
				case "stage":
					await stageFiles(git.root, listed(action.files).map((file) => file.rel));
					break;
				case "unstage":
					await unstageFiles(git.root, listed(action.files).map((file) => file.rel));
					break;
				case "discard":
					if (this.isRunning(live)) throw new Error(t("Stop the run before discarding changes."));
					await discardFiles(git.root, listed(action.files));
					break;
				case "commit": {
					const sessionId = action.linkSession ? live.session.sessionId : undefined;
					const message = action.message.trim() ? withSessionTrailer(action.message, sessionId) : "";
					await commitChanges(git.root, { message, all: action.all, amend: action.amend });
					if (action.push) await pushBranch(git.root);
					break;
				}
				case "undoCommit":
					await undoLastCommit(git.root);
					break;
				case "push":
					await pushBranch(git.root);
					break;
				case "pull":
					await pullBranch(git.root);
					break;
				case "fetch":
					await fetchRemotes(git.root);
					break;
			}
		} catch (error) {
			throw new Error(gitError(error));
		}
		if (action.kind === "discard") await this.emitChanges(live);
		return this.gitStatus(path);
	}

	/** A commit message for the staged changes, or for all of them when nothing is staged, from the session's model. */
	async gitDraftMessage(path: string): Promise<string> {
		const live = this.require(path);
		const git = this.hasGit(live) ? await readGitStatus(live.cwd) : null;
		if (!git) throw new Error(t("This folder is not a git repository."));
		const model = live.session.model;
		if (!model) throw new Error(t("Pick a model for this session first."));
		const { diff, subjects } = await draftSource(git.root);
		if (!diff.trim()) throw new Error(t("There are no changes to describe."));
		const prompt = [
			"Write a git commit message for this diff.",
			"First line: a short summary in the imperative mood, at most 72 characters, no trailing period.",
			"If the change needs explaining, add a blank line and a short body that says why. No lists of files, no Markdown, no quotes around the message.",
			subjects.length ? `Match the style of this repository's recent subjects:\n${subjects.map((subject) => `- ${subject}`).join("\n")}` : "",
			`The work came from a session titled: ${this.titleFor(live)}`,
			"Reply with the message only.",
			"",
			diff,
		].filter((line, index) => line || index > 4).join("\n");
		const reply = await this.modelRuntime.completeSimple(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] });
		const text = reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim();
		if (!text) throw new Error(reply.errorMessage || t("The model wrote no message."));
		return text.replace(/^```\w*\n?|\n?```$/g, "").trim();
	}

	/** The files of a Code session's project folder. */
	async projectFiles(path: string, ignored: boolean): Promise<ProjectTree> {
		const live = this.require(path);
		if (!this.hasGit(live)) throw new Error(t("Files are listed for a Code session's project."));
		return listProjectFiles(live.cwd, { ignored });
	}

	/** A file in the session's project folder, which it may not leave by `..` or a link. */
	async projectFile(path: string, rel: string): Promise<ProjectFile> {
		const live = this.require(path);
		if (!this.hasGit(live)) throw new Error(t("Files are listed for a Code session's project."));
		const project = await realpath(live.cwd);
		const real = await realpath(resolve(project, rel)).catch(() => {
			throw new Error(t("There's no file at {path}.", { path: rel }));
		});
		if (!isInside(project, real)) throw new Error(t("Only files in this session's project can be read here."));
		return readProjectFile(real);
	}

	/** Takes files committed since the last look off the session's list. A run's commit waits for the run to end, when its edits have settled. */
	private async dropCommitted(live: Live): Promise<void> {
		if (!this.hasGit(live) || this.isRunning(live)) return;
		if (await live.changes.dropCommitted()) await this.emitChanges(live);
	}

	/** Reads git again once files may have changed, and sends the status when it differs from the last one. */
	private scheduleGit(live: Live): void {
		if (!this.hasGit(live) || live.gitTimer) return;
		live.gitTimer = setTimeout(() => {
			live.gitTimer = undefined;
			if (!this.isCurrent(live)) return;
			this.dropCommitted(live)
				.then(() => readGitStatus(live.cwd))
				.then((git) => {
					const text = JSON.stringify(git);
					if (text === live.git || !this.isCurrent(live)) return;
					live.git = text;
					this.emit({ type: "git", path: live.path, git });
				})
				// The last status stays up; the next run or window focus reads again.
				.catch(() => {});
		}, GIT_MS);
	}

	/**
	 * A subagent's conversation, read from the session file pi-subagents writes for it. The file must sit in
	 * the parent session's own subagent folder (or the temporary folder pi-subagents uses for a session
	 * without a file), so a page can't ask for any file it likes. The child's last reported state comes
	 * from the parent, while it is open, so a window knows whether the child is still working.
	 */
	subagentSession(parent: string, file: string): SubagentSession {
		const target = this.subagentFile(parent, file);
		const live = this.live.get(parent);
		// As the thread shows it: with the patch a writer handed back, and how a background child ended.
		const steps = live ? agentSteps(this.decorate(live, live.tracker.all())) : [];
		const child = steps.flatMap((step) => step.subagent!.children).findLast((item) => item.sessionFile && resolve(item.sessionFile) === target);
		// Only a child in a workflow or a background run can be stopped without stopping the turn.
		const stoppable = stopTarget(steps, target) !== undefined;
		if (!existsSync(target)) return { runs: [], missing: true, child, stoppable };
		try {
			const manager = SessionManager.open(target);
			const branch = manager.getBranch();
			return { runs: new RunTracker(branchMessages(branch), this.thumbnail, target).all(), missing: false, child, stoppable, ...sessionUsage(branch, (provider, model) => this.modelRuntime.getModel(provider, model)?.contextWindow) };
		} catch {
			// A file the child is still writing can end in half a line; the next read gets it whole.
			return { runs: [], missing: true, child, stoppable };
		}
	}

	/** Stops one working subagent and leaves the rest of its run going, through pi-subagents' own stop. */
	async stopSubagent(parent: string, file: string): Promise<void> {
		const target = this.subagentFile(parent, file);
		const live = this.live.get(parent);
		const stop = live && stopTarget(agentSteps(this.decorate(live, live.tracker.all())), target);
		if (!live || !stop) throw new Error(t("This agent can't be stopped on its own. Stop the whole run instead."));
		const { id, childId, workflow, asyncDir } = stop;
		// A background run's runner watches its folder for a stop, whether or not the parent is mid-turn.
		if (!workflow && asyncDir) requestBackgroundStop(asyncDir, childId);
		else await subagentRpc(live.events, "stop", { id, ...(childId ? { childId } : {}) });
	}

	/**
	 * A subagent's session file, checked: it must sit in the parent session's own subagent folder (or the temporary
	 * folder pi-subagents uses for a session without a file), so a page can't name any file it likes.
	 */
	private subagentFile(parent: string, file: string): string {
		const known = this.live.has(parent) || this.summaries.some((summary) => summary.path === parent);
		const target = resolve(file);
		const roots = [join(dirname(parent), basename(parent, ".jsonl"))];
		const temporary = relative(tmpdir(), target).split(/[\\/]/)[0] ?? "";
		const allowed = target.endsWith(".jsonl") && (roots.some((root) => isInside(root, target) && root !== target) || (temporary.startsWith("pi-subagent-session-") && isInside(tmpdir(), target)));
		if (!known || !allowed) throw new Error(t("That isn't a subagent of this session."));
		return target;
	}

	/** The conversation on a session's current branch, read from its file, for export. Compacted messages are kept. */
	exportInfo(path: string): ExportInfo {
		const manager = SessionManager.open(path);
		const title = this.summaries.find((summary) => summary.path === path)?.title ?? manager.getSessionName() ?? "Session";
		return { title, id: manager.getSessionId(), cwd: manager.getCwd(), messages: branchMessages(manager.getBranch()) };
	}

	private idOf(path: string): string | undefined {
		return this.live.get(path)?.session.sessionId ?? this.summaries.find((summary) => summary.path === path)?.id;
	}

	/**
	 * Moves sessions to the Archived panel, or back to the sidebar. Their files, changes and services stay.
	 * Refuses to archive while any of them is running.
	 */
	async archiveSessions(paths: string[], archived: boolean): Promise<string[]> {
		const ids = new Set(this.settings.get().archivedSessions);
		const moved: string[] = [];
		for (const path of paths) {
			const live = this.live.get(path);
			if (archived && live && this.isRunning(live)) throw new Error(t("“{title}” is still running. Stop it before archiving.", { title: this.titleFor(live) }));
			const id = this.idOf(path);
			if (!id) continue;
			if (archived) ids.add(id);
			else ids.delete(id);
			moved.push(path);
		}
		await this.settings.update({ archivedSessions: [...ids] });
		this.scheduleList();
		return moved;
	}

	/**
	 * Deletes sessions: unloads them, stops the services they left running, moves their files with `trash`
	 * (the system Trash), and drops Trivium's own records of them. Refuses while any of them is running.
	 */
	async deleteSessions(paths: string[], trash: (path: string) => Promise<void>): Promise<string[]> {
		for (const path of paths) {
			const live = this.live.get(path);
			if (live && this.isRunning(live)) throw new Error(t("“{title}” is still running. Stop it before deleting.", { title: this.titleFor(live) }));
		}
		const idOf = new Map(paths.map((path) => [path, this.idOf(path)]));
		const unloaded: string[] = [];
		// All at once, before any of them can start a run, and none is opened again meanwhile.
		for (const path of paths) {
			this.deleting.add(path);
			const live = this.live.get(path);
			if (!live) continue;
			this.unload(live);
			unloaded.push(path);
		}
		const deleted: string[] = [];
		const ids = new Set<string>();
		try {
			for (const path of paths) {
				const id = idOf.get(path);
				// Never fails: a launch's cleanup that can't finish says how to, and deleting goes on.
				await this.onDeleting?.(path).catch(() => {});
				await this.services.stopSession(path);
				this.viewing.delete(path);
				// A new session has no file until its first message.
				if (!path.startsWith("memory:") && existsSync(path)) await trash(path);
				this.unsaved.delete(path);
				if (id) {
					ids.add(id);
					delete this.appIndex[id];
					await this.workModes.delete(id);
					await rm(join(triviumDir, "changes", `${id}.json`), { force: true });
					// And what it kept to tell what the session's commands changed.
					for (const kept of ["git", "blobs"]) await rm(join(triviumDir, "changes", `${id}.${kept}`), { recursive: true, force: true, maxRetries: 3 });
				}
				deleted.push(path);
			}
		} finally {
			for (const path of paths) {
				this.deleting.delete(path);
				this.onDeleted?.(path);
			}
			const left = unloaded.filter((path) => !deleted.includes(path));
			if (left.length) this.emit({ type: "unloaded", paths: left });
		}
		await this.saveIndex();
		await this.settings.update({ archivedSessions: this.settings.get().archivedSessions.filter((id) => !ids.has(id)) });
		this.scheduleList();
		return deleted;
	}

	/** Unloads a session from memory. Its file stays; opening it again reloads it. Its services keep running. */
	private unload(live: Live): void {
		live.dispatcher.close();
		this.broker.cancelAll(live.path);
		clearTimeout(live.flushTimer);
		clearTimeout(live.gitTimer);
		clearTimeout(live.agentTimer);
		live.unsubscribe();
		live.session.dispose();
		// Reopening reads the manifests again from the session's history; a deleted session's patches go with it.
		live.handoffs.clear();
		live.background.dispose();
		this.live.delete(live.path);
		if (!live.path.startsWith("memory:") && !existsSync(live.path)) this.unsaved.set(live.path, { app: live.app, cwd: live.cwd, workMode: this.workModes.unsaved(live.session.sessionId, live.app) });
	}

	/** A child at work, some of which live in this process and would be killed with the session. */
	private hasLiveAgents(live: Live): boolean {
		return hasLiveAgents(live.tracker.all(), live.background);
	}

	/** Whether unloading a session would cut something off or lose it, such as messages a stopped run left with pi. */
	private inUse(live: Live): boolean {
		return this.isRunning(live) || live.holds > 0 || live.dispatcher.busy || live.session.agent.hasQueuedMessages() || this.hasLiveAgents(live);
	}

	private unloadIdle(): void {
		const minutes = this.settings.get().idleMinutes;
		if (!minutes) return;
		const cutoff = Date.now() - minutes * 60_000;
		const paths: string[] = [];
		for (const live of this.live.values()) {
			if (this.viewing.has(live.path) || live.lastActive > cutoff || live.path.startsWith("memory:")) continue;
			if (this.services.hasBackground(live.path)) continue;
			if (this.inUse(live)) continue;
			this.unload(live);
			paths.push(live.path);
		}
		if (paths.length) this.emit({ type: "unloaded", paths });
	}

	/** Reloads an app's idle sessions so extension and model settings take effect. Those in use keep their setup. */
	reloadApp(app: AppId): string[] {
		const paths: string[] = [];
		for (const live of [...this.live.values()]) {
			if (live.app !== app || live.path.startsWith("memory:") || this.inUse(live)) continue;
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
			if (builtInOf(path) || path === LONG_COMMANDS_PATH) return "Trivium";
			if ([...added].some((entry) => path === entry || path.startsWith(entry + sep))) return "Added";
			if (path.startsWith("builtin:")) return "Built-in";
			if (extension?.sourceInfo.origin === "package") return "Package";
			if (extension?.sourceInfo.scope === "project") return "Project";
			return "Global";
		};
		const result = loader.getExtensions();
		const extensions: ExtensionInfo[] = await Promise.all(
			result.extensions
				// pi hides its built-in extensions, but this one is here to be turned off.
				.filter((extension) => (!extension.hidden || extension.path === LONG_COMMANDS_PATH) && !extension.path.startsWith("<"))
				.map(async (extension) => {
					const builtIn = builtIns.find((entry) => extension.resolvedPath.startsWith(entry.dir + sep));
					const fromPackage = extension.sourceInfo.origin === "package";
					return {
						path: extension.resolvedPath,
						name: extensionName(extension.resolvedPath, builtIn?.name ?? (fromPackage ? extension.sourceInfo.source : undefined)),
						display: builtIn?.name ?? (fromPackage ? extension.sourceInfo.source : shortPath(extension.resolvedPath)),
						// pi sets baseDir to an installed package's root.
						description:
							extension.path === LONG_COMMANDS_PATH
								? t("Moves a command still running after 10 minutes to the background, so the session carries on and the work isn't lost.")
								: await packageDescription(builtIn?.dir ?? (fromPackage ? extension.sourceInfo.baseDir : undefined)),
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
		const skillDiagnostics = loader.getSkills().diagnostics;
		const disabledSkills = new Set(appSettings.disabledSkills);
		const skillOrder = ["App", "Global", "Trivium", "Package", "Project"];
		const skills: SkillInfo[] = loader
			.getSkills()
			.skills.map((skill) => {
				const replaced = skillDiagnostics.find((d) => d.collision?.resourceType === "skill" && d.collision.winnerPath === skill.filePath);
				return {
					name: skill.name,
					description: skill.description,
					path: skill.filePath,
					display: shortPath(skill.filePath),
					source: skillFiles.skillSource(skill, profile.skillDir, builtIns.map((entry) => entry.dir)),
					on: !disabledSkills.has(skill.filePath),
					manual: skill.disableModelInvocation,
					warnings: skillDiagnostics.filter((d) => d.type === "warning" && d.path === skill.filePath).map((d) => d.message),
					replaces: replaced?.collision && shortPath(replaced.collision.loserPath),
				};
			})
			.sort((a, b) => skillOrder.indexOf(a.source) - skillOrder.indexOf(b.source) || a.name.localeCompare(b.name));
		const lives = [...this.live.values()].filter((live) => live.app === app);
		return {
			id: app,
			extensionDir: profile.extensionDir,
			projectDir,
			extensions,
			tools: profile.tools,
			skillDir: profile.skillDir,
			skills,
			prompts: loader.getPrompts().prompts.length,
			systemPrompt: profileFor(app).appendSystemPrompt,
			running: lives.filter((live) => this.isRunning(live)).length,
			loaded: lives.length,
			packages: new DefaultPackageManager({ cwd: projectDir, agentDir: this.agentDir, settingsManager })
				.listConfiguredPackages()
				.filter((entry) => entry.scope === "user")
				.map((entry) => entry.source),
			permissions: this.permissionsOf(app),
		};
	}

	async createSkill(app: AppId, draft: SkillDraft): Promise<AppDetails> {
		await skillFiles.createSkill(skillDir(app), draft);
		return this.describeApp(app);
	}

	async readSkill(app: AppId, path: string): Promise<string> {
		return skillFiles.readSkill(await this.skillPath(app, path));
	}

	async saveSkill(app: AppId, path: string, text: string): Promise<AppDetails> {
		await skillFiles.saveSkill(await this.skillPath(app, path), text);
		return this.describeApp(app);
	}

	async inspectSkill(app: AppId, path: string): Promise<SkillImport> {
		const found = await skillFiles.findSkill(path);
		await found.dispose();
		return { name: found.name, description: found.description, exists: existsSync(join(skillDir(app), found.name)) };
	}

	async importSkill(app: AppId, path: string, replace: boolean, trash: (path: string) => Promise<void>): Promise<AppDetails> {
		const found = await skillFiles.findSkill(path);
		try {
			await skillFiles.addSkill(skillDir(app), found, replace ? trash : undefined);
		} finally {
			await found.dispose();
		}
		return this.describeApp(app);
	}

	/** A copy in the app's folder replaces the original in this app only, and updating its package leaves the copy alone. */
	async customizeSkill(app: AppId, path: string): Promise<AppDetails> {
		const file = await this.skillPath(app, path);
		return this.importSkill(app, basename(file) === "SKILL.md" ? dirname(file) : file, false, async () => {});
	}

	async deleteSkill(app: AppId, path: string, trash: (path: string) => Promise<void>): Promise<AppDetails> {
		const target = skillFiles.skillTarget(await this.skillPath(app, path), skillDir(app));
		await trash(target);
		const appSettings = this.settings.app(app);
		if (appSettings.disabledSkills.includes(path)) {
			const disabledSkills = appSettings.disabledSkills.filter((entry) => entry !== path);
			await this.settings.update({ apps: { ...this.settings.get().apps, [app]: { ...appSettings, disabledSkills } } });
		}
		return this.describeApp(app);
	}

	/** Only a skill this app loads, so the renderer cannot read or write arbitrary files. */
	async skillPath(app: AppId, path: string): Promise<string> {
		const details = await this.describeApp(app);
		if (!details.skills.some((skill) => skill.path === path)) throw new Error(t("That skill is no longer in this mode."));
		return path;
	}

	dispose(): void {
		if (this.idleTimer) clearInterval(this.idleTimer);
		for (const pending of [...this.trustAnswers.values()]) pending.resolve(undefined);
		this.broker.cancelAll();
		for (const live of this.live.values()) {
			live.dispatcher.close();
			live.unsubscribe();
			live.session.dispose();
		}
		this.live.clear();
	}

	private resourceLoader(
		app: AppId,
		cwd: string,
		settingsManager: SettingsManager,
		options: { keepDisabled?: boolean; factories?: InlineExtension[]; sessionPath?: () => string; events?: EventBus } = {},
	): DefaultResourceLoader {
		const sessionPath = options.sessionPath ?? (() => "");
		const longCommands: InlineExtension = {
			name: LONG_COMMANDS_NAME,
			// Not replaceable: pi would let a bash that is turned off here replace it. dropClashingBuiltIns decides instead.
			builtin: true,
			factory: (pi) => {
				const bash = this.bashTool(cwd, settingsManager, sessionPath, (end) => this.backgroundEnded(sessionPath(), end));
				pi.registerTool(withLongCommands(bash) as ToolDefinition<any, any>);
			},
		};
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
		const disabledSkills = new Set(appSettings.disabledSkills);
		const appendPrompt = profile.appendSystemPrompt;
		return new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			settingsManager,
			eventBus: options.events,
			additionalExtensionPaths: extensions,
			appendSystemPromptOverride: appendPrompt ? (base) => [...base, appendPrompt] : undefined,
			extensionFactories: [...builtinExtensions(), ...(profileInfo(app).tools.includes("bash") ? [longCommands] : []), ...(options.factories ?? [])],
			skillsOverride: (loaded) => skillFiles.appSkills(loaded, profile.skillDir, disabledSkills, options.keepDisabled),
			extensionsOverride: (loaded) => {
				// A shipped package gives way to the user's own extension with the same tools, unless that one is off here.
				const base = dropClashingBuiltIns(loaded, [...builtIns.map((entry) => entry.dir), LONG_COMMANDS_PATH], disabled);
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

	/** pi's bash tool, running commands so the processes they leave show as services. */
	private bashTool(cwd: string, settingsManager: SettingsManager, sessionPath: () => string, onBackgroundEnd?: (end: BackgroundEnd) => void) {
		const shell = { shellPath: settingsManager.getShellPath(), commandPrefix: settingsManager.getShellCommandPrefix() };
		return createBashToolDefinition(cwd, { ...shell, operations: this.services.bashOperations(sessionPath, { ...shell, onBackgroundEnd }) });
	}

	private async start(app: AppId, cwd: string, sessionManager: SessionManager, isNew = false): Promise<Live> {
		const profile = profileFor(app);
		// What the extension may write for this session: its session folder, the temp root and the project's .pi folder.
		const handoffs = new HandoffCache(handoffRoots({ agentDir: this.agentDir, cwd, sessionFile: sessionManager.getSessionFile() }));
		const history = branchMessages(sessionManager.getBranch());
		for (const message of history) {
			if (message.role === "toolResult" || message.role === "custom") await handoffs.capture(message.details);
		}
		let sessionPath = "";
		// Untrusted until the reload hook below decides: project settings must not apply before that.
		const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: false });
		const changes = new ChangeTracker(join(triviumDir, "changes", `${sessionManager.getSessionId()}.json`), cwd, () =>
			this.notice(t("This folder is too large to track what commands change. Edits are still tracked."), "info"),
		);
		/** The command of a shell call that may change files, which is one that does more than read. */
		const changing = (event: { toolName: string; input: unknown }) => {
			const command = (event.input as { command?: unknown }).command;
			return (event.toolName === "bash" || event.toolName === "powershell") && typeof command === "string" && !onlyReads(command);
		};
		const emitChanges = async () => {
			const live = this.live.get(sessionPath);
			if (live) await this.emitChanges(live);
		};
		// Background launches: whether each still runs, and the window in which its edits count as this session's.
		const background = new BackgroundRuns({
			closeWindow: async () => {
				if (await changes.afterSubagents()) await emitChanges().catch(() => {});
			},
			openWindow: () => changes.beforeSubagents(),
			writerOf: (input) => writerOf("subagent", input, cwd),
			onChange: () => {
				const live = this.live.get(sessionPath);
				if (!live) return;
				void this.emitView(live).catch(() => {});
				this.noteAgents(live);
			},
		});
		const events = createEventBus();
		const resourceLoader = this.resourceLoader(app, cwd, settingsManager, {
			events,
			sessionPath: () => sessionPath,
			factories: [
				...(app === "code" && !isChat(cwd)
					? [
							{
								name: "writer-lock",
								factory: writerLock({
									orchestrator: () => this.workModes.get(sessionManager.getSessionId()) === "orchestrator",
									permission: () => this.permissionMode(),
									background,
									changing,
								}),
							},
						]
					: []),
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
				...(app === "code" && !isChat(cwd) ? [{ name: "work-mode", factory: workModeExtension(() => this.workModes.get(sessionManager.getSessionId())) }] : []),
				// After the gate, so the project is snapshotted only for a command that was allowed to run.
				delegationHooks({
					app,
					changes,
					handoffs,
					background,
					changing,
					afterSubagents: () => changes.afterSubagents(),
					onChanges: emitChanges,
					onNotice: async () => {
						const live = this.live.get(sessionPath);
						if (!live) return;
						await this.emitChanges(live);
						await this.emitView(live);
						// The sidebar counts this session's agents too, also while it is not on screen.
						this.noteAgents(live);
					},
				}),
			],
		});
		// Global extensions load first; project resources only once the project is trusted.
		await resourceLoader.reload({ resolveProjectTrust: () => this.projectTrusted(cwd, true) });
		// A new session starts on the app's model when one is set; a reopened session keeps its own.
		const appSettings = this.settings.app(app);
		const slash = appSettings.model?.indexOf("/") ?? -1;
		// An extension's bash wins, long-commands' included, so this one runs only with that extension off.
		const ownBash = resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("bash"));
		const customTools =
			profileInfo(app).tools.includes("bash") && !ownBash ? [this.bashTool(cwd, settingsManager, () => sessionPath) as ToolDefinition<any, any>] : undefined;
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
			events,
			handoffs,
			background,
			agentWatch: new AgentCountWatch(),
			handoffSeen: new Set(),
			path,
			app,
			cwd,
			session,
			// The whole branch rather than session.messages, so messages from before a compaction still show.
			tracker: new RunTracker(branchMessages(sessionManager.getBranch()), this.thumbnail, sessionManager.getSessionFile() ?? path),
			changes,
			running: false,
			compacting: false,
			// Until its extensions are ready.
			holds: 1,
			dispatcher: new Dispatcher(session, (error) => {
				this.failed(error);
				this.emitStatusOf(live);
			}),
			unread: false,
			unsubscribe: () => {},
			sentRuns: 0,
			lastActive: Date.now(),
		};
		live.sentRuns = live.tracker.length;
		this.live.set(path, live);
		// Before the extensions are bound: one can start a run as soon as its session starts.
		const unsubscribe = session.subscribe((event) => this.onEvent(live, event));
		let release = () => {};
		live.unsubscribe = () => {
			unsubscribe();
			release();
		};
		release = await bindWithChildGate({
			app,
			sessionId: session.sessionId,
			gatePath: fileURLToPath(new URL(`./${CHILD_GATE_FILE}`, import.meta.url)),
			bind: async () => {
				// Launches in the history whose result never arrived: read their status, never reopen a Changes window.
				await background.restore(live.tracker.all());
				await session.bindExtensions({
					uiContext: createUiContext(this.broker, () => path, (message, level) => this.extensionNotice(message, level)),
					mode: "rpc",
					onError: (error) => {
						// What a closed session's extensions still try does not matter any more.
						if (!this.isCurrent(live)) return;
						this.notice(`${error.extensionPath}: ${error.error}`, "error");
						// It may be a run the extension asked for that could not start.
						this.emitStatusOf(live);
					},
				});
			},
			undo: () => {
				if (!this.isCurrent(live)) return;
				live.dispatcher.close();
				unsubscribe();
				background.dispose();
				this.live.delete(path);
				session.dispose();
			},
		});
		live.holds--;
		if (!this.isCurrent(live)) {
			// Deleted meanwhile.
			release();
			this.requireCurrent(live);
		}
		return live;
	}

	/** Tells a session that a command it left in the background has ended. */
	private backgroundEnded(path: string, end: BackgroundEnd): void {
		const live = this.live.get(path);
		if (!live) return;
		// It may have changed files, committed or switched branches. The user may have edited some of them meanwhile.
		this.scheduleGit(live);
		if (!onlyReads(end.command)) {
			void live.changes
				.afterBackground()
				.then((changed) => (changed ? this.emitChanges(live) : undefined))
				.catch(() => {});
		}
		const { message, options } = endedMessage(end);
		void live.session.sendCustomMessage(message, options).catch((error: unknown) => {
			this.failed(error);
			this.emitStatusOf(live);
		});
	}

	private onEvent(live: Live, event: AgentSessionEvent): void {
		live.lastActive = Date.now();
		if (event.type === "agent_settled") {
			this.onSettled(live, event);
			return;
		}
		// Before the tracker, so the finished reply it shows carries its first token's time.
		this.timeFirstToken(live, event);
		if (live.tracker.apply(event)) this.scheduleFlush(live, event.type === "message_start");
		if ((event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") && (event.toolName === "subagent" || event.toolName === SUPERVISOR_TOOL)) {
			this.noteAgents(live);
		}
		if (event.type === "tool_execution_update" && event.toolName === "subagent") {
			const details = (event.partialResult as { details?: { parallelHandoff?: { path?: unknown } } } | undefined)?.details;
			const path = details?.parallelHandoff?.path;
			if (typeof path === "string" && !live.handoffSeen.has(path)) {
				live.handoffSeen.add(path);
				// Pending manifests carry lane/worktree identities. Read once at launch, then again at completion.
				void live.handoffs.capture(details).then(() => this.flush(live));
			}
		}
		switch (event.type) {
			case "agent_start":
				live.running = true;
				this.emitStatus(live);
				this.scheduleList();
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
	 * The window sends its next queued message once it hears the session is idle, so that goes out first and nothing
	 * else here may stop it. An error thrown into pi would also strand what extensions asked for at the run's end.
	 */
	private onSettled(live: Live, event: AgentSessionEvent): void {
		live.running = false;
		live.unread = !this.viewing.has(live.path);
		this.emitStatus(live);
		const parts = [() => void live.tracker.apply(event), () => this.onDone(live.path, this.titleFor(live)), () => this.flush(live)];
		for (const part of parts) {
			try {
				part();
			} catch (error) {
				this.failed(error);
			}
		}
		this.scheduleList();
		this.scheduleGit(live);
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
		if (!this.isCurrent(live)) return;
		const current = live.tracker.current();
		if (!current) return;
		this.decorate(live, [current.run]);
		// A run that started since the last flush means earlier runs may have changed too.
		if (current.index > live.sentRuns) {
			const all = this.decorate(live, live.tracker.all());
			for (let index = live.sentRuns; index < all.length; index++) {
				this.emit({ type: "run", path: live.path, rev: ++this.rev, index, run: all[index]! });
			}
		} else {
			this.emit({ type: "run", path: live.path, rev: ++this.rev, index: current.index, run: current.run });
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

	/**
	 * Whether a run is going, including while pi prepares one, which it compacts for and asks extensions about before
	 * agent_start, and while extensions hear that one settled.
	 */
	private isRunning(live: Live): boolean {
		return live.running || live.session.isStreaming;
	}

	private status(live: Live): SessionStatus {
		return {
			path: live.path,
			rev: ++this.rev,
			running: this.isRunning(live),
			compacting: live.compacting,
			context: this.contextOf(live),
			queue: this.queueOf(live),
			title: this.titleFor(live),
		};
	}

	private emitStatus(live: Live): void {
		this.emit({ type: "status", ...this.status(live) });
	}

	/** After something that can fail long after it began, when the session may have been unloaded. */
	private emitStatusOf(live: Live): void {
		if (this.isCurrent(live)) this.emitStatus(live);
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
			runs: this.decorate(live, live.tracker.all()),
			rev: ++this.rev,
			running: this.isRunning(live),
			compacting: live.compacting,
			// pi uses an "unknown" placeholder when no model is configured; show that as no model.
			model:
				session.model && session.model.provider !== "unknown" ? `${session.model.provider}/${session.model.id}` : undefined,
			thinkingLevel: session.thinkingLevel,
			context: this.contextOf(live),
			queue: this.queueOf(live),
			changes,
			permissions: this.permissionsOf(live.app),
			...(live.app === "code" && !isChat(live.cwd) ? { workMode: this.workModes.get(session.sessionId) } : {}),
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

	private failed(error: unknown): void {
		this.notice(error instanceof Error ? error.message : String(error), "error");
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

	/** Whether this is the instance of its session that is loaded. Work on one unloaded meanwhile says nothing about the next. */
	private isCurrent(live: Live): boolean {
		return this.live.get(live.path) === live;
	}

	private requireCurrent(live: Live): void {
		if (!this.isCurrent(live)) throw new Error(t("This session is not open."));
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

/** What git said when it refused, without the command line Node puts in front of it. */
function gitError(error: unknown): string {
	const stderr = (error as { stderr?: unknown }).stderr;
	const text = typeof stderr === "string" ? stderr.trim() : "";
	if (text) return text.replace(/^(error|fatal|hint): /gm, "").split(/\r?\n/).slice(0, 6).join("\n");
	return error instanceof Error ? error.message : String(error);
}
