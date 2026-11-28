import { useSyncExternalStore } from "react";
import type {
	AppId,
	AttachmentInfo,
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
	InfraInfo,
	LaunchPlan,
	LaunchState,
	TrustRequest,
	Notice,
	SessionStatus,
	SessionSummary,
	SessionView,
	TranscriptImage,
	ProxyStatus,
	UpdateStatus,
} from "../shared/protocol.ts";
import { type Locale, resolveLocale, setLocale, t } from "../shared/i18n.ts";
import type { PermissionModeId } from "../shared/permissions.ts";
import { type PanelView, panelViews, shownView } from "./panels.ts";
import type { DrawnDiagram } from "./preview.ts";
import type { SubagentTarget } from "./components/Subagents.tsx";
import { type Split, placeInSplit, showInSplit, visibleSessions, withoutSessions } from "./split.ts";
import { transition } from "./transition.ts";
import { baseName } from "./format.ts";

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
	/** The views open as tabs in each session's panel, oldest first; unset opens the one it has most to show in. */
	panelTabs: Record<string, PanelView[]>;
	/** The panel tab the user picked for each session; unset shows the last one. */
	panelTab: Record<string, PanelView>;
	/** Sessions showing the summary cards beside the conversation. */
	/** The subagent whose own session shows in a drawer beside each session's thread. */
	subagentShown: Record<string, SubagentTarget>;
	/** The files open in each session's Preview panel, oldest first, and the one showing. */
	previews: Record<string, { files: ReaderFile[]; active?: string }>;
	/** The document each Write session's panel last went to on its own, so returning to the session leaves what the user chose. */
	followed: Record<string, string>;
	/** The repository each Code session works in, by session path; null when it is in none. */
	git: Record<string, GitStatus | null>;
	/** What each session's commands left running, by session path, whether or not the session is loaded. */
	services: Record<string, ServiceInfo[]>;
	/** What the Launch button started: Compose projects and apps on their way up or that ended badly. */
	launch: LaunchState;
	/** A launch waiting for the user to confirm it. */
	launchPlan?: LaunchPlan;
	/** The task each session launched last, which the Launch button repeats. */
	lastLaunch: Record<string, string>;
	overlay: "new" | "search" | "archived" | null;
	/** The project the new-session surface starts with picked: a folder, null for no project, undefined for the usual one. */
	newIn?: string | null;
	page: "main" | "settings" | "memory";
	settingsSection: SettingsSection;
	settings?: TriviumSettings;
	/** The language the interface is in, from the settings; the whole app renders again when it changes. */
	locale: Locale;
	/** Text to put in a session's message box when it next shows. */
	drafts: Record<string, Draft>;
	/** Messages written while a session ran, by session path, oldest first. They go out one by one as its runs end. */
	queued: Record<string, QueuedMessage[]>;
	/** Sessions whose queue waits for the user, after a stop or a failed send; only ever ones with messages queued. */
	held: Record<string, boolean>;
	/** Projects asking to load their .pi resources, oldest first. */
	trust: TrustRequest[];
	/** The transcript image open in the lightbox, and the session it belongs to. */
	preview?: { path: string; image: TranscriptImage };
	/** The drawn diagram open in the lightbox, and the session whose Preview panel it can move to, if any. */
	diagram?: DrawnDiagram & { path?: string };
	/** A question waiting for Confirm or Cancel. */
	confirm?: ConfirmRequest;
	/** The provider login in progress, and what it last reported. */
	login?: { providerId: string; name: string; events: LoginEvent[] };
	/** Whether a newer Trivium is out, and how far installing it has got. */
	update: UpdateStatus;
	/** The API proxy, once Settings has asked about it. */
	proxy?: ProxyStatus;
}

export interface QueuedMessage extends Draft {
	id: number;
	/** The host has it and has not said what became of it. It keeps its place until then. */
	sending?: boolean;
}

export interface ConfirmRequest {
	title: string;
	message: string;
	confirmLabel: string;
	/** The action can be undone, so its button isn't the red one. */
	safe?: boolean;
	resolve: (ok: boolean) => void;
}

export type SettingsSection = "general" | "models" | "connectors" | "proxy" | "usage" | "shortcuts" | AppId | "about";

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
	subagentShown: {},
	previews: {},
	followed: {},
	git: {},
	services: {},
	launch: { infra: [], apps: [], shuttingDown: false },
	lastLaunch: {},
	drafts: {},
	queued: {},
	held: {},
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

