import { useSyncExternalStore } from "react";
import type {
	AppId,
	Draft,
	TriviumApi,
	TriviumSettings,
	LoginEvent,
	DialogRequest,
	GitStatus,
	HostEvent,
	ModelOption,
	NewSessionInput,
	ReaderFile,
	ServiceInfo,
	TrustRequest,
	Notice,
	SessionSummary,
	SessionView,
	TranscriptImage,
	UpdateStatus,
} from "../shared/protocol.ts";
import { type Locale, resolveLocale, setLocale, t } from "../shared/i18n.ts";
import type { PermissionModeId } from "../shared/permissions.ts";
import { type CodeView, codeTab, codeViews } from "./panels.ts";
import { type Split, placeInSplit, showInSplit, visibleSessions, withoutSessions } from "./split.ts";
import { transition } from "./transition.ts";

declare global {
	interface Window {
		trivium: TriviumApi;
	}
}

export const trivium = window.trivium;

export interface State {
	app: AppId;
	/** The session shown in each app, by session path; in a split, the focused one. */
	selected: Partial<Record<AppId, string>>;
	/** The two sessions side by side in each app, left first; unset when the app shows one. */
	split: Partial<Record<AppId, Split>>;
	sessions: SessionSummary[];
	views: Record<string, SessionView>;
	dialogs: DialogRequest[];
	notices: Notice[];
	models: ModelOption[];
	folded: boolean;
	peek: boolean;
	/** Project groups folded in the sidebar, keyed "app:cwd". */
	collapsed: Record<string, boolean>;
	/** Project groups kept at the top of the sidebar, keyed "app:cwd". */
	pinnedProjects: Record<string, boolean>;
	/** Sessions kept at the top of their project, by session path. */
	pinnedSessions: Record<string, boolean>;
	/** Widths the user dragged the sidebar and the right panel to; unset means the default. */
	sidebarWidth?: number;
	panelWidth?: number;
	/** Width the user dragged the left half of a split to; unset means half the room. */
	splitWidth?: number;
	/** Sessions whose side panel the user closed (true) or opened (false); unset follows whether it has content. */
	changesHidden: Record<string, boolean>;
	/** The views open as tabs in each session's Code panel, oldest first; unset opens the one it has most to show in. */
	panelTabs: Record<string, CodeView[]>;
	/** The Code panel tab the user picked for each session; unset shows the one opened last. */
	panelTab: Record<string, CodeView>;
	/** Sessions showing the summary cards beside the conversation. */
	summaryShown: Record<string, boolean>;
	/** The files open in each session's Preview panel, oldest first, and the one showing. */
	previews: Record<string, { files: ReaderFile[]; active?: string }>;
	/** The repository each Code session works in, by session path; null when it is in none. */
	git: Record<string, GitStatus | null>;
	/** What each session's commands left running, by session path, whether or not the session is loaded. */
	services: Record<string, ServiceInfo[]>;
	overlay: "new" | "search" | null;
	page: "main" | "settings" | "memory";
	settingsSection: SettingsSection;
	settings?: TriviumSettings;
	/** The language the interface is in, from the settings; the whole app renders again when it changes. */
	locale: Locale;
	/** Text to put in a session's message box when it next shows. */
	drafts: Record<string, Draft>;
	/** Messages written while a session ran, by session path, oldest first. They go out one by one as its runs end. */
	queued: Record<string, QueuedMessage[]>;
	/** Projects asking to load their .pi resources, oldest first. */
	trust: TrustRequest[];
	/** The transcript image open in the lightbox, and the session it belongs to. */
	preview?: { path: string; image: TranscriptImage };
	/** A question waiting for Confirm or Cancel. */
	confirm?: ConfirmRequest;
	/** The provider login in progress, and what it last reported. */
	login?: { providerId: string; name: string; events: LoginEvent[] };
	/** Whether a newer Trivium is out, and how far installing it has got. */
	update: UpdateStatus;
}

export interface QueuedMessage extends Draft {
	id: number;
}

export interface ConfirmRequest {
	title: string;
	message: string;
	confirmLabel: string;
	resolve: (ok: boolean) => void;
}

