import { type MouseEvent, useCallback, useEffect, useState } from "react";
import type { AppId, SessionSummary, UpdateStatus } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { baseName, duration, relativeTime } from "../format.ts";
import { AppIcon, ChatIcon, CopyIcon, DownloadIcon, FolderIcon, FolderOpenIcon, GearIcon, MemoryIcon, PanelIcon, PinIcon, PinOffIcon, PlusIcon, SearchIcon, TrashIcon } from "../icons.tsx";
import { useNow } from "../hooks.ts";
import { IS_MAC, IS_WINDOWS } from "../platform.ts";
import {
	askConfirm,
	attempt,
	deleteSessions,
	getState,
	installUpdate,
	notify,
	openMemory,
	openSession,
	openSettings,
	setState,
	startSession,
	switchApp,
	togglePin,
	trivium,
	useStore,
} from "../store.ts";
import { THEMES } from "../theme.ts";
import { ContextMenu, type MenuEntry } from "./ContextMenu.tsx";
import { Resizer } from "./Resizer.tsx";
import { serviceCount } from "./ServicesPanel.tsx";


interface ProjectGroup {
	cwd: string;
	name: string;
	/** Conversations started without a project. */
	chat: boolean;
	pinned: boolean;
	sessions: SessionSummary[];
}

const PER_PROJECT = 8;

const pinnedFirst = <T,>(items: T[], pinned: (item: T) => boolean): T[] => [...items.filter(pinned), ...items.filter((item) => !pinned(item))];

/** Pinned projects come first, and pinned sessions first within each project; otherwise the order is kept. */
function groupByProject(
	sessions: SessionSummary[],
	app: AppId,
	pinnedProjects: Record<string, boolean>,
	pinnedSessions: Record<string, boolean>,
): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	for (const session of sessions) {
		if (session.app !== app) continue;
		let group = groups.get(session.cwd);
		if (!group) {
			group = {
				cwd: session.cwd,
				name: session.chat ? "Chats" : baseName(session.cwd) || "No project",
				chat: session.chat,
				pinned: !!pinnedProjects[`${app}:${session.cwd}`],
				sessions: [],
			};
			groups.set(session.cwd, group);
		}
		group.sessions.push(session);
	}
	return pinnedFirst([...groups.values()], (group) => group.pinned).map((group) => ({
		...group,
		sessions: pinnedFirst(group.sessions, (session) => !!pinnedSessions[session.path]),
	}));
}

/** Where a right-click menu opens: at the pointer, or under the element when the keyboard's menu key opened it. */
function menuPoint(event: MouseEvent<HTMLElement>): { x: number; y: number } {
	event.preventDefault();
	const rect = event.currentTarget.getBoundingClientRect();
	const fromKeyboard = event.clientX === 0 && event.clientY === 0;
	return fromKeyboard ? { x: rect.left + 12, y: rect.bottom } : { x: event.clientX, y: event.clientY };
}

function confirmDelete(sessions: SessionSummary[], what: string, title?: string): void {
	const running = sessions.filter((session) => session.running);
	if (running.length) {
		notify(`Stop "${running[0]!.title}" before deleting it.`, "warning");
		return;
	}
	// Deleting drops the undo point for changes nobody kept or reverted yet.
	const views = getState().views;
	const pending = sessions.reduce((sum, session) => sum + (views[session.path]?.changes.length ?? 0), 0);
	const changesNote = pending
		? ` ${pending === 1 ? "1 changed file stays as it is" : `${pending} changed files stay as they are`}, but can no longer be reverted from Trivium.`
		: "";
	const services = sessions.reduce((sum, session) => sum + (getState().services[session.path]?.length ?? 0), 0);
	const servicesNote = services ? ` ${serviceCount(services)} left running ${services === 1 ? "stops" : "stop"} too.` : "";
	void askConfirm({
		title: title ?? (sessions.length === 1 ? "Delete this session?" : `Delete ${sessions.length} sessions?`),
		message: `${what} moves to the Trash, so you can still restore it from there. Files in the project folder are not touched.${changesNote}${servicesNote}`,
		confirmLabel: sessions.length === 1 ? "Delete session" : `Delete ${sessions.length} sessions`,
	}).then((ok) => {
		if (ok) void deleteSessions(sessions.map((session) => session.path));
	});
}

async function exportSession(session: SessionSummary): Promise<void> {
	const saved = await attempt(() => trivium.exportSession(session.path));
	if (saved) notify(`Exported to ${saved}`, "info");
}

async function copySessionId(session: SessionSummary): Promise<void> {
	const copied = await attempt(async () => {
		await trivium.copyText(session.id);
		return true;
	});
	if (copied) notify("Session ID copied", "info");
}

