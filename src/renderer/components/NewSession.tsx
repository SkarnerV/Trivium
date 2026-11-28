import { useEffect, useMemo, useRef, useState } from "react";
import type { AppId, SessionSummary } from "../../shared/protocol.ts";
import { baseName, relativeTime, shortPath } from "../format.ts";
import { BranchIcon, ChatIcon, CloseIcon, FolderIcon, PlusIcon } from "../icons.tsx";
import { attempt, getState, setState, startSession, trivium, useStore } from "../store.ts";
import { commandKey, keyCombo } from "../platform.ts";
import { t, tx } from "../i18n.tsx";

/** How many projects the list shows, each with a ⌘1–⌘6 shortcut. */
const MAX_PROJECTS = 6;

/** A branch name from the first words of the message, else one from the time. */
export function suggestBranch(message: string, now = new Date()): string {
	const words = message
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 5)
		.join("-")
		.slice(0, 40)
		.replace(/-+$/, "");
	if (words) return `trivium/${words}`;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `trivium/session-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** What the user has done in a project in this app: how many sessions, and when last. */
function projectMeta(sessions: SessionSummary[], app: AppId, cwd: string): string | undefined {
	const own = sessions.filter((s) => s.app === app && s.cwd === cwd && !s.chat && !s.archived);
	if (!own.length) return undefined;
	const last = Math.max(...own.map((s) => s.modified));
	const count = own.length === 1 ? t("1 session") : t("{n} sessions", { n: own.length });
	return `${count} · ${relativeTime(last)}`;
}

/**
 * Where a session starts: the first message, the project it works in and, for Code in a git repository, whether
 * it works in a worktree of its own. Nothing is made until the user starts it.
 */
export function NewSessionPane({ closable }: { closable: boolean }) {
	const app = useStore((s) => s.app);
	const sessions = useStore((s) => s.sessions);
	const [projects, setProjects] = useState<string[]>([]);
	// A project folder, or null for a chat without one; undefined until the list has loaded.
	const [cwd, setCwd] = useState<string | null | undefined>();
	const [text, setText] = useState("");
	// Each project's checked-out branch: "" when detached, null outside a repository.
	const [branches, setBranches] = useState<Record<string, string | null>>({});
	const [worktree, setWorktree] = useState(false);
	const [branch, setBranch] = useState<string>();
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLTextAreaElement>(null);

	const readBranch = (path: string) => {
		if (app !== "code") return;
		void attempt(() => trivium.projectBranch(path)).then((value) => setBranches((map) => ({ ...map, [path]: value ?? null })));
	};

	useEffect(() => {
		input.current?.focus();
		const wanted = getState().newIn;
		void attempt(() => trivium.recentProjects()).then((list) => {
			// Projects this app has used first, then the rest; the one asked for always shows.
			const own = [...new Set(getState().sessions.filter((s) => s.app === app && !s.chat).map((s) => s.cwd))];
			let merged = [...new Set([...own, ...(list ?? [])])].filter(Boolean).slice(0, MAX_PROJECTS);
			if (wanted && !merged.includes(wanted)) merged = [wanted, ...merged].slice(0, MAX_PROJECTS);
			setProjects(merged);
			setCwd(wanted !== undefined ? wanted : (merged[0] ?? null));
			merged.forEach(readBranch);
		});
	}, [app]);

	const pickFolder = async () => {
		const folder = await attempt(() => trivium.pickFolder());
		if (!folder) return;
		setProjects((list) => [folder, ...list.filter((p) => p !== folder)].slice(0, MAX_PROJECTS));
		setCwd(folder);
		readBranch(folder);
	};

	const head = cwd ? branches[cwd] : null;
	const repo = app === "code" && typeof head === "string";
	const useWorktree = repo && worktree;
	const suggested = useMemo(() => suggestBranch(text), [text]);
	const branchName = branch ?? suggested;

	const close = () => setState({ overlay: null, newIn: undefined });

	const start = async () => {
		if (cwd === undefined || busy || (useWorktree && !branchName.trim())) return;
		setBusy(true);
		await startSession({
			app,
			cwd: cwd ?? undefined,
			message: text.trim() || undefined,
			worktree: useWorktree ? { branch: branchName.trim() } : undefined,
		});
		setBusy(false);
	};

	const mod = (key: string) => keyCombo(["⌘", key]);
	const row = (selected: boolean) => `ns-row${selected ? " selected" : ""}`;
	return (
		<main
			className="pane new-session"
			onKeyDown={(event) => {
				if (event.key === "Escape" && closable) close();
				else if (event.key === "Enter" && commandKey(event)) void start();
				else if (commandKey(event) && !event.altKey && /^[1-6]$/.test(event.key) && projects[Number(event.key) - 1]) setCwd(projects[Number(event.key) - 1]);
				else return;
				event.preventDefault();
				// Keeps ⌘1–⌘3 from also switching apps.
				event.stopPropagation();
			}}
		>
			<header className="pane-head drag">
				<div className="crumb">
					<h1 className="ellipsis">{t("New session")}</h1>
				</div>
				{closable && (
					<button type="button" className="icon-btn pane-close" aria-label={t("Close")} title={t("Close")} onClick={close}>
						<CloseIcon size={14} />
					</button>
				)}
			</header>
			<div className="ns-scroll">
				<div className="ns-body">
					<div className="ns-intro">
						<h2>{t("What should we work on?")}</h2>
						<p>{t("Describe a task, or leave it blank to start an empty session.")}</p>
					</div>

					<div className="ns-box">
						<textarea
							ref={input}
							rows={4}
							value={text}
							aria-label={t("First message")}
							placeholder={t({ code: "Describe a task, or ask about the code…", research: "What do you want to find out?", write: "What are we writing?" }[app])}
							onChange={(event) => setText(event.target.value)}
						/>
						<div className="ns-box-foot">
							<span className="ns-chip" title={cwd ?? undefined}>
								{cwd ? <FolderIcon size={14} /> : <ChatIcon size={14} />}
								<span className="ellipsis">{cwd ? baseName(cwd) : t("No project")}</span>
							</span>
							<span className="ns-spacer" />
							<span className="ns-hint">{mod("↵")}</span>
							<button type="button" className="btn primary" disabled={cwd === undefined || busy} onClick={() => void start()}>
								{t(busy ? "Starting…" : text.trim() ? "Start and send" : "Start session")}
							</button>
						</div>
						{repo && (
							<div className="ns-git">
								<div className="ns-git-row">
									<BranchIcon size={14} />
									<span className="ns-git-label">
										{head ? tx("Git repository on {branch}", { branch: <code>{head}</code> }) : t("Git repository, HEAD detached")}
									</span>
									<button type="button" role="switch" aria-checked={worktree} className="ns-switch" onClick={() => setWorktree(!worktree)}>
										{t("Create a worktree")}
										<span className="track" aria-hidden="true">
											<span className="knob" />
										</span>
									</button>
								</div>
								{worktree && (
									<>
										<div className="ns-git-row ns-indent">
											<label htmlFor="ns-branch">{t("New branch")}</label>
											<input
												id="ns-branch"
												className="mono"
												value={branchName}
												spellCheck={false}
												onChange={(event) => setBranch(event.target.value)}
											/>
											<span className="ns-from">{tx("from {branch}", { branch: <code>{head || "HEAD"}</code> })}</span>
										</div>
										<p className="ns-indent ns-note">{t("The session works in its own checkout beside the project, so your folder and current branch stay as they are.")}</p>
									</>
								)}
							</div>
						)}
					</div>

					<div role="radiogroup" aria-label={t("Project")} className="ns-list">
						<div className="ns-list-head">
							<span className="group-label">{t("Project")}</span>
							{projects.length > 0 && <span className="ns-hint">{t("{keys} to pick", { keys: `${mod("1")}–${projects.length}` })}</span>}
						</div>
						{projects.map((path, index) => {
							const selected = path === cwd;
							const meta = projectMeta(sessions, app, path);
							const tag = branches[path];
							return (
								<button key={path} type="button" role="radio" aria-checked={selected} className={row(selected)} onClick={() => setCwd(path)}>
									<span className="ns-icon">
										<FolderIcon size={14} />
									</span>
									<span className="ns-text">
										<span className="ns-name ellipsis">{baseName(path)}</span>
										<span className="ns-path mono ellipsis">{shortPath(path)}</span>
									</span>
									{tag && (
										<span className="ns-branch mono">
											<BranchIcon size={11} />
											{tag}
										</span>
									)}
									{meta && <span className="ns-meta">{meta}</span>}
									<kbd className="ns-key" title={mod(String(index + 1))}>
										{index + 1}
									</kbd>
								</button>
							);
						})}
						<button type="button" role="radio" aria-checked={cwd === null} className={row(cwd === null)} onClick={() => setCwd(null)}>
							<span className="ns-icon">
								<ChatIcon size={14} />
							</span>
							<span className="ns-text">
								<span className="ns-name">{t("No project")}</span>
								<span className="ns-sub ellipsis">{t("Just chat. Any files go in Trivium's own folder.")}</span>
							</span>
						</button>
						<button type="button" className="ns-row ns-open" onClick={() => void pickFolder()}>
							<span className="ns-icon dashed">
								<PlusIcon size={14} />
							</span>
							{t("Open another folder…")}
						</button>
					</div>
				</div>
			</div>
		</main>
	);
}
