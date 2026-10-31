// Types shared by the main process, the preload bridge and the renderer.

import type { Language } from "./i18n.ts";
import type { PermissionModeId } from "./permissions.ts";

export type AppId = "code" | "research" | "write";

export const APP_IDS: readonly AppId[] = ["code", "research", "write"];

export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	title: string;
	app: AppId;
	modified: number;
	messageCount: number;
	running: boolean;
	unread: boolean;
	/** Started without a project, in Trivium's own chats folder. */
	chat: boolean;
}

export interface ModelOption {
	key: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: string[];
	/** The model accepts images. */
	images: boolean;
}

/** An attachment waiting in the message box. Its content stays in the main process until sent. */
export interface AttachmentInfo {
	id: string;
	name: string;
	kind: "image" | "file";
	size: number;
	/** A data URL, for images. */
	preview?: string;
	/** Something worth knowing, such as "Resized to 1568×1045". */
	note?: string;
}

/** A project asking to load its own .pi settings and resources. */
export interface TrustRequest {
	id: string;
	cwd: string;
	/** What the project's .pi folder contains, such as "extensions" or "mcp.json". */
	resources: string[];
}

export type TrustChoice = "trust" | "once" | "never";

export type StepStatus = "running" | "done" | "error";

/** An image in the transcript. `id` fetches the full image from the session; `thumb` is a small data URL preview. */
export interface TranscriptImage {
	id: string;
	name: string;
	mimeType: string;
	thumb?: string;
}

export interface Step {
	id: string;
	tool: string;
	target: string;
	meta: string;
	tone: "plain" | "add" | "error";
	status: StepStatus;
	startedAt?: number;
	durationMs?: number;
	/** Full thinking or commentary text, before the collapsed preview is shortened. */
	content?: string;
	/** Serialized tool arguments and available text output for the expanded step. */
	input?: string;
	output?: string;
	/** Images the tool returned, such as a read of a PNG. */
	images?: TranscriptImage[];
	/** Last lines of live output, shown for a running bash step. */
	tail?: string;
	/** The child agents a subagent step started, and what each is doing or did. */
	subagent?: Subagent;
}

/** One child agent started by the subagent tool. */
export interface SubagentChild {
	agent: string;
	/** What it was asked to do. */
	task: string;
	/** The workflow's name for it, which tells apart children of the same agent, such as "tests". */
	label?: string;
	status: StepStatus | "pending";
	/** The tool it is using now, such as { tool: "read", target: "src/auth.ts" }. */
	current?: { tool: string; target: string };
	/** Its latest tool calls, oldest first. */
	steps: { tool: string; target: string }[];
	tools: number;
	tokens?: number;
	durationMs?: number;
	model?: string;
	context?: "fresh" | "fork";
	/** Its answer, once it finishes. */
	output?: string;
	error?: string;
}

export interface Subagent {
	children: SubagentChild[];
	/** Started in the background: the step ends at launch, and the result arrives later as its own run. */
	background: boolean;
}

/** A background subagent's result, which starts a run of its own instead of a user message. */
export interface SubagentNotice {
	agent: string;
	status: "completed" | "failed" | "paused" | "stopped";
	durationMs?: number;
	/** The child's result, as pi-subagents previewed it. */
	text: string;
}

/** A provider's usage-limit, quota or balance error, explained. */
export interface LimitNotice {
	/** What happened and what to do, in plain words. */
	message: string;
	/** Where to check usage, top up or renew. */
	link?: { label: string; url: string };
	/** The provider's own words. */
	detail: string;
}

export interface Run {
	id: string;
	prompt: string;
	/** Files and images sent with the prompt; an image carries what fetches and previews it. */
	attachments?: { name: string; kind: "image" | "file"; id?: string; mimeType?: string; thumb?: string }[];
	/** Set when a background subagent's result started the run; the prompt is then empty. */
	notice?: SubagentNotice;
	steps: Step[];
	/** Assistant text after the last tool call: the run's answer. */
	answer: string;
	status: "running" | "done" | "aborted" | "error";
	startedAt?: number;
	endedAt?: number;
	error?: string;
	/** Set when `error` is a usage limit or an empty balance Trivium recognizes. */
	limit?: LimitNotice;
	/** The run's last finished reply: when its request was sent, how long it took, and the output tokens it wrote. */
	reply?: ReplyTiming;
	/** The conversation was compacted after this run: it stays on screen, but the agent sees only a summary of it and what came before. */
	compacted?: boolean;
}

