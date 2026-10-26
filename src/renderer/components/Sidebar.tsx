import { useCallback, useEffect, useState } from "react";
import type { AppId, SessionSummary } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { baseName, duration, relativeTime } from "../format.ts";
import { AppIcon, CopyIcon, DownloadIcon, FolderIcon, FolderOpenIcon, GearIcon, PanelIcon, PlusIcon, SearchIcon, TrashIcon } from "../icons.tsx";
import { useNow } from "../hooks.ts";
import {
	askConfirm,
	attempt,
	deleteSessions,
	getState,
	notify,
	openSession,
	openSettings,
	setState,
	startSession,
	switchApp,
	trivium,
	useStore,
} from "../store.ts";
import { THEMES } from "../theme.ts";
import { ContextMenu, type MenuEntry } from "./ContextMenu.tsx";
import { Resizer } from "./Resizer.tsx";

const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WINDOWS = navigator.userAgent.includes("Windows");

interface ProjectGroup {
	cwd: string;
	name: string;
	sessions: SessionSummary[];
}

const PER_PROJECT = 8;

function groupByProject(sessions: SessionSummary[], app: AppId): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	for (const session of sessions) {
		if (session.app !== app) continue;
		let group = groups.get(session.cwd);
		if (!group) {
			group = { cwd: session.cwd, name: baseName(session.cwd) || "No project", sessions: [] };
			groups.set(session.cwd, group);
		}
		group.sessions.push(session);
	}
	return [...groups.values()];
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
	void askConfirm({
		title: title ?? (sessions.length === 1 ? "Delete this session?" : `Delete ${sessions.length} sessions?`),
		message: `${what} moves to the Trash, so you can still restore it from there. Files in the project folder are not touched.${changesNote}`,
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

function sessionMenu(session: SessionSummary): MenuEntry[] {
	return [
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

function SessionRow({ session, active, startedAt }: { session: SessionSummary; active: boolean; startedAt?: number }) {
	const now = useNow(session.running ? 1000 : 60_000);
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
				onContextMenu={(event) => {
					event.preventDefault();
					// The keyboard's menu key reports no pointer position; open under the row instead.
					const rect = event.currentTarget.getBoundingClientRect();
					const fromKeyboard = event.clientX === 0 && event.clientY === 0;
					setMenu(fromKeyboard ? { x: rect.left + 12, y: rect.bottom } : { x: event.clientX, y: event.clientY });
				}}
				title={session.title}
			>
				<span className="title ellipsis">{session.title}</span>
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
			{menu && <ContextMenu x={menu.x} y={menu.y} label={session.title} entries={sessionMenu(session)} onClose={closeMenu} />}
		</div>
	);
}

export function SessionGroups() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	const selected = useStore((s) => s.selected[s.app]);
	const views = useStore((s) => s.views);
	const collapsed = useStore((s) => s.collapsed);
	const groups = groupByProject(sessions, app);
	if (!groups.length) {
		return <p className="sb-empty">No {THEMES[app].name} sessions yet.</p>;
	}
	return (
		<>
			{groups.map((group) => (
				<section key={group.cwd} className="project" aria-label={group.name}>
					<div className="project-head" title={group.cwd}>
						<button
							type="button"
							className="project-toggle"
							aria-expanded={!collapsed[`${app}:${group.cwd}`]}
							onClick={() =>
								setState((s) => ({
									collapsed: { ...s.collapsed, [`${app}:${group.cwd}`]: !s.collapsed[`${app}:${group.cwd}`] },
								}))
							}
						>
							{collapsed[`${app}:${group.cwd}`] ? <FolderIcon size={15} /> : <FolderOpenIcon size={15} />}
							<span className="ellipsis">{group.name}</span>
						</button>
						<span className="count">{group.sessions.length}</span>
						<button
							type="button"
							className="project-action"
							aria-label={`Delete all ${THEMES[app].name} sessions in ${group.name}`}
							title={`Delete all ${THEMES[app].name} sessions in ${group.name}`}
							onClick={() =>
								confirmDelete(
									group.sessions,
									group.sessions.length === 1
										? `The ${THEMES[app].name} session in ${group.name}`
										: `Every ${THEMES[app].name} session in ${group.name} (${group.sessions.length})`,
									`Delete ${group.name} from ${THEMES[app].name}?`,
								)
							}
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
					{!collapsed[`${app}:${group.cwd}`] && group.sessions.slice(0, PER_PROJECT).map((session) => (
						<SessionRow
							key={session.path}
							session={session}
							active={session.path === selected}
							startedAt={views[session.path]?.runs.at(-1)?.startedAt}
						/>
					))}
				</section>
			))}
		</>
	);
}

export function AppSwitcher() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	return (
		<nav className="switcher" aria-label="Apps">
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

export function Sidebar() {
	const app = useStore((s) => s.app);
	return (
		<nav className="sidebar" aria-label="Apps and sessions">
			<Resizer target="sidebar" />
			{/* On macOS the app switcher shares the title bar row with the window buttons. */}
			{IS_MAC && (
				<div className="sb-titlebar drag">
					<AppSwitcher />
				</div>
			)}
			<div className="sb-head drag">
				<span className="app-name ellipsis">{THEMES[app].name}</span>
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
			</div>
			<div className="sb-label" aria-hidden="true">Projects</div>
			<div className="sb-sessions">
				<SessionGroups />
			</div>
			<button type="button" className="sb-row" onClick={() => openSettings()}>
				<GearIcon />
				<span className="label">Settings</span>
			</button>
		</nav>
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
			<span style={{ flex: 1 }} />
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
			<div className="peek-title">{THEMES[app].name}</div>
			<SessionGroups />
		</div>
	);
}
