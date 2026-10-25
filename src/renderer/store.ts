import { useSyncExternalStore } from "react";
import type {
	AppId,
	TriviumApi,
	TriviumSettings,
	LoginEvent,
	DialogRequest,
	HostEvent,
	ModelOption,
	NewSessionInput,
	Notice,
	SessionSummary,
	SessionView,
} from "../shared/protocol.ts";

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
	/** Sessions whose Changes panel the user closed. */
	changesHidden: Record<string, boolean>;
	overlay: "new" | "search" | null;
	page: "main" | "settings";
	settingsSection: SettingsSection;
	settings?: TriviumSettings;
	/** Text to put in a session's message box when it next shows. */
	drafts: Record<string, string>;
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

function loadPrefs(): Pick<State, "app" | "folded" | "selected" | "collapsed"> {
	try {
		const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<State>;
		return {
			app: parsed.app ?? "code",
			folded: parsed.folded ?? false,
			selected: parsed.selected ?? {},
			collapsed: parsed.collapsed ?? {},
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
	if ("app" in next || "folded" in next || "selected" in next || "collapsed" in next) {
		try {
			localStorage.setItem(
				PREFS_KEY,
				JSON.stringify({ app: state.app, folded: state.folded, selected: state.selected, collapsed: state.collapsed }),
			);
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

export function notify(message: string, level: Notice["level"] = "error"): void {
	const notice: Notice = { id: crypto.randomUUID(), message, level };
	setState((s) => ({ notices: [...s.notices, notice] }));
	setTimeout(() => dismissNotice(notice.id), level === "error" ? 8000 : 4000);
}

export function dismissNotice(id: string): void {
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
			if (current && gone.has(current) && page === "main") void openSession(current);
			break;
		}
	}
}

export async function refreshSessions(): Promise<void> {
	const sessions = await attempt(() => trivium.listSessions());
	if (sessions) setState({ sessions });
}

export async function openSession(path: string): Promise<void> {
	const view = await attempt(() => trivium.openSession(path));
	if (!view) return;
	setState((s) => ({
		views: { ...s.views, [path]: view },
		selected: { ...s.selected, [view.app]: path },
		app: view.app,
		peek: false,
		overlay: null,
		sessions: s.sessions.map((session) => (session.path === path ? { ...session, unread: false } : session)),
	}));
	void refreshModels();
}

export async function refreshModels(): Promise<void> {
	// Extensions can register providers when a session starts, so the list can grow.
	const models = await attempt(() => trivium.listModels());
	if (models) setState({ models });
}

/** Starts a session and shows it. `draft` goes into its message box, unsent. */
export async function startSession(input: NewSessionInput, draft?: string): Promise<SessionView | undefined> {
	const view = await attempt(() => trivium.newSession(input));
	if (!view) return undefined;
	setState((s) => ({
		drafts: draft ? { ...s.drafts, [view.path]: draft } : s.drafts,
		views: { ...s.views, [view.path]: view },
		selected: { ...s.selected, [input.app]: view.path },
		app: input.app,
		overlay: null,
	}));
	void refreshSessions();
	void refreshModels();
	return view;
}

export function switchApp(app: AppId): void {
	setState({ app, peek: false, page: "main" });
	const path = getState().selected[app];
	if (path && !getState().views[path]) void openSession(path);
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
	setState((s) => ({ page: "settings", settingsSection: section ?? s.settingsSection, overlay: null, peek: false }));
}

export function closeSettings(): void {
	setState({ page: "main" });
	const { selected, app, views } = getState();
	const path = selected[app];
	if (path && !views[path]) void openSession(path);
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