export type SettingsSection = "general" | "models" | "connectors" | "usage" | "shortcuts" | AppId | "about";

const PREFS_KEY = "trivium.prefs";

const PREF_KEYS = ["app", "folded", "selected", "split", "collapsed", "pinnedProjects", "pinnedSessions", "sidebarWidth", "panelWidth", "splitWidth"] as const;

function loadPrefs(): Pick<State, (typeof PREF_KEYS)[number]> {
	try {
		const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<State>;
		return {
			app: parsed.app ?? "code",
			folded: parsed.folded ?? false,
			selected: parsed.selected ?? {},
			split: parsed.split ?? {},
			collapsed: parsed.collapsed ?? {},
			pinnedProjects: parsed.pinnedProjects ?? {},
			pinnedSessions: parsed.pinnedSessions ?? {},
			sidebarWidth: parsed.sidebarWidth,
			panelWidth: parsed.panelWidth,
			splitWidth: parsed.splitWidth,
		};
	} catch {
		return { app: "code", folded: false, selected: {}, split: {}, collapsed: {}, pinnedProjects: {}, pinnedSessions: {} };
	}
}

let state: State = {
	...loadPrefs(),
	sessions: [],
	views: {},
	dialogs: [],
	notices: [],
	models: [],
	peek: false,
	changesHidden: {},
	panelTabs: {},
	panelTab: {},
	summaryShown: {},
	previews: {},
	git: {},
	services: {},
	drafts: {},
	queued: {},
	trust: [],
	page: "main",
	settingsSection: "general",
	overlay: null,
	update: { state: "idle" },
	locale: "en",
};

const listeners = new Set<() => void>();

export function getState(): State {
	return state;
}

export function setState(patch: Partial<State> | ((current: State) => Partial<State>)): void {
	const next = typeof patch === "function" ? patch(state) : patch;
	state = { ...state, ...next };
	if (PREF_KEYS.some((key) => key in next)) {
		try {
			localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(PREF_KEYS.map((key) => [key, state[key]]))));
		} catch {
			// Preferences are a convenience; the app works without them.
		}
	}
	if ("app" in next || "selected" in next || "split" in next) reportVisible();
	for (const listener of listeners) listener();
}

let visibleKey: string | undefined;

/** Tells the host which sessions are on screen, so their runs finish read and they are never unloaded for being idle. */
function reportVisible(): void {
	const paths = visibleSessions(state.split[state.app], state.selected[state.app]);
	const key = paths.join("\n");
	if (key === visibleKey) return;
	visibleKey = key;
	void trivium.setVisible(paths).catch(console.error);
}

export function useStore<T>(select: (state: State) => T): T {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => select(state),
	);
}

const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function notify(message: string, level: Notice["level"] = "error"): void {
	const notice: Notice = { id: crypto.randomUUID(), message, level };
	setState((s) => ({ notices: [...s.notices, notice] }));
	noticeTimers.set(notice.id, setTimeout(() => dismissNotice(notice.id), level === "error" ? 8000 : 4000));
}

/** Keeps a notice up until the user dismisses it, such as once they expand it to read. */
export function holdNotice(id: string): void {
	clearTimeout(noticeTimers.get(id));
	noticeTimers.delete(id);
}

export function dismissNotice(id: string): void {
	holdNotice(id);
	setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

export function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	// Electron prefixes IPC errors with the channel name.
	return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
	try {
		return await fn();
	} catch (error) {
		notify(errorText(error));
		return undefined;
	}
}

