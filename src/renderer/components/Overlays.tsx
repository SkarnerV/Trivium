import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary, TrustChoice } from "../../shared/protocol.ts";
import { baseName, relativeTime, shortPath } from "../format.ts";
import { AppIcon, ArchiveIcon, CloseIcon, FolderIcon, TrashIcon, UndoIcon } from "../icons.tsx";
import { archiveSessions, attempt, trivium, getState, openSession, setState, startSession, useStore } from "../store.ts";
import { THEMES } from "../theme.ts";
import { commandKey } from "../platform.ts";
import { t } from "../i18n.tsx";
import { AskCard, answer } from "./AskCard.tsx";
import { serviceCount } from "./ServicesPanel.tsx";
import { confirmDelete } from "./Sidebar.tsx";

const close = () => setState({ overlay: null });

export function NewSessionDialog() {
	const app = useStore((s) => s.app);
	const [projects, setProjects] = useState<string[]>([]);
	// A project folder, or null for a chat without one.
	const [cwd, setCwd] = useState<string | null | undefined>();
	const [busy, setBusy] = useState(false);
	// Focus the dialog itself so Esc and the ⌘ (Ctrl) shortcuts work right away.
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		ref.current?.focus();
		void attempt(() => trivium.recentProjects()).then((list) => {
			// Prefer projects this app has used, then the rest.
			const own = [...new Set(getState().sessions.filter((s) => s.app === app && !s.chat).map((s) => s.cwd))];
			const merged = [...new Set([...own, ...(list ?? [])])].filter(Boolean).slice(0, 6);
			setProjects(merged);
			setCwd((current) => (current !== undefined ? current : (merged[0] ?? null)));
		});
	}, [app]);

	const pickFolder = async () => {
		const folder = await attempt(() => trivium.pickFolder());
		if (!folder) return;
		setProjects((list) => [folder, ...list.filter((p) => p !== folder)].slice(0, 6));
		setCwd(folder);
	};

	const start = async () => {
		if (cwd === undefined || busy) return;
		setBusy(true);
		await startSession({ app, cwd: cwd ?? undefined });
		setBusy(false);
	};

	const name = THEMES[app].name;
	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && close()}
			onKeyDown={(event) => {
				if (event.key === "Escape") close();
				else if (event.key === "Enter" && commandKey(event)) void start();
				else if (commandKey(event) && /^[1-6]$/.test(event.key) && projects[Number(event.key) - 1]) setCwd(projects[Number(event.key) - 1]);
				else return;
				event.preventDefault();
			}}
		>
			<div ref={ref} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" style={{ outline: "none" }}>
				<div className="modal-head">
					<span className="app-badge">
						<AppIcon app={app} />
					</span>
					<h2 id="new-session-title">{t("New {mode} session", { mode: t(name) })}</h2>
					<button type="button" className="icon-btn" aria-label={t("Close")} onClick={close}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<div role="radiogroup" aria-label={t("Project")} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
					<span className="group-label">{t("Where")}</span>
					<button type="button" role="radio" className="radio" aria-checked={cwd === null} onClick={() => setCwd(null)}>
						<span className="ring" />
						<span style={{ fontWeight: cwd === null ? 500 : 400 }}>{t("No project")}</span>
						<span className="path ellipsis" style={{ fontFamily: "inherit" }}>
							{t("Just chat. Any files go in Trivium's own folder.")}
						</span>
					</button>
					{projects.map((path) => (
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
						</button>
					))}
					<button type="button" className="radio" onClick={() => void pickFolder()} style={{ color: "var(--ink-2)" }}>
						<FolderIcon />
						{t("Open another folder…")}
					</button>
				</div>
				<div className="modal-foot">
					<button type="button" className="btn ghost" onClick={close}>
						{t("Cancel")}
					</button>
					<button type="button" className="btn primary" disabled={cwd === undefined || busy} onClick={() => void start()}>
						{t(busy ? "Starting…" : "Start session")}
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
		() => sessions.filter((s) => !s.archived && (!query.trim() || matches(s, query.trim()))).slice(0, 12),
		[sessions, query],
	);
	const pick = (session: SessionSummary | undefined) => {
		if (session) void openSession(session.path);
	};
	return (
		<div className="scrim top" onMouseDown={(event) => event.target === event.currentTarget && close()}>
			<div className="modal" role="dialog" aria-modal="true" aria-label={t("Search sessions")} style={{ gap: 14 }}>
				<input
					className="search-input"
					autoFocus
					placeholder={t("Search sessions in all modes")}
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
					{!results.length && <p className="sb-empty">{t("No sessions match.")}</p>}
				</div>
			</div>
		</div>
	);
}