export interface ReplyTiming {
	at: number;
	durationMs?: number;
	/** Absent for replies Trivium didn't stream, such as those written before it timed first tokens. */
	firstTokenMs?: number;
	output: number;
}

export interface ContextInfo {
	tokens: number | null;
	window: number;
	/** Estimated tokens for the system prompt and tool definitions. */
	systemTokens: number;
	/** Percent of the window at which automatic compaction starts, or null when disabled. */
	compactAt: number | null;
}

export interface QueueInfo {
	steering: string[];
	followUp: string[];
}

export interface DiffLine {
	kind: "hunk" | "add" | "del" | "ctx";
	oldNo?: number;
	newNo?: number;
	text: string;
}

export interface FileChange {
	/** Absolute path. */
	path: string;
	/** Path relative to the session's project, or absolute when outside it. */
	rel: string;
	status: "added" | "modified" | "deleted";
	adds: number;
	dels: number;
	lines: DiffLine[];
	tooLarge: boolean;
}

/** Where a changed file sits in git: in the index, the working tree only, not tracked, or mid-merge. */
export type GitArea = "staged" | "unstaged" | "untracked" | "conflicted";

export interface GitFile {
	/** Path relative to the repository root, with forward slashes, as git prints it. */
	rel: string;
	/** Absolute path. */
	path: string;
	/** The old path of a staged rename or copy. */
	from?: string;
	area: GitArea;
	status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted";
}

/** The repository a Code session's folder is in. */
export interface GitStatus {
	root: string;
	/** null when HEAD is detached. */
	branch: string | null;
	/** Short commit id, or null before the first commit. */
	head: string | null;
	upstream?: string;
	ahead: number;
	behind: number;
	/** The newest commits not pushed to the upstream yet, newest first; at most a few of `ahead`. */
	outgoing?: GitCommit[];
	/** The newest commits on the upstream that this branch does not have, as of the last fetch. */
	incoming?: GitCommit[];
	/** When the remote was last fetched, so `behind` is only as fresh as this. Unset if it never was. */
	fetchedAt?: number;
	files: GitFile[];
	/** More files changed than are listed. */
	truncated: boolean;
}

export interface GitCommit {
	/** Short commit id. */
	id: string;
	subject: string;
}

export interface GitDiff {
	lines: DiffLine[];
	adds: number;
	dels: number;
	tooLarge: boolean;
	binary: boolean;
}

/** How the Preview panel shows a file. "web" is a local service's page, by its address. */
export type ReaderKind = "html" | "markdown" | "image" | "pdf" | "table" | "text" | "binary" | "web";

/** A file open in the Preview panel. */
export interface ReaderFile {
	/** Its token, which its trivium-file URLs carry. A new one is issued when scripts are turned on or off. */
	id: string;
	/** Absolute path, past any links. */
	path: string;
	/** Path relative to the session's project, or absolute when outside it. */
	rel: string;
	name: string;
	kind: ReaderKind;
	size: number;
	mtime: number;
	/** Where the panel loads HTML, images and PDFs from. */
	url?: string;
	/** The text of Markdown, tables and other text files. */
	text?: string;
	/** The text stops short of the end of the file. */
	truncated?: boolean;
	/** The page may run its scripts. */
	scripts: boolean;
}

/** A file as text with the agent's changes marked, for reviewing one change at a time. */
export type ReviewSegment =
	| { kind: "same"; text: string }
	/** `del` is the original text, `ins` the agent's version. Either can be empty. */
	| { kind: "change"; id: number; del: string; ins: string };

export interface FileReview {
	path: string;
	rel: string;
	segments: ReviewSegment[];
	pending: number;
}