function handleEvent(event: HostEvent): void {
	switch (event.type) {
		case "sessions":
			setState({ sessions: event.sessions });
			break;
		case "view":
			setState((s) => ({ views: { ...s.views, [event.view.path]: event.view } }));
			break;
		case "run":
			setState((s) => {
				const view = s.views[event.path];
				if (!view) return {};
				const runs = view.runs.slice();
				runs[event.index] = event.run;
				return { views: { ...s.views, [event.path]: { ...view, runs } } };
			});
			break;
		case "status":
			setState((s) => {
				const view = s.views[event.path];
				const sessions = s.sessions.map((session) =>
					session.path === event.path ? { ...session, running: event.running, title: event.title } : session,
				);
				if (!view) return { sessions };
				return {
					sessions,
					views: {
						...s.views,
						[event.path]: {
							...view,
							running: event.running,
							compacting: event.compacting,
							context: event.context,
							queue: event.queue,
							title: event.title,
						},
					},
				};
			});
			// A queued message goes out once the session is free; one that just went out is busy now.
			if (event.running || event.compacting) sendingQueued.delete(event.path);
			else void sendNextQueued(event.path);
			break;
		case "changes":
			setState((s) => {
				const view = s.views[event.path];
				return view ? { views: { ...s.views, [event.path]: { ...view, changes: event.changes } } } : {};
			});
			break;
		case "git":
			setState((s) => ({ git: { ...s.git, [event.path]: event.git } }));
			break;
		case "dialog":
			setState((s) => ({ dialogs: [...s.dialogs, event.request] }));
			break;
		case "dialog_closed":
			setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== event.id) }));
			break;
		case "notice":
			notify(event.notice.message, event.notice.level);
			break;
		case "login":
			setState((s) => (s.login ? { login: { ...s.login, events: [...s.login.events, event.event] } } : {}));
			break;
		case "trust":
			setState((s) => ({ trust: [...s.trust, event.request] }));
			break;
		case "trust_closed":
			setState((s) => ({ trust: s.trust.filter((request) => request.id !== event.id) }));
			break;
		case "reader_changed":
			void reloadPreview(event.id);
			break;
		case "services":
			setState({ services: event.services });
			break;
		case "update": {
			const before = getState().update;
			setState({ update: event.update });
			if (event.update.state === "available" && !(before.state === "available" && before.release.version === event.update.release.version)) {
				notify(t("Trivium {version} is available", { version: event.update.release.version }), "info");
			}
			break;
		}
		case "focus_session":
			setState({ page: "main" });
			void openSession(event.path);
			break;
		case "unloaded": {
			const gone = new Set(event.paths);
			setState((s) => ({ views: Object.fromEntries(Object.entries(s.views).filter(([path]) => !gone.has(path))) }));
			// The sessions on screen reload at once with the new setup.
			const { selected, split, app, page } = getState();
			const current = selected[app];
			if (current && gone.has(current) && page === "main") void loadSession(current, navigation);
			const beside = split[app]?.find((path) => path !== current);
			if (beside && gone.has(beside) && page === "main") void loadBeside(beside);
			break;
		}
	}
}

/** Stops a service; it leaves the list once its processes are gone. */
export async function stopService(id: string): Promise<void> {
	await attempt(() => trivium.stopService(id));
}

/** Reads a Code session's git status, keeping the one on screen when nothing changed. */
export async function refreshGit(path: string): Promise<void> {
	let git: GitStatus | null;
	try {
		git = await trivium.gitStatus(path);
	} catch {
		// A folder git cannot read shows no git info, as one outside a repository does.
		git = null;
	}
	if (JSON.stringify(git) !== JSON.stringify(state.git[path])) setState((s) => ({ git: { ...s.git, [path]: git } }));
}

/** More than this, and opening another file closes the one opened longest ago. */
const MAX_PREVIEWS = 6;

/** Opens a file in a session's Preview panel and shows it there. Relative paths are from the session's project. */
export async function openPreview(path: string, file: string): Promise<void> {
	const opened = await attempt(() => trivium.openReader(path, file));
	if (opened) showPreview(path, opened);
}

/** Lets the user pick any file to preview. */
export async function pickPreview(path: string): Promise<void> {
	const opened = await attempt(() => trivium.pickReaderFile(path));
	if (opened) showPreview(path, opened);
}

/** Opens a local service's page in a session's Preview panel. */
export function openWebPreview(path: string, url: string): void {
	const { host } = new URL(url);
	showPreview(path, { id: `web:${url}`, path: url, rel: url, name: host, kind: "web", size: 0, mtime: Date.now(), url, scripts: true });
}

