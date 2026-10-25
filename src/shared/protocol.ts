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
}

export type StepStatus = "running" | "done" | "error";

export interface Step {
	id: string;
	tool: string;
	target: string;
	meta: string;
	tone: "plain" | "add" | "error";
	status: StepStatus;
	startedAt?: number;
	durationMs?: number;
	/** Last lines of live output, shown for a running bash step. */
	tail?: string;
}

export interface Run {
	id: string;
	prompt: string;
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
	| { type: "unloaded"; paths: string[] };

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

export interface DeskSettings {
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
	deskDir: string;
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

export interface DeskApi {
	listSessions(): Promise<SessionSummary[]>;
	listModels(): Promise<ModelOption[]>;
	profiles(): Promise<AppProfileInfo[]>;
	recentProjects(): Promise<string[]>;
	pickFolder(): Promise<string | undefined>;
	openSession(path: string): Promise<SessionView>;
	newSession(input: NewSessionInput): Promise<SessionView>;
	send(path: string, text: string, mode: "prompt" | "steer" | "followUp"): Promise<void>;
	abort(path: string): Promise<void>;
	clearQueue(path: string): Promise<QueueInfo>;
	setModel(path: string, modelKey: string, thinkingLevel: string): Promise<void>;
	answerDialog(id: string, answer: DialogAnswer): Promise<void>;
	/** Accepts changes; all files when `files` is omitted. */
	keepChanges(path: string, files?: string[]): Promise<FileChange[]>;
	/** Restores files to their state before the agent touched them; all files when `files` is omitted. */
	revertChanges(path: string, files?: string[]): Promise<FileChange[]>;
	openInEditor(file: string, line?: number): Promise<void>;
	getSettings(): Promise<DeskSettings>;
	updateSettings(patch: Partial<DeskSettings>): Promise<DeskSettings>;
	appDetails(app: AppId): Promise<AppDetails>;
	addExtension(app: AppId): Promise<AppDetails | undefined>;
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
