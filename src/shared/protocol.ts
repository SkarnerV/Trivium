// Types shared by the main process, the preload bridge and the renderer.

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
}

export interface Run {
	id: string;
	prompt: string;
	/** Files and images sent with the prompt; an image carries what fetches and previews it. */
	attachments?: { name: string; kind: "image" | "file"; id?: string; mimeType?: string; thumb?: string }[];
	steps: Step[];
	/** Assistant text after the last tool call: the run's answer. */
	answer: string;
	status: "running" | "done" | "aborted" | "error";
	startedAt?: number;
	endedAt?: number;
	error?: string;
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
	app: AppId;
	title: string;
	runs: Run[];
	running: boolean;
	model?: string;
	thinkingLevel: string;
	context?: ContextInfo;
	queue: QueueInfo;
	changes: FileChange[];
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
	| { type: "status"; path: string; running: boolean; context?: ContextInfo; queue: QueueInfo; title: string }
	| { type: "changes"; path: string; changes: FileChange[] }
	| { type: "dialog"; request: DialogRequest }
	| { type: "dialog_closed"; id: string }
	| { type: "notice"; notice: Notice }
	| { type: "login"; event: LoginEvent }
	| { type: "focus_session"; path: string }
	| { type: "unloaded"; paths: string[] }
	| { type: "trust"; request: TrustRequest }
	| { type: "trust_closed"; id: string };

export interface NewSessionInput {
	app: AppId;
	cwd: string;
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
}

export interface TriviumSettings {
	/** Window zoom factor, 1 = 100%. */
	textSize: number;
	/** Minutes before an idle, unviewed session is unloaded. 0 keeps sessions loaded. */
	idleMinutes: number;
	notifyDone: boolean;
	notifyWaiting: boolean;
	apps: Record<AppId, AppSettings>;
}

export type ExtensionSource = "App" | "Added" | "Global" | "Project" | "Package" | "Built-in" | "Dev";

export interface ExtensionInfo {
	/** Resolved path, the key used to turn it off. */
	path: string;
	name: string;
	/** Path as shown: shortened, or a package or builtin name. */
	display: string;
	source: ExtensionSource;
	on: boolean;
	/** What it adds: tools, commands, event handlers. */
	registers: string[];
	error?: string;
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
	newSession(input: NewSessionInput): Promise<SessionView>;
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
	clearQueue(path: string): Promise<QueueInfo>;
	setModel(path: string, modelKey: string, thinkingLevel: string): Promise<void>;
	answerDialog(id: string, answer: DialogAnswer): Promise<void>;
	/** Accepts changes; all files when `files` is omitted. */
	keepChanges(path: string, files?: string[]): Promise<FileChange[]>;
	/** Restores files to their state before the agent touched them; all files when `files` is omitted. */
	revertChanges(path: string, files?: string[]): Promise<FileChange[]>;
	openInEditor(file: string, line?: number): Promise<void>;
	/** Opens a file with its default app. */
	openFile(file: string): Promise<void>;
	/** Current text of a file this session changed. */
	readChangedFile(path: string, file: string): Promise<string>;
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
	reloadApp(app: AppId): Promise<string[]>;
	providers(): Promise<ProviderInfo[]>;
	login(providerId: string, type: "api_key" | "oauth"): Promise<void>;
	answerLogin(id: string, value: string | undefined): Promise<void>;
	logout(providerId: string): Promise<void>;
	setDefaultModel(modelKey: string, thinkingLevel: string): Promise<void>;
	appInfo(): Promise<AppInfo>;
	openPath(path: string): Promise<void>;
	onEvent(listener: (event: HostEvent) => void): () => void;
}
