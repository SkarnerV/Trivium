import { useSyncExternalStore } from "react";
import type {
	AppId,
	Draft,
	TriviumApi,
	TriviumSettings,
	LoginEvent,
	DialogRequest,
	HostEvent,
	ModelOption,
	NewSessionInput,
	TrustRequest,
	Notice,
	SessionSummary,
	SessionView,
	TranscriptImage,
} from "../shared/protocol.ts";
import { transition } from "./transition.ts";

declare global {
	interface Window {
		trivium: TriviumApi;
	}
}

export const trivium = window.trivium;

export interface State {
	app: AppId;
	/** The session shown in each app, by session path. */
	selected: Partial<Record<AppId, string>>;
	sessions: SessionSummary[];
	views: Record<string, SessionView>;
	dialogs: DialogRequest[];
	notices: Notice[];
	models: ModelOption[];
	folded: boolean;
	peek: boolean;
	/** Project groups folded in the sidebar, keyed "app:cwd". */
	collapsed: Record<string, boolean>;
	/** Widths the user dragged the sidebar and the right panel to; unset means the default. */
	sidebarWidth?: number;
	panelWidth?: number;
	/** Sessions whose side panel the user closed (true) or opened (false); unset follows whether it has content. */
	changesHidden: Record<string, boolean>;
	overlay: "new" | "search" | null;
	page: "main" | "settings";
	settingsSection: SettingsSection;
	settings?: TriviumSettings;
	/** Text to put in a session's message box when it next shows. */
	drafts: Record<string, Draft>;
	/** Projects asking to load their .pi resources, oldest first. */
	trust: TrustRequest[];
	/** The transcript image open in the lightbox, and the session it belongs to. */
	preview?: { path: string; image: TranscriptImage };
	/** A question waiting for Confirm or Cancel. */
	confirm?: ConfirmRequest;
	/** The provider login in progress, and what it last reported. */
	login?: { providerId: string; name: string; events: LoginEvent[] };
}

export interface ConfirmRequest {
	title: string;
	message: string;
	confirmLabel: string;
	resolve: (ok: boolean) => void;
}

export type SettingsSection = "general" | "models" | "shortcuts" | AppId | "about";

const PREFS_KEY = "trivium.prefs";

const PREF_KEYS = ["app", "folded", "selected", "collapsed", "sidebarWidth", "panelWidth"] as const;

function loadPrefs(): Pick<State, (typeof PREF_KEYS)[number]> {
	try {
		const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<State>;
		return {
			app: parsed.app ?? "code",
			folded: parsed.folded ?? false,
			selected: parsed.selected ?? {},
			collapsed: parsed.collapsed ?? {},
			sidebarWidth: parsed.sidebarWidth,
			panelWidth: parsed.panelWidth,
		};
	} catch {
		return { app: "code", folded: false, selected: {}, collapsed: {} };
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
	drafts: {},
	trust: [],
	page: "main",
	settingsSection: "general",
	overlay: null,
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
	for (const listener of listeners) listener();
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

function errorText(error: unknown): string {
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
							context: event.context,
							queue: event.queue,
							title: event.title,
						},
					},
				};
			});
			break;
		case "changes":
			setState((s) => {
				const view = s.views[event.path];
				return view ? { views: { ...s.views, [event.path]: { ...view, changes: event.changes } } } : {};
			});
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
		case "focus_session":
			setState({ page: "main" });
			void openSession(event.path);
			break;
		case "unloaded": {
			const gone = new Set(event.paths);
			setState((s) => ({ views: Object.fromEntries(Object.entries(s.views).filter(([path]) => !gone.has(path))) }));
			// The session on screen reloads at once with the new setup.
			const { selected, app, page } = getState();
			const current = selected[app];
			if (current && gone.has(current) && page === "main") void loadSession(current, navigation);
			break;
		}
	}
}

export async function refreshSessions(): Promise<void> {
	const sessions = await attempt(() => trivium.listSessions());
	if (sessions) setState({ sessions });
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
			setState((s) => ({ ...keep(s), selected: { ...s.selected, [input.app]: view.path }, app: input.app, overlay: null })),
		);
	void refreshSessions();
	void refreshModels();
	return view;
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
			setState((s) => ({ ...keep(s), selected: { ...s.selected, [view.app]: view.path }, app: view.app, overlay: null })),
		);
	void refreshSessions();
}

export function switchApp(app: AppId): void {
	const { app: current, page } = getState();
	if (app === current && page === "main") return;
	const ticket = ++navigation;
	transition(page === "main" ? "app" : "page", () => setState({ app, peek: false, page: "main" }));
	const path = getState().selected[app];
	if (path && !getState().views[path]) void loadSession(path, ticket);
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
	setState((s) => ({
		sessions: s.sessions.filter((session) => !gone.has(session.path)),
		views: Object.fromEntries(Object.entries(s.views).filter(([path]) => !gone.has(path))),
		selected: Object.fromEntries(Object.entries(s.selected).filter(([, path]) => !gone.has(path ?? ""))),
		dialogs: s.dialogs.filter((dialog) => !gone.has(dialog.sessionPath)),
		changesHidden: Object.fromEntries(Object.entries(s.changesHidden).filter(([path]) => !gone.has(path))),
	}));
	notify(deleted.length === 1 ? "Session moved to the Trash" : `${deleted.length} sessions moved to the Trash`, "info");
}

export function openSettings(section?: SettingsSection): void {
	const update = () => setState((s) => ({ page: "settings", settingsSection: section ?? s.settingsSection, overlay: null, peek: false }));
	const { page, settingsSection } = getState();
	if (page !== "settings") transition("page", update);
	else if (section && section !== settingsSection) transition("section", update);
	else update();
}

export function closeSettings(): void {
	if (getState().page !== "main") transition("page", () => setState({ page: "main" }));
	const { selected, app, views } = getState();
	const path = selected[app];
	if (path && !views[path]) void loadSession(path, navigation);
}

export async function updateSettings(patch: Partial<TriviumSettings>): Promise<void> {
	const next = await attempt(() => trivium.updateSettings(patch));
	if (next) setState({ settings: next });
}

export async function init(): Promise<void> {
	trivium.onEvent(handleEvent);
	const settings = await attempt(() => trivium.getSettings());
	if (settings) setState({ settings });
	await refreshSessions();
	await refreshModels();
	const { app, selected, sessions } = getState();
	const path = selected[app];
	if (path && sessions.some((session) => session.path === path)) await openSession(path);
}

// Lets development scripts (TRIVIUM_EVAL) drive the UI the same way the components do.
Object.assign(window, { triviumDebug: { getState, setState, openSession, startSession, switchApp, openSettings } });