export interface SessionView {
	path: string;
	id: string;
	cwd: string;
	/** Started without a project, in Trivium's own chats folder. */
	chat: boolean;
	app: AppId;
	title: string;
	runs: Run[];
	running: boolean;
	/** pi is summarizing the conversation, after /compact or when the context ran full. */
	compacting: boolean;
	model?: string;
	thinkingLevel: string;
	context?: ContextInfo;
	queue: QueueInfo;
	changes: FileChange[];
	/** Set in Code, whose sessions run behind the permission gate. */
	permissions?: PermissionSettings;
}

export type DialogRequest =
	| { id: string; sessionPath: string; kind: "select"; title: string; options: string[] }
	| { id: string; sessionPath: string; kind: "confirm"; title: string; message: string }
	| { id: string; sessionPath: string; kind: "input"; title: string; placeholder?: string }
	| { id: string; sessionPath: string; kind: "editor"; title: string; prefill?: string };

export type DialogAnswer = { cancelled: true } | { value: string } | { confirmed: boolean };

export interface Notice {
	id: string;
	message: string;
	level: "info" | "warning" | "error";
}

export type HostEvent =
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "view"; view: SessionView }
	| { type: "run"; path: string; index: number; run: Run }
	| { type: "status"; path: string; running: boolean; compacting: boolean; context?: ContextInfo; queue: QueueInfo; title: string }
	| { type: "changes"; path: string; changes: FileChange[] }
	| { type: "git"; path: string; git: GitStatus | null }
	| { type: "dialog"; request: DialogRequest }
	| { type: "dialog_closed"; id: string }
	| { type: "notice"; notice: Notice }
	| { type: "login"; event: LoginEvent }
	| { type: "focus_session"; path: string }
	| { type: "unloaded"; paths: string[] }
	| { type: "trust"; request: TrustRequest }
	| { type: "trust_closed"; id: string }
	| { type: "reader_changed"; id: string }
	| { type: "services"; services: Record<string, ServiceInfo[]> }
	| { type: "update"; update: UpdateStatus };

/** A Trivium release on GitHub newer than the one running. */
export interface ReleaseInfo {
	version: string;
	/** The release's page, with its notes and downloads. */
	url: string;
	notes: string;
	publishedAt: string;
	/** Trivium can download and install it itself; otherwise the release page opens. */
	installable: boolean;
	/** Why it can't, when it can't. */
	reason?: string;
}

/** Where updating Trivium stands. */
export type UpdateStatus =
	| { state: "idle" }
	| { state: "checking" }
	| { state: "current"; checkedAt: number }
	| { state: "available"; release: ReleaseInfo }
	| { state: "downloading"; release: ReleaseInfo; received: number; total: number }
	/** Unpacking and putting the new version in place for the restart. */
	| { state: "installing"; release: ReleaseInfo }
	/** In place, waiting for a restart the user put off. */
	| { state: "ready"; release: ReleaseInfo }
	| { state: "error"; message: string; release?: ReleaseInfo };

/** Processes an agent command left running, such as a dev server or a watcher, until they end or are stopped. */
export interface ServiceInfo {
	id: string;
	/** The command the agent ran. */
	command: string;
	cwd: string;
	startedAt: number;
	/** Its processes still running: the ones the command started, and theirs. */
	processes: { pid: number; name: string }[];
	/** TCP ports it listens on. */
	ports: number[];
	/** Where it serves pages: an address it printed, or its first port. */
	url?: string;
	/** The last of what it printed, while its output still comes to Trivium. */
	output: string;
	/** A stop is under way. */
	stopping: boolean;
}

/** What goes into a session's message box, unsent: such as an earlier message taken back to edit. */
export interface Draft {
	text: string;
	attachments: AttachmentInfo[];
}

export interface NewSessionInput {
	app: AppId;
	/** The project folder. Left out, the session is a chat in Trivium's own folder. */
	cwd?: string;
	message?: string;
}

export interface AppProfileInfo {
	id: AppId;
	tools: string[];
	extensionDir: string;
	extensions: string[];
}