function showPreview(path: string, opened: ReaderFile): void {
	const files = getState().previews[path]?.files ?? [];
	// The same file opened again takes the old one's place, so it is never open twice.
	const same = files.find((file) => file.path === opened.path);
	let next = same ? files.map((file) => (file === same ? opened : file)) : [...files, opened];
	const closing = same ? [same] : [];
	while (next.length > MAX_PREVIEWS) {
		closing.push(next[0]!);
		next = next.slice(1);
	}
	for (const file of closing) if (file.kind !== "web") void trivium.closeReader(file.id).catch(() => {});
	transition("tab", () => {
		setState((s) => ({ previews: { ...s.previews, [path]: { files: next, active: opened.id } } }));
		showPanelView(path, "preview");
	});
}

function openViews(s: State, path: string): CodeView[] {
	return s.views[path] ? codeViews(s.panelTabs[path]) : (s.panelTabs[path] ?? []);
}

/** Opens a view as a tab in a session's Code panel, or goes to its tab when it is open already, and shows the panel. */
export function showPanelView(path: string, name: CodeView): void {
	setState((s) => {
		const open = openViews(s, path);
		return {
			panelTabs: { ...s.panelTabs, [path]: open.includes(name) ? open : [...open, name] },
			panelTab: { ...s.panelTab, [path]: name },
			changesHidden: { ...s.changesHidden, [path]: false },
		};
	});
}

/** Closes a view's tab; the one beside it shows next. Closing the last tab hides the panel. */
export function closePanelView(path: string, name: CodeView): void {
	setState((s) => {
		const open = openViews(s, path);
		const index = open.indexOf(name);
		const next = open.filter((other) => other !== name);
		if (!next.length) {
			const { [path]: _, ...rest } = s.panelTabs;
			return { panelTabs: rest, changesHidden: { ...s.changesHidden, [path]: true } };
		}
		const showing = codeTab(open, s.panelTab[path]);
		return {
			panelTabs: { ...s.panelTabs, [path]: next },
			panelTab: { ...s.panelTab, [path]: showing === name ? next[Math.min(index, next.length - 1)]! : showing },
		};
	});
}

export function selectPreview(path: string, id: string): void {
	transition("tab", () => setState((s) => ({ previews: { ...s.previews, [path]: { files: s.previews[path]?.files ?? [], active: id } } })));
}

/** Closes a file; the one beside it shows next. Closing the last one closes the Preview tab. */
export function closePreview(path: string, id: string): void {
	if (!id.startsWith("web:")) void trivium.closeReader(id).catch(() => {});
	setState((s) => {
		const files = s.previews[path]?.files ?? [];
		const index = files.findIndex((file) => file.id === id);
		const next = files.filter((file) => file.id !== id);
		const active = s.previews[path]?.active === id ? next[Math.min(index, next.length - 1)]?.id : s.previews[path]?.active;
		return { previews: { ...s.previews, [path]: { files: next, active } } };
	});
	if (!getState().previews[path]?.files.length) closePanelView(path, "preview");
}

/** Puts a file's new state in place of its old one, wherever it is open; `id` is the one it had. */
function replacePreview(id: string, file: ReaderFile): void {
	setState((s) => ({
		previews: Object.fromEntries(
			Object.entries(s.previews).map(([path, open]) => [
				path,
				open.files.some((f) => f.id === id)
					? { files: open.files.map((f) => (f.id === id ? file : f)), active: open.active === id ? file.id : open.active }
					: open,
			]),
		),
	}));
}

/** Reads a file again after it changed on disk. One that is gone stays as it was last seen. A page loads again. */
export async function reloadPreview(id: string): Promise<void> {
	if (id.startsWith("web:")) {
		const page = Object.values(state.previews)
			.flatMap((open) => open.files)
			.find((f) => f.id === id);
		if (page) replacePreview(id, { ...page, mtime: Date.now() });
		return;
	}
	const file = await trivium.reloadReader(id).catch(() => undefined);
	if (file) replacePreview(id, file);
}

export async function setPreviewScripts(id: string, on: boolean): Promise<void> {
	const file = await attempt(() => trivium.setReaderScripts(id, on));
	if (file) replacePreview(id, file);
}

export async function refreshSessions(): Promise<SessionSummary[] | undefined> {
	const sessions = await attempt(() => trivium.listSessions());
	if (sessions) setState({ sessions });
	return sessions;
}