function sessionMenu(session: SessionSummary, pinned: boolean): MenuEntry[] {
	return [
		{
			label: pinned ? "Unpin session" : "Pin session",
			icon: pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />,
			onSelect: () => togglePin("pinnedSessions", session.path),
		},
		"separator",
		{ label: "Export messages…", icon: <DownloadIcon size={14} />, onSelect: () => void exportSession(session) },
		{ label: "Copy session ID", icon: <CopyIcon size={14} />, hint: session.id.slice(0, 8), onSelect: () => void copySessionId(session) },
		"separator",
		{
			label: "Delete session",
			icon: <TrashIcon size={14} />,
			danger: true,
			disabled: session.running,
			title: session.running ? "Stop the session before deleting it" : undefined,
			onSelect: () => confirmDelete([session], `"${session.title}"`),
		},
	];
}

function SessionRow({ session, active, pinned, startedAt }: { session: SessionSummary; active: boolean; pinned: boolean; startedAt?: number }) {
	const now = useNow(session.running ? 1000 : 60_000);
	const services = useStore((s) => s.services[session.path]?.length ?? 0);
	const [menu, setMenu] = useState<{ x: number; y: number }>();
	const closeMenu = useCallback(() => setMenu(undefined), []);
	return (
		<div className={`session-item${session.running ? " running" : ""}${menu ? " menu-open" : ""}`}>
			<button
				type="button"
				className="session-row"
				aria-current={active ? "page" : undefined}
				aria-haspopup="menu"
				onClick={() => void openSession(session.path)}
				onContextMenu={(event) => setMenu(menuPoint(event))}
				title={session.title}
			>
				<span className="title ellipsis">{session.title}</span>
				{pinned && (
					<span className="pin-mark" aria-label="Pinned">
						<PinIcon size={11} />
					</span>
				)}
				{services > 0 && <span className="service-dot" role="img" aria-label={serviceCount(services)} title={`${serviceCount(services)} running`} />}
				{session.running ? (
					<span className="running-meta">
						<span className="live-dot" />
						{startedAt ? duration(now - startedAt) : ""}
					</span>
				) : (
					<>
						{session.unread && <span className="unread-dot" aria-label="Unread" />}
						<span className="session-meta">{relativeTime(session.modified, now)}</span>
					</>
				)}
			</button>
			{!session.running && (
				<button
					type="button"
					className="row-action"
					aria-label={`Delete ${session.title}`}
					title="Delete session"
					onClick={() => confirmDelete([session], `"${session.title}"`)}
				>
					<TrashIcon />
				</button>
			)}
			{menu && <ContextMenu x={menu.x} y={menu.y} label={session.title} entries={sessionMenu(session, pinned)} onClose={closeMenu} />}
		</div>
	);
}

function deleteProject(app: AppId, group: ProjectGroup): void {
	confirmDelete(
		group.sessions,
		group.sessions.length === 1
			? `The ${THEMES[app].name} session in ${group.name}`
			: `Every ${THEMES[app].name} session in ${group.name} (${group.sessions.length})`,
		`Delete ${group.name} from ${THEMES[app].name}?`,
	);
}

function projectMenu(app: AppId, group: ProjectGroup): MenuEntry[] {
	return [
		{
			label: group.pinned ? "Unpin project" : "Pin project",
			icon: group.pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />,
			onSelect: () => togglePin("pinnedProjects", `${app}:${group.cwd}`),
		},
		{ label: "New session", icon: <PlusIcon size={14} />, onSelect: () => void startSession({ app, cwd: group.cwd }) },
		"separator",
		{ label: "Delete all sessions", icon: <TrashIcon size={14} />, danger: true, onSelect: () => deleteProject(app, group) },
	];
}

function ProjectSection({ app, group, selected }: { app: AppId; group: ProjectGroup; selected?: string }) {
	const views = useStore((s) => s.views);
	const pinnedSessions = useStore((s) => s.pinnedSessions);
	const key = `${app}:${group.cwd}`;
	const folded = useStore((s) => !!s.collapsed[key]);
	const [menu, setMenu] = useState<{ x: number; y: number }>();
	const closeMenu = useCallback(() => setMenu(undefined), []);
	return (
		<section className="project" aria-label={group.name}>
			<div className={`project-head${menu ? " menu-open" : ""}`} title={group.cwd} onContextMenu={(event) => setMenu(menuPoint(event))}>
				<button
					type="button"
					className="project-toggle"
					aria-expanded={!folded}
					aria-haspopup="menu"
					onClick={() => setState((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } }))}
				>
					{group.chat ? <ChatIcon size={15} /> : folded ? <FolderIcon size={15} /> : <FolderOpenIcon size={15} />}
					<span className="ellipsis">{group.name}</span>
					{group.pinned && (
						<span className="pin-mark" aria-label="Pinned">
							<PinIcon size={11} />
						</span>
					)}
				</button>
				<span className="count">{group.sessions.length}</span>
				<button
					type="button"
					className="project-action"
					aria-label={`Delete all ${THEMES[app].name} sessions in ${group.name}`}
					title={`Delete all ${THEMES[app].name} sessions in ${group.name}`}
					onClick={() => deleteProject(app, group)}
				>
					<TrashIcon size={12} />
				</button>
				<button
					type="button"
					className="project-action"
					aria-label={`New session in ${group.name}`}
					title={`New session in ${group.name}`}
					onClick={() => void startSession({ app, cwd: group.cwd })}
				>
					<PlusIcon size={13} />
				</button>
			</div>
			{!folded &&
				group.sessions.slice(0, PER_PROJECT).map((session) => (
					<SessionRow
						key={session.path}
						session={session}
						active={session.path === selected}
						pinned={!!pinnedSessions[session.path]}
						startedAt={views[session.path]?.runs.at(-1)?.startedAt}
					/>
				))}
			{menu && <ContextMenu x={menu.x} y={menu.y} label={group.name} entries={projectMenu(app, group)} onClose={closeMenu} />}
		</section>
	);
}