export interface AppSettings {
	/** Model for new sessions in this app, as provider/id. Unset uses pi's default. */
	model?: string;
	thinkingLevel?: string;
	/** Resolved paths of extensions pi would load that this app leaves out. */
	disabled: string[];
	/** Extension files or folders added to this app from elsewhere. */
	added: string[];
	/** Packages Trivium ships for this app that the user removed, by npm name. */
	removed: string[];
}

export interface TriviumSettings {
	/** The interface's language; "system" follows the operating system's. */
	language: Language;
	/** Window zoom factor, 1 = 100%. */
	textSize: number;
	/** Minutes before an idle, unviewed session is unloaded. 0 keeps sessions loaded. */
	idleMinutes: number;
	notifyDone: boolean;
	notifyWaiting: boolean;
	/** Look for a new Trivium release on GitHub at startup and every few hours. */
	checkUpdates: boolean;
	apps: Record<AppId, AppSettings>;
	/** Catalog models, as "provider/id", left out of the model picker: the provider doesn't serve them to this login. */
	hiddenModels: string[];
	/** Code's permission mode. Unset until Trivium first starts with its own gate, which carries over the old policy. */
	permissionMode?: PermissionModeId;
}

export type ExtensionSource = "App" | "Added" | "Trivium" | "Global" | "Project" | "Package" | "Built-in" | "Dev";

export interface ExtensionInfo {
	/** Resolved path, the key used to turn it off. */
	path: string;
	name: string;
	/** Path as shown: shortened, or a package or builtin name. */
	display: string;
	/** The package's own one-line description, when it comes from a package that has one. */
	description?: string;
	source: ExtensionSource;
	on: boolean;
	/** What it adds: tools, commands, event handlers. */
	registers: string[];
	error?: string;
	/** The npm name of the package Trivium ships it in, which the user can remove from this app. */
	builtIn?: string;
}

/** The mode Trivium's permission gate runs Code in, shared by every Code session. */
export interface PermissionSettings {
	level: PermissionModeId;
}

export interface AppDetails {
	id: AppId;
	extensionDir: string;
	/** Project used to discover project-local extensions, skills and prompts. */
	projectDir: string;
	extensions: ExtensionInfo[];
	tools: string[];
	skills: number;
	prompts: number;
	systemPrompt?: string;
	running: number;
	loaded: number;
	/** pi packages installed for every app and the pi CLI, as their sources, such as "npm:pi-web-access". */
	packages: string[];
	/** Set in Code, whose sessions run behind the permission gate. */
	permissions?: PermissionSettings;
}

export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	/** How it is configured, such as "Logged in" or "Key from ANTHROPIC_API_KEY". */
	how: string;
	/** Login methods the provider offers, with their labels. */
	logins: { type: "api_key" | "oauth"; label: string }[];
	canLogout: boolean;
	models: number;
	/** An endpoint the user added in models.json, edited as a custom provider rather than logged in to. */
	custom?: boolean;
	/** In pi's own catalog, so its models can be changed through models.json. */
	preset?: boolean;
}

/** The APIs a custom provider can speak, as pi names them. */
export type CustomApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface CustomModel {
	id: string;
	name?: string;
	/** Tokens; pi assumes 128000 when unset. */
	contextWindow?: number;
	/** Most output tokens per response; pi assumes 16384 when unset. */
	maxTokens?: number;
	/** The model accepts images. */
	images: boolean;
	/** The model can think before it answers. */
	reasoning: boolean;
}

/** An endpoint in pi's models.json, such as Ollama, LM Studio, vLLM or a proxy, with the models it serves. */
export interface CustomProvider {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomApi;
	/** A key, $NAME for an environment variable or !command for a command's output. Empty when the endpoint needs none. */
	apiKey: string;
	models: CustomModel[];
}

/** How an MCP server's tools reach the agent, as pi names it in mcp.json. */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

/** What the Connectors page edits of an MCP server in pi's mcp.json. */
export interface ConnectorInput {
	name: string;
	/** "stdio" runs a program; "http" reaches a URL over streamable HTTP. */
	transport: "stdio" | "http";
	command: string;
	args: string[];
	/** Values may be ${NAME} for an environment variable or !command for a command's output. */
	env: Record<string, string>;
	url: string;
	headers: Record<string, string>;
	/** What the server offers, in a sentence. The agent sees it. */
	description: string;
}