/**
 * Counts the user's moves to another app or session. Loading a session takes a while, so one that lands after a
 * newer move only keeps its view and leaves the screen where the user went.
 */
let navigation = 0;

export function openSession(path: string): Promise<void> {
	return loadSession(path, ++navigation);
}

/** Loads a session and shows it if `ticket` is still the latest move; a reload passes the current one. */
async function loadSession(path: string, ticket: number): Promise<void> {
	const view = await attempt(() => trivium.openSession(path));
	if (!view) return;
	const keep = () => setState((s) => ({ views: { ...s.views, [path]: view } }));
	if (ticket !== navigation) return keep();
	const before = getState();
	const show = () =>
		setState((s) => ({
			views: { ...s.views, [path]: view },
			selected: { ...s.selected, [view.app]: path },
			split: withSplit(s.split, view.app, showInSplit(s.split[view.app], s.selected[view.app], path)),
			app: view.app,
			peek: false,
			overlay: null,
			sessions: s.sessions.map((session) => (session.path === path ? { ...session, unread: false } : session)),
		}));
	// Reloading the session already on screen is not a switch.
	const shown = before.page === "main" && before.app === view.app && before.selected[view.app] === path && before.views[path];
	if (shown) show();
	else transition(before.app === view.app ? "session" : "app", show);
	void refreshModels();
}

function withSplit(split: State["split"], app: AppId, pair: Split | undefined): State["split"] {
	const { [app]: _, ...rest } = split;
	return pair ? { ...rest, [app]: pair } : rest;
}

/** Loads a session for the half of the split that is not focused, without moving focus to it. */
async function loadBeside(path: string): Promise<void> {
	const view = await attempt(() => trivium.openSession(path));
	if (view) setState((s) => ({ views: { ...s.views, [path]: view } }));
}

/** Loads the half of the app's split that is not focused, when it is not loaded yet. */
function loadSplit(app: AppId): void {
	const { split, selected, views } = getState();
	const beside = split[app]?.find((path) => path !== selected[app]);
	if (beside && !views[beside]) void loadBeside(beside);
}

/**
 * Shows a session beside the focused one, or in the given half (0 is the left), and focuses it. A session of
 * another app, or with no session on screen to pair it with, opens as usual.
 */
export async function openInSplit(path: string, side?: 0 | 1): Promise<void> {
	const before = getState();
	const app = before.sessions.find((session) => session.path === path)?.app ?? before.views[path]?.app;
	const pair = app === before.app && before.page === "main" ? placeInSplit(before.split[app], before.selected[app], path, side) : undefined;
	if (!app || !pair) return openSession(path);
	const ticket = ++navigation;
	const view = before.views[path] ?? (await attempt(() => trivium.openSession(path)));
	if (!view) return;
	if (ticket !== navigation) {
		setState((s) => ({ views: { ...s.views, [path]: view } }));
		return;
	}
	transition("session", () =>
		setState((s) => ({
			views: { ...s.views, [path]: view },
			selected: { ...s.selected, [app]: path },
			split: withSplit(s.split, app, pair),
			peek: false,
			overlay: null,
			sessions: s.sessions.map((session) => (session.path === path ? { ...session, unread: false } : session)),
		})),
	);
}

/** Makes one half of the split the one the keyboard, the sidebar and the side panel act on. */
export function focusPane(path: string): void {
	const { app, selected, split } = getState();
	if (selected[app] !== path && split[app]?.includes(path)) setState((s) => ({ selected: { ...s.selected, [app]: path } }));
}

/** Closes one half of the split; the other session fills the card. */
export function closePane(path: string): void {
	const { app, split } = getState();
	const other = split[app]?.find((item) => item !== path);
	if (!other) return;
	transition("session", () => setState((s) => ({ split: withSplit(s.split, app, undefined), selected: { ...s.selected, [app]: other } })));
}

/** Closes the split, keeping the focused session, or opens the latest other session beside the one on screen. */
export function toggleSplit(): void {
	const { app, selected, split, sessions } = getState();
	const focused = selected[app];
	if (!focused) return;
	const beside = split[app]?.find((path) => path !== focused);
	if (beside) {
		closePane(beside);
		return;
	}
	const latest = sessions.find((session) => session.app === app && session.path !== focused);
	if (latest) void openInSplit(latest.path);
}