export function SessionGroups() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	const selected = useStore((s) => s.selected[s.app]);
	const pinnedProjects = useStore((s) => s.pinnedProjects);
	const pinnedSessions = useStore((s) => s.pinnedSessions);
	const groups = groupByProject(sessions, app, pinnedProjects, pinnedSessions);
	if (!groups.length) {
		return <p className="sb-empty">No {THEMES[app].name} sessions yet.</p>;
	}
	return (
		<>
			{groups.map((group) => (
				<ProjectSection key={group.cwd} app={app} group={group} selected={selected} />
			))}
		</>
	);
}

export function AppSwitcher() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	return (
		<nav className="switcher" aria-label="Modes">
			{APP_IDS.map((id) => {
				const busy = id !== app && sessions.some((session) => session.app === id && session.running);
				return (
					<button
						key={id}
						type="button"
						aria-label={THEMES[id].name}
						aria-current={id === app ? "page" : undefined}
						title={THEMES[id].name}
						onClick={() => switchApp(id)}
					>
						<AppIcon app={id} />
						{busy && <span className="busy-dot" style={{ background: THEMES[id].accent }} />}
					</button>
				);
			})}
		</nav>
	);
}

function SidebarToggle({ rail = false }: { rail?: boolean }) {
	const folded = useStore((s) => s.folded);
	return (
		<button
			type="button"
			className={rail ? "rail-btn panel" : "icon-btn sidebar-toggle"}
			aria-label={folded ? "Expand sidebar" : "Fold sidebar"}
			aria-expanded={!folded}
			title={folded ? "Sessions · click to keep open" : "Fold sidebar"}
			onMouseEnter={() => {
				if (!folded) return;
				cancelPeekClose();
				setState({ peek: true });
			}}
			onMouseLeave={() => {
				if (folded) schedulePeekClose();
			}}
			onClick={() => {
				cancelPeekClose();
				setState((s) => ({ folded: !s.folded, peek: false }));
			}}
		>
			<PanelIcon size={rail ? 17 : 16} />
		</button>
	);
}

/** The current mode's name beside a tile carrying its icon, both in the mode's accent. */
function ModeTitle({ app }: { app: AppId }) {
	return (
		<span className="app-name">
			<span className="app-name-mark" aria-hidden="true">
				<AppIcon app={app} size={14} />
			</span>
			<span className="ellipsis">{THEMES[app].name}</span>
		</span>
	);
}

export function Sidebar() {
	const app = useStore((s) => s.app);
	return (
		<nav className="sidebar" aria-label="Modes and sessions">
			<Resizer target="sidebar" />
			{/* On macOS the app switcher shares the title bar row with the window buttons. */}
			{IS_MAC && (
				<div className="sb-titlebar drag">
					<AppSwitcher />
				</div>
			)}
			<div className="sb-head drag">
				<ModeTitle app={app} />
				{!IS_MAC && !IS_WINDOWS && <AppSwitcher />}
				<SidebarToggle />
			</div>
			<div className="sb-rows">
				<button type="button" className="sb-row" onClick={() => setState({ overlay: "search" })}>
					<SearchIcon />
					<span className="label">Search</span>
				</button>
				<button type="button" className="sb-row" onClick={() => setState({ overlay: "new" })}>
					<PlusIcon />
					<span className="label">New session</span>
				</button>
				<button type="button" className="sb-row" onClick={openMemory}>
					<MemoryIcon />
					<span className="label">Memory</span>
				</button>
			</div>
			<div className="sb-label" aria-hidden="true">Projects</div>
			<div className="sb-sessions">
				<SessionGroups />
			</div>
			<UpdateRow />
			<button type="button" className="sb-row" onClick={() => openSettings()}>
				<GearIcon />
				<span className="label">Settings</span>
			</button>
		</nav>
	);
}