export function notify(message: string, level: Notice["level"] = "error", copy?: string): void {
	const notice: Notice = { id: crypto.randomUUID(), message, level, copy };
	setState((s) => ({ notices: [...s.notices, notice] }));
	// A command to copy stays until it is dismissed.
	if (!copy) noticeTimers.set(notice.id, setTimeout(() => dismissNotice(notice.id), level === "error" ? 8000 : 4000));
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

/** Shows a subagent's own session in a drawer beside the thread, or in a window of its own. */
export function openSubagent(parent: string, target: SubagentTarget, newWindow: boolean): void {
	if (newWindow) {
		const title = [target.agent, target.label].filter(Boolean).join(" ");
		const view = getState().views[parent];
		const crumb = view ? `${view.chat ? t("Chats") : baseName(view.cwd)} / ${view.title}` : undefined;
		void attempt(() => trivium.openSubagentWindow({ parent, file: target.file, title, app: getState().app, crumb }));
		return;
	}
	setState((s) => ({ subagentShown: { ...s.subagentShown, [parent]: target } }));
}

export function closeSubagent(parent: string): void {
	setState((s) => {
		const { [parent]: _closed, ...rest } = s.subagentShown;
		return { subagentShown: rest };
	});
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
			putView(event.view);
			break;
		case "run":
			patchView(event.path, event.rev, `run ${event.index}`, (view) => {
				const runs = view.runs.slice();
				runs[event.index] = event.run;
				return { ...view, runs };
			});
			break;
		case "status":
			showStatus(event);
			break;
		case "changes":
			patchView(event.path, event.rev, "changes", (view) => ({ ...view, changes: event.changes }));
			break;
		case "returned":
			returnMessage(event.path, event.draft);
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
			notify(event.notice.message, event.notice.level, event.notice.copy);
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
		case "launch":
			setState({ launch: event.state });
			break;
		case "proxy":
			setState({ proxy: event.status });
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
			for (const path of gone) recent.delete(path);
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

interface Patch {
	rev: number;
	apply: (view: SessionView) => SessionView;
}

/** How many views are being read from the host, or read and waiting for the transition that shows them. */
let arriving = 0;
/** What events said about sessions while views were arriving, the newest of each kind, for a view read before it. */
const recent = new Map<string, Map<string, Patch>>();
/** The newest status of each session, by its place in the host's count. A view's own place is the one it was read at. */
const statusRevs = new Map<string, number>();

/** Reads views from the host. Call the `arrived` it hands over once they are shown. */
async function arrive<T>(read: () => Promise<T>): Promise<{ result: T | undefined; arrived: () => void }> {
	arriving++;
	const result = await attempt(read);
	return {
		result,
		arrived: () => {
			if (!--arriving) recent.clear();
		},
	};
}

/** Changes a session's view as an event says, unless the view was read later than that; or a view still arriving. */
function patchView(path: string, rev: number, kind: string, apply: Patch["apply"]): void {
	if (arriving) {
		const patches = recent.get(path) ?? new Map<string, Patch>();
		patches.set(kind, { rev, apply });
		recent.set(path, patches);
	}
	setState((s) => {
		const view = s.views[path];
		return view && rev > view.rev ? { views: { ...s.views, [path]: apply(view) } } : {};
	});
}

/** Shows a session's status, unless a newer one came first, and sends its next queued message if it is free. */
function showStatus(status: SessionStatus): void {
	const { path, rev, running, compacting, context, queue, title } = status;
	if (rev <= Math.max(statusRevs.get(path) ?? 0, getState().views[path]?.rev ?? 0)) return;
	statusRevs.set(path, rev);
	setState((s) => ({ sessions: s.sessions.map((session) => (session.path === path ? { ...session, running, title } : session)) }));
	patchView(path, rev, "status", (view) => ({ ...view, running, compacting, context, queue, title }));
	void sendNextQueued(path);
}

/**
 * The views with one read from the host put in, unless the one here was read later. Reading it and showing it take a
 * while, and what events said meanwhile goes on top.
 */
function withView(s: State, view: SessionView): State["views"] {
	const known = s.views[view.path];
	if (known && known.rev >= view.rev) return s.views;
	let next = view;
	if (known && (statusRevs.get(view.path) ?? 0) > view.rev) {
		const { running, compacting, context, queue, title } = known;
		next = { ...next, running, compacting, context, queue, title };
	}
	for (const patch of recent.get(view.path)?.values() ?? []) if (patch.rev > view.rev) next = patch.apply(next);
	return { ...s.views, [view.path]: next };
}

/** A session that turns out to be free, such as one opened again, goes on with its queue. */
function putView(view: SessionView): void {
	setState((s) => ({ views: withView(s, view) }));
	void sendNextQueued(view.path);
}

/** Stops a service; it leaves the list once its processes are gone. */
export async function stopService(id: string): Promise<void> {
	await attempt(() => trivium.stopService(id));
}

/** Reads a task and asks the user to confirm what it will run. Nothing runs until they do. */
export async function prepareLaunch(path: string, label: string): Promise<void> {
	const plan = await attempt(() => trivium.prepareLaunch(path, label));
	if (plan) setState({ launchPlan: plan });
}

/** Runs the confirmed launch; it carries on in the background while its progress shows in Services. */
export async function confirmLaunch(): Promise<void> {
	const plan = getState().launchPlan;
	if (!plan) return;
	setState((s) => ({ launchPlan: undefined, lastLaunch: { ...s.lastLaunch, [plan.sessionPath]: plan.label } }));
	const started = await attempt(() => trivium.startLaunch(plan.id).then(() => true));
	if (started) showPanelView(plan.sessionPath, "services");
}

export function cancelLaunch(): void {
	const plan = getState().launchPlan;
	setState({ launchPlan: undefined });
	if (plan) void trivium.cancelLaunch(plan.id).catch(() => {});
}

/** Stops a Compose project, asking first when other sessions use it too. */
export async function stopInfra(info: InfraInfo, sessionPath: string): Promise<void> {
	const others = info.holders.filter((holder) => holder !== sessionPath);
	if (others.length) {
		const titles = others.map((holder) => getState().sessions.find((session) => session.path === holder)?.title ?? t("another session"));
		const ok = await askConfirm({
			title: t(others.length === 1 ? "Stop {name} for 2 sessions?" : "Stop {name} for {n} sessions?", { name: info.label, n: others.length + 1 }),
			message: t("{sessions} use it too, and their apps lose it. Saved data is kept.", { sessions: titles.join(", ") }),
			confirmLabel: t(others.length === 1 ? "Stop for both" : "Stop for all"),
		});
		if (!ok) return;
	}
	await attempt(() => trivium.stopInfra(info.project));
}

export async function checkInfra(project: string): Promise<void> {
	await attempt(() => trivium.checkInfra(project));
}

export async function dismissLaunch(path: string, label: string): Promise<void> {
	await attempt(() => trivium.dismissLaunch(path, label));
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

let diagramTabs = 0;

/** A short fingerprint of a diagram's source, so the same diagram opened again goes to its tab. */
function fingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	return (hash >>> 0).toString(36);
}

/** Opens a drawn diagram in a tab of its own in a session's Preview panel, with its source as the source view. */
export function openDiagramPreview(path: string, diagram: DrawnDiagram): void {
	// Its first line, such as "sequenceDiagram", tells one diagram's tab from another's.
	const first = diagram.code.split("\n").find((line) => line.trim() && !line.trim().startsWith("%%"));
	showPreview(path, {
		id: `diagram:${++diagramTabs}`,
		path: `diagram:${fingerprint(diagram.code)}`,
		rel: first ? `${diagram.name} · ${first.trim()}` : diagram.name,
		name: diagram.name,
		kind: "diagram",
		size: diagram.src.length,
		mtime: Date.now(),
		url: diagram.src,
		text: diagram.code,
		scripts: false,
	});
}

/** Whether main has the file open: local pages and drawn diagrams live only here. */
function inMain(id: string): boolean {
	return !id.startsWith("web:") && !id.startsWith("diagram:");
}

function showPreview(path: string, opened: ReaderFile, pick = true): void {
	const files = getState().previews[path]?.files ?? [];
	// The same file opened again takes the old one's place, so it is never open twice.
	const same = files.find((file) => file.path === opened.path);
	let next = same ? files.map((file) => (file === same ? opened : file)) : [...files, opened];
	const closing = same ? [same] : [];
	while (next.length > MAX_PREVIEWS) {
		closing.push(next[0]!);
		next = next.slice(1);
	}
	for (const file of closing) if (inMain(file.id)) void trivium.closeReader(file.id).catch(() => {});
	transition("tab", () => {
		setState((s) => ({ previews: { ...s.previews, [path]: { files: next, active: opened.id } } }));
		if (pick) showPanelView(path, "preview");
		else {
			setState((s) => {
				const { [path]: _, ...panelTab } = s.panelTab;
				return { panelTab, changesHidden: { ...s.changesHidden, [path]: s.changesHidden[path] ?? false } };
			});
		}
	});
}

/**
 * Shows a document in a session's panel, leaving the tab to the panel's default and a panel the user closed
 * closed. A file that cannot be shown, such as one outside the project, is passed over.
 */
export async function showDocument(path: string, file: string): Promise<void> {
	const opened = await trivium.openReader(path, file).catch(() => undefined);
	if (opened) showPreview(path, opened, false);
}

/** Goes to the document a session is working on, once for each time it moves to another. */
export function followDocument(path: string, file: string): void {
	if (getState().followed[path] === file) return;
	setState((s) => ({ followed: { ...s.followed, [path]: file } }));
	void showDocument(path, file);
}

function openViews(s: State, path: string): PanelView[] {
	const view = s.views[path];
	return view ? panelViews(view, s.panelTabs[path]) : (s.panelTabs[path] ?? []);
}

/** Opens a view as a tab in a session's panel, or goes to its tab when it is open already, and shows the panel in place of a subagent's drawer. */
export function showPanelView(path: string, name: PanelView): void {
	setState((s) => {
		const open = openViews(s, path);
		const { [path]: _drawer, ...subagentShown } = s.subagentShown;
		return {
			subagentShown,
			panelTabs: { ...s.panelTabs, [path]: open.includes(name) ? open : [...open, name] },
			panelTab: { ...s.panelTab, [path]: name },
			changesHidden: { ...s.changesHidden, [path]: false },
		};
	});
}

/** Closes a view's tab; the one beside it shows next. Closing the last tab hides the panel. */
export function closePanelView(path: string, name: PanelView): void {
	setState((s) => {
		const open = openViews(s, path);
		const index = open.indexOf(name);
		const next = open.filter((other) => other !== name);
		if (!next.length) {
			const { [path]: _, ...rest } = s.panelTabs;
			return { panelTabs: rest, changesHidden: { ...s.changesHidden, [path]: true } };
		}
		const showing = shownView(open, s.panelTab[path]);
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
	if (inMain(id)) void trivium.closeReader(id).catch(() => {});
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
	if (!inMain(id)) return;
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
	const { result: view, arrived } = await arrive(() => trivium.openSession(path));
	if (!view) return arrived();
	if (ticket !== navigation) {
		putView(view);
		return arrived();
	}
	const before = getState();
	// Shown at once, so the screen does not stay as it was when the switch began. One whose place is on screen already
	// waits for the transition, which would otherwise have nothing to show.
	const placed = before.page === "main" && before.app === view.app && visibleSessions(before.split[view.app], before.selected[view.app]).includes(path);
	if (!placed) {
		putView(view);
		arrived();
	}
	const show = () => {
		setState((s) => ({
			views: placed ? withView(s, view) : s.views,
			selected: { ...s.selected, [view.app]: path },
			split: withSplit(s.split, view.app, showInSplit(s.split[view.app], s.selected[view.app], path)),
			app: view.app,
			peek: false,
			overlay: null,
			sessions: s.sessions.map((session) => (session.path === path ? { ...session, unread: false } : session)),
		}));
		if (placed) arrived();
		void sendNextQueued(path);
		// Unloaded again before it could show.
		if (!getState().views[path]) void loadSession(path, ticket);
	};
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
	const { result: view, arrived } = await arrive(() => trivium.openSession(path));
	if (view) putView(view);
	arrived();
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
	if (!before.views[path]) await loadBeside(path);
	if (!getState().views[path] || ticket !== navigation) return;
	transition("session", () => {
		setState((s) => ({
			selected: { ...s.selected, [app]: path },
			split: withSplit(s.split, app, pair),
			peek: false,
			overlay: null,
			sessions: s.sessions.map((session) => (session.path === path ? { ...session, unread: false } : session)),
		}));
		if (!getState().views[path]) void loadSession(path, ticket);
	});
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
	const latest = sessions.find((session) => session.app === app && session.path !== focused && !session.archived);
	if (latest) void openInSplit(latest.path);
}

export async function refreshModels(): Promise<void> {
	// Extensions can register providers when a session starts, so the list can grow.
	const models = await attempt(() => trivium.listModels());
	if (models) setState({ models });
}

/** Starts a session and shows it. `draft` goes into its message box, unsent. */
/** Shows where a new session starts, with `cwd` picked when given. Nothing is made until the user starts it there. */
export function openNewSession(cwd?: string | null): void {
	setState({ overlay: "new", newIn: cwd, peek: false });
}

export async function startSession(input: NewSessionInput, draft?: string): Promise<SessionView | undefined> {
	const ticket = ++navigation;
	const { result: view, arrived } = await arrive(() => trivium.newSession(input));
	if (!view) {
		arrived();
		return undefined;
	}
	const keep = (s: State): Partial<State> => ({
		drafts: draft ? { ...s.drafts, [view.path]: { text: draft, attachments: [] } } : s.drafts,
		views: withView(s, view),
	});
	// Here from the start, so what its first message sets off before the switch is not missed.
	setState(keep);
	arrived();
	if (ticket === navigation)
		transition(getState().app === input.app ? "session" : "app", () =>
			setState((s) => ({
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
/** How many messages each session was sent that the host has not said the outcome of. Its queue waits for them. */
const sending = new Map<string, number>();
/** Sessions whose messages on their way have no box to come back to. */
const deletedWhileSending = new Set<string>();

/** A hold is on the messages that were queued, so it goes with the last of them. */
function setQueue(path: string, update: (list: QueuedMessage[]) => QueuedMessage[]): void {
	setState((s) => {
		const { [path]: list = [], ...rest } = s.queued;
		const next = update(list);
		if (next.length) return { queued: { ...rest, [path]: next } };
		const { [path]: _, ...held } = s.held;
		return { queued: rest, held };
	});
}

function busy(path: string): boolean {
	const { views, sessions } = getState();
	const view = views[path];
	return view ? view.running || view.compacting : (sessions.find((session) => session.path === path)?.running ?? false);
}

/**
 * Keeps a message for when the session's run ends, which may be just over. Its attachments stay stored until it is
 * sent or deleted. Queueing another message counts as sending again, so it ends a hold.
 */
export function queueMessage(path: string, draft: Draft): void {
	setQueue(path, (list) => [...list, { ...draft, id: ++queuedIds }]);
	resumeQueue(path);
	void sendNextQueued(path);
}

/** Takes a message out of the queue, such as to edit it; its attachments stay stored. Not one on its way out. */
export function unqueueMessage(path: string, id: number): QueuedMessage | undefined {
	const message = getState().queued[path]?.find((item) => item.id === id && !item.sending);
	if (message) setQueue(path, (list) => list.filter((item) => item.id !== id));
	return message;
}

export function deleteQueued(path: string, id: number): void {
	const message = unqueueMessage(path, id);
	if (message?.attachments.length) void trivium.dropAttachments(message.attachments.map((item) => item.id));
}

/** Keeps what is queued now from going out when the current run ends, as when the user stops the run. */
export function holdQueue(path: string): void {
	if (getState().queued[path]?.length) setState((s) => ({ held: { ...s.held, [path]: true } }));
}

/** Lets the queue go out again once the session is free. */
export function resumeQueue(path: string): void {
	if (!getState().held[path]) return;
	setState((s) => {
		const { [path]: _, ...held } = s.held;
		return { held };
	});
}

/**
 * Keeps a session's queue from going out until a message on its way has an outcome. The status that comes with it
 * shows before that, so that what the outcome means for the queue is settled first.
 */
async function whileSending<T extends { status: SessionStatus }>(path: string, send: () => Promise<T | undefined>): Promise<T | undefined> {
	sending.set(path, (sending.get(path) ?? 0) + 1);
	try {
		const result = await attempt(send);
		if (result) showStatus(result.status);
		return result;
	} finally {
		const left = sending.get(path)! - 1;
		if (left) sending.set(path, left);
		else sending.delete(path);
	}
}

/**
 * Hands a message to the host. Until that has said what became of it, a steer too, the queue waits: the message may
 * turn out to start a run. Resolves with "failed", and a notice, or with "stopped" when it is in no run.
 */
async function deliver(path: string, text: string, mode: "prompt" | "steer", attachments: AttachmentInfo[]): Promise<"sent" | "stopped" | "failed"> {
	const ids = attachments.map((item) => item.id);
	const result = await whileSending(path, () => trivium.send(path, text, mode, ids));
	return !result ? "failed" : result.outcome === "stopped" ? "stopped" : "sent";
}

/**
 * Sends what was in the message box, which ends a hold on the queue. Resolves false when it did not go out, and puts it
 * back in that session's box, which by then may hold something else or not be on screen.
 */
export async function sendMessage(path: string, text: string, mode: "prompt" | "steer", attachments: AttachmentInfo[]): Promise<boolean> {
	const held = getState().held[path];
	// Before rather than after, so a stop meanwhile holds it again.
	resumeQueue(path);
	const outcome = await deliver(path, text, mode, attachments);
	if (outcome !== "sent") {
		// Stop has held it, and the user may have let it go again since.
		if (held && outcome === "failed") holdQueue(path);
		returnMessage(path, { text, attachments });
	}
	void sendNextQueued(path);
	return outcome === "sent";
}

/** Sends a queued message now: into the running turn as a steer, or as the next prompt when nothing runs. */
export async function sendQueuedNow(path: string, id: number): Promise<void> {
	const message = getState().queued[path]?.find((item) => item.id === id);
	if (!message || message.sending) return;
	resumeQueue(path);
	const view = getState().views[path];
	// Compacting with no run to steer, it goes first once that is done.
	if (view?.compacting && !view.running) setQueue(path, (list) => [message, ...list.filter((item) => item.id !== id)]);
	else await sendQueued(path, message, busy(path) ? "steer" : "prompt");
}

/** Sends the first queued message when the session is open and free. Called whenever that may have become so. */
async function sendNextQueued(path: string): Promise<void> {
	const { views, held, queued } = getState();
	const next = queued[path]?.[0];
	if (!next || next.sending || !views[path] || held[path] || sending.has(path) || busy(path)) return;
	await sendQueued(path, next, "prompt");
}

/**
 * A message keeps its place in the queue until it has gone out. When it fails to, the queue waits for the user, or for
 * the end of the run that got in first; when it was stopped, Stop has held the queue. One that started no run lets the
 * next one go.
 */
async function sendQueued(path: string, message: QueuedMessage, mode: "prompt" | "steer"): Promise<void> {
	const mark = (sending: boolean) => setQueue(path, (list) => list.map((item) => (item.id === message.id ? { ...message, sending } : item)));
	mark(true);
	const outcome = await deliver(path, message.text, mode, message.attachments);
	if (outcome === "sent") setQueue(path, (list) => list.filter((item) => item.id !== message.id));
	else {
		mark(false);
		if (outcome === "failed" && !busy(path)) holdQueue(path);
	}
	void sendNextQueued(path);
}

/** A message's text and another's, the earlier first. */
export function joinText(first: string, second: string, between: string): string {
	return first.trim() && second.trim() ? `${first.trimEnd()}${between}${second}` : first.trim() ? first : second;
}

/** What a message box holds once a draft has been put in it. */
export function placeDraft(box: Draft, draft: Draft): Draft {
	if (draft.place === "after") return { text: joinText(box.text, draft.text, "\n"), attachments: [...box.attachments, ...draft.attachments] };
	if (draft.place === "before") return { text: joinText(draft.text, box.text, "\n\n"), attachments: [...draft.attachments, ...box.attachments] };
	return { text: draft.text, attachments: draft.attachments };
}

/** Keeps what a message box held when it went off screen, with any draft that came for it just then. */
export function keepUnsent(path: string, box: Draft): void {
	setState((s) => {
		const draft = s.drafts[path];
		return { drafts: { ...s.drafts, [path]: draft ? placeDraft(box, draft) : box } };
	});
}

/** Puts a message that did not go out back in its session's box, in front of what the user has written since. */
function returnMessage(path: string, { text, attachments }: Draft): void {
	if (deletedWhileSending.has(path)) {
		if (attachments.length) void trivium.dropAttachments(attachments.map((item) => item.id));
		return;
	}
	const waiting = getState().drafts[path];
	const message: Draft = { text, attachments, place: "before" };
	// What waits for the box to show is put in with the message, as it would be put in the box itself.
	const draft: Draft = waiting ? { ...placeDraft({ ...waiting, place: undefined }, message), place: waiting.place && "before" } : message;
	setState((s) => ({ drafts: { ...s.drafts, [path]: draft } }));
}

/** Sends a new version of an earlier message, which ends a hold on the queue. Resolves false when it could not be sent. */
export async function editMessage(path: string, run: number, text: string): Promise<boolean> {
	const held = getState().held[path];
	// Before rather than after, so a stop meanwhile holds it again.
	resumeQueue(path);
	const result = await whileSending(path, () => trivium.editMessage(path, run, text));
	if (result?.outcome === "returned") {
		// The conversation went back before the send failed, and the message being edited went with it.
		returnMessage(path, result.draft);
		if (result.error) notify(result.error);
		if (held && result.error) holdQueue(path);
	} else if (!result && held) holdQueue(path);
	void sendNextQueued(path);
	return result !== undefined && result.outcome !== "returned";
}

/** Copies a session up to one of its runs into a new session and shows it, with that run's message to edit. */
export async function forkFrom(path: string, run: number): Promise<void> {
	const ticket = ++navigation;
	const { result, arrived } = await arrive(() => trivium.fork(path, run));
	if (!result) return arrived();
	const { view, draft } = result;
	setState((s) => ({ drafts: { ...s.drafts, [view.path]: draft }, views: withView(s, view) }));
	arrived();
	if (ticket === navigation)
		transition("session", () =>
			setState((s) => ({
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
	// Where a session starts belongs to the app it was opened in.
	transition(page === "main" ? "app" : "page", () =>
		setState((s) => ({ app, peek: false, page: "main", overlay: s.overlay === "new" ? null : s.overlay, newIn: undefined })),
	);
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
	for (const path of gone) {
		if (sending.has(path)) deletedWhileSending.add(path);
		statusRevs.delete(path);
		recent.delete(path);
	}
	const left = deleted.flatMap((path) => [
		...(getState().drafts[path]?.attachments ?? []),
		...(getState().queued[path] ?? []).flatMap((message) => message.attachments),
	]);
	if (left.length) void trivium.dropAttachments(left.map((item) => item.id));
	setState((s) => ({
		drafts: Object.fromEntries(Object.entries(s.drafts).filter(([path]) => !gone.has(path))),
		queued: Object.fromEntries(Object.entries(s.queued).filter(([path]) => !gone.has(path))),
		held: Object.fromEntries(Object.entries(s.held).filter(([path]) => !gone.has(path))),
		sessions: s.sessions.filter((session) => !gone.has(session.path)),
		views: Object.fromEntries(Object.entries(s.views).filter(([path]) => !gone.has(path))),
		...withoutSessions(s.split, s.selected, (path) => gone.has(path)),
		dialogs: s.dialogs.filter((dialog) => !gone.has(dialog.sessionPath)),
		changesHidden: Object.fromEntries(Object.entries(s.changesHidden).filter(([path]) => !gone.has(path))),
		panelTabs: Object.fromEntries(Object.entries(s.panelTabs).filter(([path]) => !gone.has(path))),
		followed: Object.fromEntries(Object.entries(s.followed).filter(([path]) => !gone.has(path))),
		subagentShown: Object.fromEntries(Object.entries(s.subagentShown).filter(([path]) => !gone.has(path))),
		pinnedSessions: Object.fromEntries(Object.entries(s.pinnedSessions).filter(([path]) => !gone.has(path))),
	}));
	notify(deleted.length === 1 ? t("Session moved to the Trash") : t("{n} sessions moved to the Trash", { n: deleted.length }), "info");
}

/** Moves sessions to the Archived panel, off the screen, or back to the sidebar. Their drafts and pins wait for them. */
export async function archiveSessions(paths: string[], archived: boolean): Promise<void> {
	const moved = await attempt(() => trivium.archiveSessions(paths, archived));
	if (!moved?.length) return;
	const changed = new Set(moved);
	setState((s) => ({
		sessions: s.sessions.map((session) => (changed.has(session.path) ? { ...session, archived } : session)),
		...(archived ? withoutSessions(s.split, s.selected, (path) => changed.has(path)) : {}),
	}));
	if (archived) notify(moved.length === 1 ? t("Session archived") : t("{n} sessions archived", { n: moved.length }), "info");
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
	const launch = await attempt(() => trivium.launchState());
	if (launch) setState({ launch });
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
