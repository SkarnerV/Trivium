import { useEffect, useMemo, useRef, useState } from "react";
import type { AppProfileInfo, SessionSummary } from "../../shared/protocol.ts";
import { baseName, relativeTime, shortPath } from "../format.ts";
import { AppIcon, Chevron, CloseIcon, FolderIcon } from "../icons.tsx";
import { attempt, trivium, getState, openSession, setState, startSession, useStore } from "../store.ts";
import { THEMES } from "../theme.ts";

const close = () => setState({ overlay: null });

export function NewSessionDialog() {
	const app = useStore((s) => s.app);
	const models = useStore((s) => s.models);
	const [message, setMessage] = useState("");
	const [projects, setProjects] = useState<string[]>([]);
	const [cwd, setCwd] = useState<string | undefined>();
	const [profile, setProfile] = useState<AppProfileInfo | undefined>();
	const [openSetup, setOpenSetup] = useState(false);
	const [busy, setBusy] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		ref.current?.focus();
		void attempt(() => trivium.recentProjects()).then((list) => {
			// Prefer projects this app has used, then the rest.
			const own = [...new Set(getState().sessions.filter((s) => s.app === app).map((s) => s.cwd))];
			const merged = [...new Set([...own, ...(list ?? [])])].filter(Boolean).slice(0, 6);
			setProjects(merged);
			setCwd((current) => current ?? merged[0]);
		});
		void attempt(() => trivium.profiles()).then((list) => setProfile(list?.find((p) => p.id === app)));
	}, [app]);

	const pickFolder = async () => {
		const folder = await attempt(() => trivium.pickFolder());
		if (!folder) return;
		setProjects((list) => [folder, ...list.filter((p) => p !== folder)].slice(0, 6));
		setCwd(folder);
	};

	const start = async () => {
		if (!cwd || busy) return;
		setBusy(true);
		await startSession({ app, cwd, message });
		setBusy(false);
	};

	const name = THEMES[app].name;
	const extensions = profile?.extensions.map(baseName) ?? [];
	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && close()}
			onKeyDown={(event) => {
				if (event.key === "Escape") close();
				else if (event.key === "Enter" && event.metaKey) void start();
				else if (event.metaKey && /^[1-6]$/.test(event.key) && projects[Number(event.key) - 1]) setCwd(projects[Number(event.key) - 1]);
				else return;
				event.preventDefault();
			}}
		>
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
				<div className="modal-head">
					<span className="app-badge">
						<AppIcon app={app} />
					</span>
					<h2 id="new-session-title">New {name} session</h2>
					<button type="button" className="icon-btn" aria-label="Close" onClick={close}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<label style={{ display: "block" }}>
					<span className="sr-only">First message</span>
					<textarea
						ref={ref}
						className="first"
						rows={3}
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						placeholder={
							app === "code"
								? "What should it build or fix? (optional)"
								: app === "research"
									? "What should it find out? (optional)"
									: "What should it write or revise? (optional)"
						}
					/>
				</label>
				<div role="radiogroup" aria-label="Project" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<span className="group-label">Project</span>
					{projects.map((path, index) => (
						<button
							key={path}
							type="button"
							role="radio"
							className="radio"
							aria-checked={path === cwd}
							onClick={() => setCwd(path)}
						>
							<span className="ring" />
							<span style={{ fontWeight: path === cwd ? 500 : 400 }}>{baseName(path)}</span>
							<span className="path ellipsis">{shortPath(path)}</span>
							<span className="kbd">⌘{index + 1}</span>
						</button>
					))}
					<button type="button" className="radio" onClick={() => void pickFolder()} style={{ color: "var(--ink-2)" }}>
						<FolderIcon />
						Open another folder…
					</button>
				</div>
				<div className="setup">
					<button type="button" aria-expanded={openSetup} onClick={() => setOpenSetup(!openSetup)}>
						<Chevron open={openSetup} />
						<span style={{ flex: 1 }}>
							{models.length ? "Default model" : "No models configured"} · {extensions.length}{" "}
							{extensions.length === 1 ? "extension" : "extensions"} · {profile?.tools.length ?? 0} tools
						</span>
						<span className="kbd">{profile ? shortPath(profile.extensionDir) : ""}</span>
					</button>
					{openSetup && profile && (
						<div className="setup-grid">
							<span className="k">Tools</span>
							<span className="mono">{profile.tools.join(", ")}</span>
							<span className="k">Extensions</span>
							<span className="mono">{extensions.length ? extensions.join(", ") : "Only those in ~/.pi/agent"}</span>
						</div>
					)}
				</div>
				<div className="modal-foot">
					<button type="button" className="btn ghost" onClick={close}>
						Cancel <span className="kbd">esc</span>
					</button>
					<button type="button" className="btn primary" disabled={!cwd || busy} onClick={() => void start()}>
						{busy ? "Starting…" : "Start session"} <span className="kbd">⌘↵</span>
					</button>
				</div>
			</div>
		</div>
	);
}

function matches(session: SessionSummary, query: string): boolean {
	const q = query.toLowerCase();
	return session.title.toLowerCase().includes(q) || session.cwd.toLowerCase().includes(q);
}

export function SearchOverlay() {
	const sessions = useStore((s) => s.sessions);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const results = useMemo(
		() => (query.trim() ? sessions.filter((s) => matches(s, query.trim())) : sessions).slice(0, 12),
		[sessions, query],
	);
	const pick = (session: SessionSummary | undefined) => {
		if (session) void openSession(session.path);
	};
	return (
		<div className="scrim top" onMouseDown={(event) => event.target === event.currentTarget && close()}>
			<div className="modal" role="dialog" aria-modal="true" aria-label="Search sessions" style={{ gap: 14 }}>
				<input
					className="search-input"
					autoFocus
					placeholder="Search sessions in all apps"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") close();
						else if (event.key === "ArrowDown") setActive(Math.min(active + 1, results.length - 1));
						else if (event.key === "ArrowUp") setActive(Math.max(active - 1, 0));
						else if (event.key === "Enter") pick(results[active]);
						else return;
						event.preventDefault();
					}}
				/>
				<div className="search-results">
					{results.map((session, index) => (
						<button
							key={session.path}
							type="button"
							className={`session-row${index === active ? " active" : ""}`}
							onMouseEnter={() => setActive(index)}
							onClick={() => pick(session)}
						>
							<span style={{ color: THEMES[session.app].accent, display: "grid" }}>
								<AppIcon app={session.app} size={13} />
							</span>
							<span className="title ellipsis">{session.title}</span>
							<span className="session-meta">{baseName(session.cwd)}</span>
							<span className="session-meta">{relativeTime(session.modified)}</span>
						</button>
					))}
					{!results.length && <p className="sb-empty">No sessions match.</p>}
				</div>
			</div>
		</div>
	);
}

export function ConfirmDialog() {
	const request = useStore((s) => s.confirm);
	const confirmButton = useRef<HTMLButtonElement>(null);
	useEffect(() => confirmButton.current?.focus(), [request]);
	if (!request) return null;
	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && request.resolve(false)}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					request.resolve(false);
				}
			}}
		>
			<div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" style={{ width: 440, gap: 14 }}>
				<h2 id="confirm-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
					{request.title}
				</h2>
				<p id="confirm-message" className="set-sub" style={{ margin: 0 }}>
					{request.message}
				</p>
				<div className="modal-foot">
					<button type="button" className="btn ghost" onClick={() => request.resolve(false)}>
						Cancel <span className="kbd">esc</span>
					</button>
					<button ref={confirmButton} type="button" className="btn danger" onClick={() => request.resolve(true)}>
						{request.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
