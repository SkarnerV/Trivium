import { useEffect } from "react";
import type { AppId, SessionSummary } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { baseName, duration, relativeTime } from "../format.ts";
import { AppIcon, GearIcon, PanelIcon, PlusIcon, SearchIcon } from "../icons.tsx";
import { useNow } from "../hooks.ts";
import { openSession, openSettings, setState, switchApp, useStore } from "../store.ts";
import { THEMES } from "../theme.ts";

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

function SessionRow({ session, active, startedAt }: { session: SessionSummary; active: boolean; startedAt?: number }) {
	const now = useNow(session.running ? 1000 : 60_000);
	return (
		<button
			type="button"
			className="session-row"
			aria-current={active ? "page" : undefined}
			onClick={() => void openSession(session.path)}
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
	);
}

export function SessionGroups() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	const selected = useStore((s) => s.selected[s.app]);
	const views = useStore((s) => s.views);
	const groups = groupByProject(sessions, app);
	if (!groups.length) {
		return <p className="sb-empty">No {THEMES[app].name} sessions yet.</p>;
	}
	return (
		<>
			{groups.map((group) => (
				<section key={group.cwd} className="project" aria-label={group.name}>
					<div className="project-head" title={group.cwd}>
						<span className="ellipsis">{group.name}</span>
						<span className="count">{group.sessions.length}</span>
					</div>
					{group.sessions.slice(0, PER_PROJECT).map((session) => (
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

function Switcher() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	return (
		<nav className="switcher" aria-label="Apps">
			{APP_IDS.map((id, index) => {
				const busy = id !== app && sessions.some((session) => session.app === id && session.running);
				return (
					<button
						key={id}
						type="button"
						aria-label={THEMES[id].name}
						aria-current={id === app ? "page" : undefined}
						title={`${THEMES[id].name} ⌘${index + 1}`}
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


export function Sidebar() {
	const app = useStore((s) => s.app);
	return (
		<nav className="sidebar" aria-label="Apps and sessions">
			<div className="sb-head drag">
				<span className="logo" aria-hidden="true" title="Logo placeholder">
					π
				</span>
				<span className="app-name ellipsis">{THEMES[app].name}</span>
				<Switcher />
				<button
					type="button"
					className="icon-btn"
					aria-label="Fold sidebar"
					title="Fold sidebar ⌘\"
					onClick={() => setState({ folded: true, peek: false })}
				>
					<PanelIcon />
				</button>
			</div>
			<div className="sb-rows">
				<button type="button" className="sb-row" onClick={() => setState({ overlay: "search" })}>
					<SearchIcon />
					<span className="label">Search</span>
					<span className="kbd">⌘K</span>
				</button>
				<button type="button" className="sb-row" onClick={() => setState({ overlay: "new" })}>
					<PlusIcon />
					<span className="label">New session</span>
					<span className="kbd">⌘N</span>
				</button>
			</div>
			<div className="sb-sessions">
				<SessionGroups />
			</div>
			<button type="button" className="sb-row" onClick={() => openSettings()}>
				<GearIcon />
				<span className="label">Settings</span>
				<span className="kbd">⌘,</span>
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
		<nav className="rail" aria-label="Apps and tools" onMouseLeave={schedulePeekClose}>
			<button
				type="button"
				className="rail-btn panel"
				aria-label="Show sessions. Click to keep the sidebar open"
				title="Sessions · click to keep open ⌘\"
				onMouseEnter={() => {
					cancelPeekClose();
					setState({ peek: true });
				}}
				onClick={() => {
					cancelPeekClose();
					setState({ folded: false, peek: false });
				}}
			>
				<PanelIcon size={17} />
			</button>
			<span className="rail-sep" aria-hidden="true" />
			{APP_IDS.map((id, index) => {
				const busy = id !== app && sessions.some((session) => session.app === id && session.running);
				return (
					<button
						key={id}
						type="button"
						className="rail-btn app"
						aria-label={THEMES[id].name}
						aria-current={id === app ? "page" : undefined}
						title={`${THEMES[id].name} ⌘${index + 1}`}
						onClick={() => switchApp(id)}
					>
						<AppIcon app={id} size={16} />
						{busy && <span className="busy-dot" style={{ background: THEMES[id].accent, borderColor: "var(--chrome)" }} />}
					</button>
				);
			})}
			<span className="rail-sep" aria-hidden="true" />
			<button type="button" className="rail-btn" aria-label="Search" title="Search ⌘K" onClick={() => setState({ overlay: "search" })}>
				<SearchIcon size={17} />
			</button>
			<button type="button" className="rail-btn" aria-label="New session" title="New session ⌘N" onClick={() => setState({ overlay: "new" })}>
				<PlusIcon size={17} />
			</button>
			<span style={{ flex: 1 }} />
			<button type="button" className="rail-btn" aria-label="Settings" title="Settings ⌘," onClick={() => openSettings()}>
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