export async function refreshModels(): Promise<void> {
	// Extensions can register providers when a session starts, so the list can grow.
	const models = await attempt(() => trivium.listModels());
	if (models) setState({ models });
}

/** Starts a session and shows it. `draft` goes into its message box, unsent. */
export async function startSession(input: NewSessionInput, draft?: string): Promise<SessionView | undefined> {
	const ticket = ++navigation;
	const view = await attempt(() => trivium.newSession(input));
	if (!view) return undefined;
	const keep = (s: State): Partial<State> => ({
		drafts: draft ? { ...s.drafts, [view.path]: { text: draft, attachments: [] } } : s.drafts,
		views: { ...s.views, [view.path]: view },
	});
	if (ticket !== navigation) setState(keep);
	else
		transition(getState().app === input.app ? "session" : "app", () =>
			setState((s) => ({
				...keep(s),
				selected: { ...s.selected, [input.app]: view.path },
				split: withSplit(s.split, input.app, showInSplit(s.split[input.app], s.selected[input.app], view.path)),
				app: input.app,
				overlay: null,
			})),
		);
	void refreshSessions();
	void refreshModels();
	return view;
}

let queuedIds = 0;
/** Sessions that were sent their next queued message and have not started its run yet. */
const sendingQueued = new Set<string>();
/** Sessions the user stopped: their queue waits until they send something again. */
const heldQueues = new Set<string>();

function setQueue(path: string, update: (list: QueuedMessage[]) => QueuedMessage[]): void {
	setState((s) => {
		const { [path]: list = [], ...rest } = s.queued;
		const next = update(list);
		return { queued: next.length ? { ...rest, [path]: next } : rest };
	});
}

function busy(path: string): boolean {
	const { views, sessions } = getState();
	const view = views[path];
	return view ? view.running || view.compacting : (sessions.find((session) => session.path === path)?.running ?? false);
}

/** Keeps a message for when the session's run ends. Its attachments stay stored until it is sent or deleted. */
export function queueMessage(path: string, draft: Draft): void {
	setQueue(path, (list) => [...list, { ...draft, id: ++queuedIds }]);
}

/** Takes a message out of the queue, such as to edit it; its attachments stay stored. */
export function unqueueMessage(path: string, id: number): QueuedMessage | undefined {
	const message = getState().queued[path]?.find((item) => item.id === id);
	if (message) setQueue(path, (list) => list.filter((item) => item.id !== id));
	return message;
}

export function deleteQueued(path: string, id: number): void {
	const message = unqueueMessage(path, id);
	if (message?.attachments.length) void trivium.dropAttachments(message.attachments.map((item) => item.id));
}

/** Stops the queue going out when the current run ends, as when the user stops the run. */
export function holdQueue(path: string): void {
	heldQueues.add(path);
}

/** Lets the queue go out again once the session is free. */
export function resumeQueue(path: string): void {
	heldQueues.delete(path);
}

/** Sends a queued message now: into the running turn as a steer, or as the next prompt when nothing runs. */
export async function sendQueuedNow(path: string, id: number): Promise<void> {
	const index = getState().queued[path]?.findIndex((item) => item.id === id) ?? -1;
	const message = unqueueMessage(path, id);
	if (!message) return;
	resumeQueue(path);
	await sendQueued(path, message, busy(path) ? "steer" : "prompt", index);
}

async function sendNextQueued(path: string): Promise<void> {
	if (sendingQueued.has(path) || heldQueues.has(path) || busy(path)) return;
	const next = getState().queued[path]?.[0];
	if (!next) return;
	unqueueMessage(path, next.id);
	await sendQueued(path, next, "prompt", 0);
}