/** An MCP server in pi's global mcp.json, with what Trivium learned the last time it connected. */
export interface ConnectorInfo extends ConnectorInput {
	enabled: boolean;
	exposure: McpExposure;
	/** Signs in through the browser: an HTTP server without an Authorization header or a pi login. */
	oauth: boolean;
	/** The last check's outcome; unset until Trivium has connected since it started. */
	state?: "connected" | "needs-auth" | "failed" | "disabled";
	/** The tools found at the last check, each with how it reaches the agent now. */
	tools: { name: string; exposure: McpExposure }[];
	resources: boolean;
	error?: string;
}

export interface ConnectorsView {
	/** pi's global mcp.json, which the pi CLI shares. */
	path: string;
	servers: ConnectorInfo[];
	/** Entries pi skips, and why. */
	errors: string[];
	/** When the last check finished. */
	checked?: number;
}

/** A model from a built-in provider's catalog, as pi offers it now. */
export interface PresetModel extends CustomModel {
	/** models.json changes some of what Trivium shows of it. */
	edited: boolean;
}

/** The details of a catalog model Trivium can change through models.json. */
export type PresetModelField = "name" | "contextWindow" | "maxTokens" | "images" | "reasoning";

/** A built-in provider's models, which models.json can change and add to like a custom endpoint's. */
export interface PresetProvider {
	id: string;
	name: string;
	/** The base URL pi's catalog gives. */
	defaultBaseUrl: string;
	/** The base URL models.json puts in its place; empty when it keeps the catalog's. */
	baseUrl: string;
	/** The API its models speak, when Trivium can ask it for a model list. */
	api?: CustomApi;
	/** Catalog models, which can be changed but not removed. */
	builtIn: PresetModel[];
	/** IDs of catalog models turned off, which Trivium leaves out of its model picker. */
	hidden: string[];
	/** Models added in models.json. */
	added: CustomModel[];
}

export interface PresetProviderChanges {
	/** Empty to use the catalog's. */
	baseUrl: string;
	/**
	 * Catalog models the user changed: the fields that changed, null to drop that change, and `reset` to drop
	 * every change Trivium makes before applying them.
	 */
	edits: { id: string; reset?: boolean; fields: { [K in PresetModelField]?: CustomModel[K] | null } }[];
	added: CustomModel[];
	/** Catalog models to leave out of the model picker, kept in Trivium's settings: pi's catalog has no such switch. */
	hidden: string[];
}

export interface AppInfo {
	version: string;
	piVersion: string;
	electron: string;
	node: string;
	agentDir: string;
	sessionsDir: string;
	triviumDir: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
}