/** The current mode's archived sessions, and the one place to delete a session. */
export function ArchivedPanel() {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	const services = useStore((s) => s.services);
	const archived = sessions.filter((session) => session.app === app && session.archived);
	const mode = t(THEMES[app].name);
	// On the window, because focus leaves the panel with each row that goes. Esc in the delete dialog answers that first.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return (
		<div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="archived-title">
				<div className="modal-head">
					<span className="app-badge">
						<ArchiveIcon />
					</span>
					<h2 id="archived-title">{t("Archived {mode} sessions", { mode })}</h2>
					<button type="button" className="icon-btn" aria-label={t("Close")} onClick={close}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				{archived.length ? (
					<div className="archived-list">
						{archived.map((session) => (
							<div key={session.path} className="archived-row" title={session.title}>
								<span className="title ellipsis">{session.title}</span>
								{(services[session.path]?.length ?? 0) > 0 && (
									<span
										className="service-dot"
										role="img"
										aria-label={serviceCount(services[session.path]!.length)}
										title={t("{services} running", { services: serviceCount(services[session.path]!.length) })}
									/>
								)}
								<span className="session-meta">{session.chat ? t("Chats") : baseName(session.cwd)}</span>
								<span className="session-meta">{relativeTime(session.modified)}</span>
								<button
									type="button"
									className="icon-btn"
									aria-label={t("Restore {title}", { title: session.title })}
									title={t("Restore session")}
									onClick={() => void archiveSessions([session.path], false)}
								>
									<UndoIcon size={14} />
								</button>
								<button
									type="button"
									className="icon-btn archived-delete"
									aria-label={t("Delete {title}", { title: session.title })}
									title={t("Delete session")}
									onClick={() => confirmDelete([session], t("“{title}”", { title: session.title }))}
								>
									<TrashIcon size={14} />
								</button>
							</div>
						))}
					</div>
				) : (
					<p className="sb-empty">{t("No archived {mode} sessions.", { mode })}</p>
				)}
				{archived.length > 1 && (
					<div className="modal-foot">
						<button
							type="button"
							className="btn ghost archived-delete"
							onClick={() => confirmDelete(archived, t("Every archived {mode} session ({n})", { mode, n: archived.length }))}
						>
							{t("Delete all")}
						</button>
					</div>
				)}
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
						{t("Cancel")}
					</button>
					<button ref={confirmButton} type="button" className={`btn ${request.safe ? "primary" : "danger"}`} onClick={() => request.resolve(true)}>
						{request.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * A question from a session with nothing on screen to ask it in, such as an extension asking while its session
 * starts: the session opens only once it is answered.
 */
export function StartingSessionDialog() {
	const request = useStore((s) => s.dialogs.find((dialog) => !s.views[dialog.sessionPath]));
	const allowButton = useRef<HTMLButtonElement>(null);
	useEffect(() => allowButton.current?.focus(), [request?.id]);
	if (!request) return null;
	if (request.kind !== "confirm") {
		return (
			<div className="scrim">
				<div className="modal" role="dialog" aria-modal="true" style={{ width: 500, padding: 0 }}>
					<AskCard request={request} />
				</div>
			</div>
		);
	}
	return (
		<div
			className="scrim"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					answer(request.id, { confirmed: false });
				}
			}}
		>
			<div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="starting-title" aria-describedby="starting-message" style={{ width: 500, gap: 14 }}>
				<h2 id="starting-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
					{request.title}
				</h2>
				{request.message && (
					<p id="starting-message" className="set-sub" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
						{request.message}
					</p>
				)}
				<div className="modal-foot">
					<button type="button" className="btn ghost" onClick={() => answer(request.id, { confirmed: false })}>
						{t("Decline")}
					</button>
					<button ref={allowButton} type="button" className="btn primary" onClick={() => answer(request.id, { confirmed: true })}>
						{t("Allow")}
					</button>
				</div>
			</div>
		</div>
	);
}

/** pi's project trust question: whether to load the project's own .pi settings and code. */
export function TrustDialog() {
	const request = useStore((s) => s.trust[0]);
	const trustButton = useRef<HTMLButtonElement>(null);
	useEffect(() => trustButton.current?.focus(), [request?.id]);
	if (!request) return null;
	const answer = (choice: TrustChoice) => {
		setState((s) => ({ trust: s.trust.filter((item) => item.id !== request.id) }));
		void attempt(() => trivium.answerTrust(request.id, choice));
	};
	return (
		<div className="scrim" onKeyDown={(event) => event.key === "Escape" && answer("never")}>
			<div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="trust-title" style={{ width: 500, gap: 16 }}>
				<div className="modal-head">
					<span className="trust-icon">
						<FolderIcon size={16} />
					</span>
					<h2 id="trust-title">{t("Trust {project}?", { project: baseName(request.cwd) })}</h2>
				</div>
				<p className="set-sub" style={{ margin: 0 }}>
					{t(
						"This project has its own pi setup. Trusting it lets its settings apply and its extensions, MCP servers and packages run on your computer. Only trust projects you know.",
					)}
				</p>
				<div className="trust-box">
					<span className="mono trust-path" title={request.cwd}>
						{shortPath(request.cwd)}/.pi
					</span>
					{request.resources.length > 0 && (
						<div className="s-chips">
							{request.resources.map((resource) => (
								<span key={resource} className="s-chip mono">
									{resource}
								</span>
							))}
						</div>
					)}
				</div>
				<p className="trust-note">{t("Saved in pi's trust list, so the pi CLI remembers it too. “Just this time” asks again next launch.")}</p>
				<div className="modal-foot">
					<button type="button" className="btn ghost" onClick={() => answer("never")}>
						{t("Don't trust")}
					</button>
					<button type="button" className="btn" onClick={() => answer("once")}>
						{t("Just this time")}
					</button>
					<button ref={trustButton} type="button" className="btn primary" onClick={() => answer("trust")}>
						{t("Trust")}
					</button>
				</div>
			</div>
		</div>
	);
}