/** A message that fails to send goes back where it was in the queue, and the queue waits for the user. */
async function sendQueued(path: string, message: QueuedMessage, mode: "prompt" | "steer", index: number): Promise<void> {
	if (mode === "prompt") sendingQueued.add(path);
	const ids = message.attachments.map((item) => item.id);
	const sent = await attempt(() => trivium.send(path, message.text, mode, ids).then(() => true));
	if (!sent) {
		sendingQueued.delete(path);
		holdQueue(path);
		setQueue(path, (list) => [...list.slice(0, index), message, ...list.slice(index)]);
	} else if (mode === "prompt" && message.text.startsWith("/")) {
		// A command such as /name starts no run, so no run's end would send the next message.
		setTimeout(() => {
			if (busy(path)) return;
			sendingQueued.delete(path);
			void sendNextQueued(path);
		}, 1000);
	}
}

/** Sends a new version of an earlier message. Resolves false when it could not be sent. */
export async function editMessage(path: string, run: number, text: string): Promise<boolean> {
	return (await attempt(() => trivium.editMessage(path, run, text).then(() => true))) ?? false;
}

/** Copies a session up to one of its runs into a new session and shows it, with that run's message to edit. */
export async function forkFrom(path: string, run: number): Promise<void> {
	const ticket = ++navigation;
	const result = await attempt(() => trivium.fork(path, run));
	if (!result) return;
	const { view, draft } = result;
	const keep = (s: State): Partial<State> => ({ drafts: { ...s.drafts, [view.path]: draft }, views: { ...s.views, [view.path]: view } });
	if (ticket !== navigation) setState(keep);
	else
		transition("session", () =>
			setState((s) => ({
				...keep(s),
				selected: { ...s.selected, [view.app]: view.path },
				split: withSplit(s.split, view.app, showInSplit(s.split[view.app], s.selected[view.app], view.path)),
				app: view.app,
				overlay: null,
			})),
		);
	void refreshSessions();
}

/** Code's permission mode is one for every Code session, so each open one shows the new mode. */
export function showPermissionMode(level: PermissionModeId): void {
	setState((s) => ({
		views: Object.fromEntries(Object.entries(s.views).map(([path, view]) => [path, view.permissions ? { ...view, permissions: { level } } : view])),
	}));
}

export function switchApp(app: AppId): void {
	const { app: current, page } = getState();
	if (app === current && page === "main") return;
	const ticket = ++navigation;
	transition(page === "main" ? "app" : "page", () => setState({ app, peek: false, page: "main" }));
	const path = getState().selected[app];
	if (path && !getState().views[path]) void loadSession(path, ticket);
	loadSplit(app);
}

/** Shows a confirm dialog and resolves with the answer. */
export function askConfirm(request: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
	return new Promise((resolve) => {
		getState().confirm?.resolve(false);
		setState({
			confirm: {
				...request,
				resolve: (ok) => {
					setState({ confirm: undefined });
					resolve(ok);
				},
			},
		});
	});
}

/** Moves sessions to the Trash and forgets them everywhere in the UI. */
export async function deleteSessions(paths: string[]): Promise<void> {
	const deleted = await attempt(() => trivium.deleteSessions(paths));
	if (!deleted?.length) return;
	const gone = new Set(deleted);
	const left = deleted.flatMap((path) => [
		...(getState().drafts[path]?.attachments ?? []),
		...(getState().queued[path] ?? []).flatMap((message) => message.attachments),
	]);
	if (left.length) void trivium.dropAttachments(left.map((item) => item.id));
	setState((s) => ({
		drafts: Object.fromEntries(Object.entries(s.drafts).filter(([path]) => !gone.has(path))),
		queued: Object.fromEntries(Object.entries(s.queued).filter(([path]) => !gone.has(path))),
		sessions: s.sessions.filter((session) => !gone.has(session.path)),
		views: Object.fromEntries(Object.entries(s.views).filter(([path]) => !gone.has(path))),
		...withoutSessions(s.split, s.selected, (path) => gone.has(path)),
		dialogs: s.dialogs.filter((dialog) => !gone.has(dialog.sessionPath)),
		changesHidden: Object.fromEntries(Object.entries(s.changesHidden).filter(([path]) => !gone.has(path))),
		panelTabs: Object.fromEntries(Object.entries(s.panelTabs).filter(([path]) => !gone.has(path))),
		summaryShown: Object.fromEntries(Object.entries(s.summaryShown).filter(([path]) => !gone.has(path))),
		pinnedSessions: Object.fromEntries(Object.entries(s.pinnedSessions).filter(([path]) => !gone.has(path))),
	}));
	notify(deleted.length === 1 ? t("Session moved to the Trash") : t("{n} sessions moved to the Trash", { n: deleted.length }), "info");
}