/** pify memory's entry categories, written as `- [category] text`. */
export const MEMORY_CATEGORIES = ["convention", "failure", "correction", "tool-quirk", "insight", "preference"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** A memory file: the global one, a project's, or one day's log. */
export type MemoryTarget = { kind: "global" } | { kind: "project"; cwd: string } | { kind: "daily"; date: string };

export interface MemoryEntry {
	/** 0-based line in the file. */
	line: number;
	/** The line as it was read, so a change made on a stale page is refused. */
	raw: string;
	category?: MemoryCategory;
	text: string;
	/** HH:MM, for daily log entries. */
	time?: string;
	/** Within the part of the file that goes into each new session. */
	loaded: boolean;
	/** A failure or correction pify still recalls into new sessions, from a day that no longer loads. */
	recalled?: boolean;
}

export interface MemoryFile {
	path: string;
	exists: boolean;
	/** Characters pify counts against the limit: the file, trimmed. */
	chars: number;
	limit: number;
	/** Whether this file goes into new sessions at all. Only today's and yesterday's logs do. */
	loads: boolean;
	entries: MemoryEntry[];
}

export interface MemoryDay {
	date: string;
	file: MemoryFile;
}

export interface MemoryWorkspace {
	cwd: string;
	name: string;
	path: string;
	entries: number;
	/** The answer to "Load this project's memory?"; unset until asked. */
	consent?: boolean;
	git: "tracked" | "untracked" | "ignored" | "none";
}

export interface MemoryOverview {
	global: { path: string; entries: number };
	workspaces: MemoryWorkspace[];
	days: number;
	deleted: number;
}

export interface MemoryDeletion {
	id: string;
	timestamp: number;
	/** "replaced" is a whole-file snapshot, such as pify's /memory consolidate keeps. */
	kind: "deleted" | "replaced";
	items: { where: string; category?: MemoryCategory; text: string }[];
}

/** An edit the store refused with a reason to show beside the field, such as a credential in the text. */
export interface MemoryResult {
	error?: string;
}

export type AuthPromptRequest =
	| { id: string; type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { id: string; type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

export type LoginEvent =
	| { type: "prompt"; prompt: AuthPromptRequest }
	| { type: "info"; message: string; url?: string }
	| { type: "device_code"; code: string; url: string }
	| { type: "done"; ok: boolean; error?: string };

export interface SlashCommand {
	name: string;
	description?: string;
	/** Shown after the name, such as "<instructions>". */
	argumentHint?: string;
	source: "trivium" | "extension" | "prompt" | "skill";
	/** The command can suggest its arguments. */
	completes: boolean;
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

/** What one session's replies with one model on one day used, its subagents' replies included. */
export interface UsageBucket {
	/** Local date, as YYYY-MM-DD. */
	day: string;
	provider: string;
	model: string;
	responses: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollars, from pi's price list when the reply came. */
	cost: number;
	/** Milliseconds to the first token, added up over the `firstTokens` replies Trivium timed. */
	firstTokenMs: number;
	firstTokens: number;
	/**
	 * Milliseconds spent writing `streamed` output tokens, over the replies pi timed: from the first token when it was
	 * timed, else from when the request was sent.
	 */
	streamMs: number;
	streamed: number;
}

export interface SessionUsage {
	path: string;
	title: string;
	app: AppId;
	cwd: string;
	chat: boolean;
	buckets: UsageBucket[];
}

export interface UsageReport {
	/** Sessions with at least one counted reply. */
	sessions: SessionUsage[];
	/** Providers logged in through a subscription, whose replies pi records at no cost. */
	plans: string[];
	/** Today's local date, as YYYY-MM-DD. */
	today: string;
}

export interface TriviumApi {
	setWindowIcon(app: AppId): Promise<void>;
	setWindowChrome(color: string): Promise<void>;
	windowMinimize(): Promise<void>;
	/** Maximizes the window, or restores it when already maximized. Resolves to the resulting state. */
	windowToggleMaximize(): Promise<boolean>;
	windowClose(): Promise<void>;
	windowIsMaximized(): Promise<boolean>;
	onWindowMaximized(listener: (maximized: boolean) => void): () => void;
	listSessions(): Promise<SessionSummary[]>;
	listModels(): Promise<ModelOption[]>;
	profiles(): Promise<AppProfileInfo[]>;
	recentProjects(): Promise<string[]>;
	pickFolder(): Promise<string | undefined>;
	openSession(path: string): Promise<SessionView>;
	/** Says which sessions are on screen: one, or both halves of a split. */
	setVisible(paths: string[]): Promise<void>;
	newSession(input: NewSessionInput): Promise<SessionView>;
	/** Sends a new version of a run's message, in place of it and the replies that followed. */
	editMessage(path: string, run: number, text: string): Promise<void>;
	/** Copies the conversation before one of a session's runs into a new session, with that run's message to edit. */
	fork(path: string, run: number): Promise<{ view: SessionView; draft: Draft } | undefined>;
	/** Moves session files to the Trash. Returns the paths that were deleted. */
	deleteSessions(paths: string[]): Promise<string[]>;
	send(path: string, text: string, mode: "prompt" | "steer" | "followUp", attachments?: string[]): Promise<void>;
	/** Shows the file picker and prepares what was chosen. */
	pickAttachments(): Promise<AttachmentInfo[]>;
	attachPaths(paths: string[]): Promise<AttachmentInfo[]>;
	attachImageData(name: string, mimeType: string, base64: string): Promise<AttachmentInfo>;
	dropAttachments(ids: string[]): Promise<void>;
	/** The file path behind a dropped File, or "" when it has none. Synchronous; runs in the preload. */
	pathForFile(file: File): string;
	answerTrust(id: string, choice: TrustChoice): Promise<void>;
	abort(path: string): Promise<void>;
	commands(path: string): Promise<SlashCommand[]>;
	/** Argument suggestions for `/name prefix`, or an empty list. */
	completeCommand(path: string, name: string, prefix: string): Promise<CompletionItem[]>;
	setModel(path: string, modelKey: string, thinkingLevel: string): Promise<void>;
	answerDialog(id: string, answer: DialogAnswer): Promise<void>;
	/** Accepts changes; all files when `files` is omitted. */
	keepChanges(path: string, files?: string[]): Promise<FileChange[]>;
	/** Restores files to their state before the agent touched them; all files when `files` is omitted. */
	revertChanges(path: string, files?: string[]): Promise<FileChange[]>;
	/** The branch and changed files of the repository a Code session works in, or null when it is in none. */
	gitStatus(path: string): Promise<GitStatus | null>;
	/** One changed file's diff, as the session's latest git status lists it. */
	gitDiff(path: string, file: Pick<GitFile, "rel" | "area">): Promise<GitDiff>;
	openInEditor(file: string, line?: number): Promise<void>;
	/** The services every session's commands left running, by session path. */
	services(): Promise<Record<string, ServiceInfo[]>>;
	/** Ends a service and everything it started; fails if some of it is still running after. */
	stopService(id: string): Promise<void>;
	/** Opens a web address in the system browser. */
	openExternal(url: string): Promise<void>;
	/** Opens a file with its default app. */
	openFile(file: string): Promise<void>;
	/** Current text of a file this session changed. */
	readChangedFile(path: string, file: string): Promise<string>;
	/** Opens a file in the Preview panel: one in the session's project, or one it changed. Relative paths are from the project. */
	openReader(path: string, file: string): Promise<ReaderFile>;
	/** Shows the file picker and opens what was chosen in the Preview panel; undefined when cancelled. */
	pickReaderFile(path: string): Promise<ReaderFile | undefined>;
	reloadReader(id: string): Promise<ReaderFile>;
	/** Lets a page run its scripts, or stops it. The file comes back under a new id. */
	setReaderScripts(id: string, on: boolean): Promise<ReaderFile>;
	closeReader(id: string): Promise<void>;
	/** A transcript image at full size, as a data URL. */
	imageData(path: string, id: string): Promise<string>;
	/** Asks where to save a transcript image and writes it; false when cancelled. */
	saveImage(path: string, id: string, name: string): Promise<boolean>;
	reviewFile(path: string, file: string): Promise<FileReview>;
	/** Accepts or rejects one change. `expect` is the change as shown, so a stale view is refused. */
	resolveChange(
		path: string,
		file: string,
		id: number,
		action: "accept" | "reject",
		expect: { del: string; ins: string },
	): Promise<FileReview>;
	getSettings(): Promise<TriviumSettings>;
	updateSettings(patch: Partial<TriviumSettings>): Promise<TriviumSettings>;
	appDetails(app: AppId): Promise<AppDetails>;
	addExtension(app: AppId): Promise<AppDetails | undefined>;
	/** Installs a pi package from npm, git or a URL for every app, then describes this app again. */
	installPackage(app: AppId, source: string): Promise<AppDetails>;
	/** Sets Code's permission mode from Settings, then describes this app again. */
	setPermissionLevel(app: AppId, level: PermissionModeId): Promise<AppDetails>;
	/** Sets Code's permission mode from the composer. Every Code session, running ones too, follows it from its next tool call. */
	setSessionPermissions(level: PermissionModeId): Promise<PermissionSettings>;
	reloadApp(app: AppId): Promise<string[]>;
	/** Saves a session's conversation as Markdown, or its file as is, where the user picks. Resolves with the path. */
	exportSession(path: string): Promise<string | undefined>;
	copyText(text: string): Promise<void>;
	providers(): Promise<ProviderInfo[]>;
	login(providerId: string, type: "api_key" | "oauth"): Promise<void>;
	answerLogin(id: string, value: string | undefined): Promise<void>;
	logout(providerId: string): Promise<void>;
	customProviders(): Promise<CustomProvider[]>;
	/** Asks an endpoint which models it serves, with their limits and abilities where it says. */
	fetchModels(endpoint: Pick<CustomProvider, "baseUrl" | "api" | "apiKey">): Promise<CustomModel[]>;
	/** Writes a custom provider to models.json, replacing `previousId` when it was renamed. Resolves with them all. */
	saveCustomProvider(provider: CustomProvider, previousId?: string): Promise<CustomProvider[]>;
	removeCustomProvider(id: string): Promise<CustomProvider[]>;
	presetProvider(id: string): Promise<PresetProvider>;
	/** Asks a built-in provider which models it serves, with the credentials pi has for it. */
	fetchPresetModels(id: string, baseUrl: string): Promise<CustomModel[]>;
	savePresetProvider(id: string, changes: PresetProviderChanges): Promise<void>;
	setDefaultModel(modelKey: string, thinkingLevel: string): Promise<void>;
	/** MCP servers in pi's global mcp.json, with the last check's results. Connects to nothing. */
	connectors(): Promise<ConnectorsView>;
	/** Connects to every enabled server, as `pi mcp list` does, and lists their tools. */
	checkConnectors(): Promise<ConnectorsView>;
	/** Adds a server, or replaces `previousName`; settings the page doesn't edit are kept. */
	saveConnector(input: ConnectorInput, previousName?: string): Promise<ConnectorsView>;
	/** Adds the servers in pasted mcpServers JSON. `name` names a single entry pasted on its own. Resolves with the names added. */
	importConnectors(json: string, name?: string): Promise<{ view: ConnectorsView; added: string[] }>;
	removeConnector(name: string): Promise<ConnectorsView>;
	setConnector(name: string, patch: { enabled?: boolean; exposure?: McpExposure }): Promise<ConnectorsView>;
	/** Sets how one tool reaches the agent, apart from its server. */
	setToolExposure(name: string, tool: string, exposure: McpExposure): Promise<ConnectorsView>;
	/** Opens the server's sign-in page in the browser and waits until it is done, then checks again. */
	signInConnector(name: string): Promise<ConnectorsView>;
	signOutConnector(name: string): Promise<ConnectorsView>;
	appInfo(): Promise<AppInfo>;
	updateStatus(): Promise<UpdateStatus>;
	/** Asks GitHub for the latest release now. Resolves with what it found. */
	checkForUpdates(): Promise<UpdateStatus>;
	/** Downloads the release found, puts it in place and restarts into it. */
	installUpdate(): Promise<void>;
	openPath(path: string): Promise<void>;
	memoryOverview(): Promise<MemoryOverview>;
	memoryFile(target: MemoryTarget): Promise<MemoryFile>;
	/** Every daily log, newest first. */
	memoryDays(): Promise<MemoryDay[]>;
	memoryDeleted(): Promise<MemoryDeletion[]>;
	memoryAdd(target: MemoryTarget, category: MemoryCategory | undefined, text: string): Promise<MemoryResult>;
	memoryEdit(target: MemoryTarget, entry: Pick<MemoryEntry, "line" | "raw">, category: MemoryCategory | undefined, text: string): Promise<MemoryResult>;
	/** Deletes an entry, keeping it in pify's recovery folder. Resolves with the recovery id. */
	memoryDelete(target: MemoryTarget, entry: Pick<MemoryEntry, "line" | "raw">): Promise<string>;
	memoryMoveToTop(target: MemoryTarget, entry: Pick<MemoryEntry, "line" | "raw">): Promise<void>;
	memoryRestore(id: string): Promise<void>;
	setMemoryConsent(cwd: string, allowed: boolean): Promise<void>;
	/** Keeps a project's memory file out of git on this computer only, through .git/info/exclude. */
	keepMemoryLocal(cwd: string): Promise<void>;
	/** Tokens and cost from every session on this computer. */
	usage(): Promise<UsageReport>;
	onEvent(listener: (event: HostEvent) => void): () => void;
}