/** What the sidebar says about a newer Trivium, or nothing while there is none. */
function updateLabel(update: UpdateStatus): { title: string; detail: string; progress?: number; busy: boolean } | undefined {
	switch (update.state) {
		case "available":
			return {
				title: `Update to ${update.release.version}`,
				detail: update.release.installable ? "Downloads and restarts Trivium" : "Opens the download page",
				busy: false,
			};
		case "downloading": {
			const progress = update.total ? update.received / update.total : 0;
			return { title: `Downloading ${update.release.version}`, detail: `${Math.floor(progress * 100)}%`, progress, busy: true };
		}
		case "installing":
			return { title: `Installing ${update.release.version}`, detail: "Trivium restarts when it's done", busy: true };
		case "ready":
			return { title: "Restart to update", detail: `${update.release.version} is ready`, busy: false };
		case "error":
			return update.release ? { title: "Update failed", detail: "Try again", busy: false } : undefined;
		default:
			return undefined;
	}
}

function UpdateRow() {
	const update = useStore((s) => s.update);
	const label = updateLabel(update);
	if (!label) return null;
	return (
		<button
			type="button"
			className={`sb-update${update.state === "error" ? " failed" : ""}`}
			disabled={label.busy}
			title={update.state === "error" ? update.message : undefined}
			onClick={() => void installUpdate()}
		>
			<DownloadIcon size={15} />
			<span className="sb-update-text">
				<span className="sb-update-title">{label.title}</span>
				<span className="sb-update-detail">{label.detail}</span>
			</span>
			{label.progress !== undefined && (
				<span className="sb-update-bar" aria-hidden="true">
					<span style={{ width: `${label.progress * 100}%` }} />
				</span>
			)}
		</button>
	);
}

function UpdateRailButton() {
	const update = useStore((s) => s.update);
	const label = updateLabel(update);
	if (!label) return null;
	const text = label.busy ? `${label.title}, ${label.detail}` : label.title;
	return (
		<button type="button" className="rail-btn rail-update" aria-label={text} title={text} disabled={label.busy} onClick={() => void installUpdate()}>
			<DownloadIcon size={17} />
		</button>
	);
}

/** Closes the peek panel shortly after the pointer leaves both the rail button and the panel. */
const peekTimer: { current?: ReturnType<typeof setTimeout> } = {};
export const cancelPeekClose = () => clearTimeout(peekTimer.current);
export const schedulePeekClose = () => {
	clearTimeout(peekTimer.current);
	peekTimer.current = setTimeout(() => setState({ peek: false }), 250);
};

export function Rail() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	return (
		<nav className="rail drag" aria-label={IS_WINDOWS ? "Tools" : "Apps and tools"} onMouseLeave={schedulePeekClose}>
			<SidebarToggle rail />
			<span className="rail-sep" aria-hidden="true" />
			{!IS_WINDOWS && (
				<>
					{APP_IDS.map((id) => {
						const busy = id !== app && sessions.some((session) => session.app === id && session.running);
						return (
							<button
								key={id}
								type="button"
								className="rail-btn app"
								aria-label={THEMES[id].name}
								aria-current={id === app ? "page" : undefined}
								title={THEMES[id].name}
								onClick={() => switchApp(id)}
							>
								<AppIcon app={id} size={16} />
								{busy && <span className="busy-dot" style={{ background: THEMES[id].accent, borderColor: "var(--chrome)" }} />}
							</button>
						);
					})}
					<span className="rail-sep" aria-hidden="true" />
				</>
			)}
			<button type="button" className="rail-btn" aria-label="Search" title="Search" onClick={() => setState({ overlay: "search" })}>
				<SearchIcon size={17} />
			</button>
			<button type="button" className="rail-btn" aria-label="New session" title="New session" onClick={() => setState({ overlay: "new" })}>
				<PlusIcon size={17} />
			</button>
			<button type="button" className="rail-btn" aria-label="Memory" title="Memory" onClick={openMemory}>
				<MemoryIcon size={17} />
			</button>
			<span style={{ flex: 1 }} />
			<UpdateRailButton />
			<button type="button" className="rail-btn" aria-label="Settings" title="Settings" onClick={() => openSettings()}>
				<GearIcon size={17} />
			</button>
		</nav>
	);
}

export function PeekPanel() {
	const app = useStore((s) => s.app);
	useEffect(() => () => cancelPeekClose(), []);
	return (
		<div className="peek" role="region" aria-label="Sessions" onMouseEnter={cancelPeekClose} onMouseLeave={schedulePeekClose}>
			<div className="peek-title">
				<ModeTitle app={app} />
			</div>
			<SessionGroups />
		</div>
	);
}