/** Pins or unpins a project group ("app:cwd") or a session (its path) in the sidebar. */
export function togglePin(kind: "pinnedProjects" | "pinnedSessions", key: string): void {
	setState((s) => {
		const { [key]: was, ...rest } = s[kind];
		return { [kind]: was ? rest : { ...rest, [key]: true } };
	});
}

export function openSettings(section?: SettingsSection): void {
	const update = () => setState((s) => ({ page: "settings", settingsSection: section ?? s.settingsSection, overlay: null, peek: false }));
	const { page, settingsSection } = getState();
	if (page !== "settings") transition("page", update);
	else if (section && section !== settingsSection) transition("section", update);
	else update();
}

export function openMemory(): void {
	if (getState().page !== "memory") transition("page", () => setState({ page: "memory", overlay: null, peek: false }));
}

/** Back to the session on screen, from Settings or Memory. */
export function closeSettings(): void {
	if (getState().page !== "main") transition("page", () => setState({ page: "main" }));
	const { selected, app, views } = getState();
	const path = selected[app];
	if (path && !views[path]) void loadSession(path, navigation);
	loadSplit(app);
}

/** Installs the release found and restarts, or opens its page when Trivium can't install it itself. */
export async function installUpdate(): Promise<void> {
	const { update, sessions } = getState();
	const release = "release" in update ? update.release : undefined;
	if (!release) return;
	if (!release.installable) {
		await attempt(() => trivium.openExternal(release.url));
		return;
	}
	const running = sessions.filter((session) => session.running).length;
	if (
		running &&
		!(await askConfirm({
			title: t("Restart to update?"),
			message: t(
				running === 1
					? "Trivium restarts once {version} is downloaded, which stops the session that is running."
					: "Trivium restarts once {version} is downloaded, which stops the {n} sessions that are running.",
				{ version: release.version, n: running },
			),
			confirmLabel: t("Update and restart"),
		}))
	) {
		return;
	}
	await attempt(() => trivium.installUpdate());
}

/** Shows new settings, in the language they pick. */
export function showSettings(settings: TriviumSettings): void {
	const locale = resolveLocale(settings.language, navigator.languages);
	setLocale(locale);
	document.documentElement.lang = locale;
	setState({ settings, locale });
}

export async function updateSettings(patch: Partial<TriviumSettings>): Promise<void> {
	const next = await attempt(() => trivium.updateSettings(patch));
	if (next) showSettings(next);
}

export async function init(): Promise<void> {
	trivium.onEvent(handleEvent);
	const settings = await attempt(() => trivium.getSettings());
	if (settings) showSettings(settings);
	const services = await attempt(() => trivium.services());
	if (services) setState({ services });
	// A failed install from the last restart is reported before this page could hear of it.
	const update = await attempt(() => trivium.updateStatus());
	if (update) setState({ update });
	if (update?.state === "error") notify(update.message);
	const sessions = await refreshSessions();
	// Forget remembered sessions that are gone or filed under another app, so switching apps never opens them.
	if (sessions) {
		setState((s) => {
			const elsewhere = (app: string) => (path: string) => !sessions.some((session) => session.path === path && session.app === app);
			const selected = Object.fromEntries(Object.entries(s.selected).filter(([app, path]) => path && !elsewhere(app)(path)));
			const split = Object.fromEntries(Object.entries(s.split).filter(([app, pair]) => pair && !pair.some(elsewhere(app))));
			return withoutSessions(split, selected, () => false);
		});
	}
	reportVisible();
	await refreshModels();
	const { app, selected } = getState();
	const path = selected[app];
	if (path && getState().sessions.some((session) => session.path === path)) await openSession(path);
	loadSplit(app);
}

// Lets development scripts (TRIVIUM_EVAL) drive the UI the same way the components do.
Object.assign(window, { triviumDebug: { getState, setState, openSession, openInSplit, closePane, startSession, switchApp, openSettings, openPreview } });
