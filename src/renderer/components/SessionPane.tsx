import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppId, GitStatus, LimitNotice, Run, SessionView } from "../../shared/protocol.ts";
import { baseName, duration } from "../format.ts";
import { AppIcon, BranchIcon, CheckIcon, Chevron, CopyIcon, ExternalIcon, FileIcon, ImageIcon, PanelRightIcon, PenIcon, PlusIcon, ServerIcon } from "../icons.tsx";
import { attempt, editMessage, forkFrom, openPreview, refreshGit, setState, trivium, useStore } from "../store.ts";
import { PreviewOpener } from "../preview.ts";
import { THEMES } from "../theme.ts";
import { AskCard } from "./AskCard.tsx";
import { BranchSummary, branchTitle } from "./BranchSummary.tsx";
import { panelFor, panelKind, panelOpen } from "../panels.ts";
import { ChangeCount } from "./ChangesPanel.tsx";
import { branchLabel, gitFileCount } from "./GitPanel.tsx";
import { Composer } from "./Composer.tsx";
import { serviceCount, useServices } from "./ServicesPanel.tsx";
import { ImageTile } from "./ImageTile.tsx";
import { Markdown } from "./Markdown.tsx";
import { Steps } from "./Steps.tsx";
import { SubagentNoticeLine } from "./Subagents.tsx";

/** "PDF", "TS file" or "Image": the extension says more than the word "file". */
function fileKind(name: string, kind: "image" | "file"): string {
	if (kind === "image") return "Image";
	const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
	return extension ? `${extension.toUpperCase()} file` : "File";
}

/** A usage limit or empty balance, said plainly, with the provider's own message a click away. */
function LimitCard({ limit }: { limit: LimitNotice }) {
	return (
		<div className="run-error limit">
			<p>{limit.message}</p>
			<div className="limit-foot">
				{limit.link && (
					<a href={limit.link.url} target="_blank" rel="noreferrer">
						{limit.link.label}
						<ExternalIcon size={12} />
					</a>
				)}
				<details>
					<summary>Provider's message</summary>
					<div className="limit-detail">{limit.detail}</div>
				</details>
			</div>
		</div>
	);
}

/**
 * Edits a sent message in place. Nothing changes until it is sent: then the conversation starts over from
 * this message, with the files and images it carried.
 */
function MessageEditor({ initial, canSendEmpty, onCancel, onSend }: {
	initial: string;
	/** The message has attachments, so it can go without text. */
	canSendEmpty: boolean;
	onCancel: () => void;
	onSend: (text: string) => Promise<boolean>;
}) {
	const [text, setText] = useState(initial);
	const [sending, setSending] = useState(false);
	const ref = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const area = ref.current;
		if (!area) return;
		area.style.height = "auto";
		area.style.height = `${Math.min(area.scrollHeight, 320)}px`;
	}, [text]);
	useEffect(() => {
		const area = ref.current;
		area?.focus();
		area?.setSelectionRange(area.value.length, area.value.length);
	}, []);
	// The same text can go again: a retry, say after picking another model.
	const ready = !sending && (text.trim().length > 0 || canSendEmpty);
	const send = async () => {
		if (!ready) return;
		setSending(true);
		if (!(await onSend(text.trim()))) setSending(false);
	};
	return (
		<div className="bubble-edit">
			<textarea
				ref={ref}
				rows={1}
				value={text}
				aria-label="Edit message"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						void send();
					} else if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
			/>
			<div className="bubble-edit-foot">
				<span className="bubble-edit-hint">Sending starts over from here. Files stay as they are.</span>
				<button type="button" className="btn ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="btn primary" disabled={!ready} onClick={() => void send()}>
					Send
				</button>
			</div>
		</div>
	);
}

/** Copies the text, and shows a tick for a moment once it is on the clipboard. */
function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			className="prompt-action"
			aria-label={copied ? "Copied" : label}
			title={copied ? "Copied" : "Copy"}
			onClick={() => void attempt(() => trivium.copyText(text).then(() => true)).then((ok) => ok && setCopied(true))}
		>
			{copied ? <CheckIcon size={14} width={1.75} /> : <CopyIcon size={14} width={1.75} />}
		</button>
	);
}

function MessageActions({ run, view, index, onEdit }: { run: Run; view: SessionView; index: number; onEdit: () => void }) {
	const text = run.prompt.trim();
	return (
		<div className="prompt-actions">
			{text && <CopyButton text={text} label="Copy message" />}
			<button
				type="button"
				className="prompt-action"
				aria-label="Edit message"
				title={view.running ? "Stop the run to edit an earlier message" : "Edit"}
				disabled={view.running}
				onClick={onEdit}
			>
				<PenIcon size={14} width={1.75} />
			</button>
			<button
				type="button"
				className="prompt-action"
				aria-label="Fork from here"
				title="Fork into a new session from here"
				onClick={() => void forkFrom(view.path, index)}
			>
				<BranchIcon size={14} width={1.75} />
			</button>
		</div>
	);
}

function UserMessage({ run, view, index }: { run: Run; view: SessionView; index: number }) {
	const [editing, setEditing] = useState(false);
	const text = run.prompt.trim();
	return (
		<div className={`prompt${editing ? " editing" : ""}`}>
			{run.attachments?.length ? (
				<div className="bubble-files">
					{run.attachments.map((file, i) =>
						file.id ? (
							<ImageTile key={i} image={{ id: file.id, name: file.name, mimeType: file.mimeType ?? "image/png", thumb: file.thumb }} />
						) : (
							<span key={i} className="bubble-file" title={file.name}>
								<span className="bubble-file-icon">{file.kind === "image" ? <ImageIcon size={15} /> : <FileIcon size={15} />}</span>
								<span className="bubble-file-text">
									<span className="ellipsis">{file.name}</span>
									<span className="bubble-file-kind">{fileKind(file.name, file.kind)}</span>
								</span>
							</span>
						),
					)}
				</div>
			) : null}
			{editing ? (
				<MessageEditor
					initial={text}
					canSendEmpty={Boolean(run.attachments?.length)}
					onCancel={() => setEditing(false)}
					onSend={async (next) => {
						const sent = await editMessage(view.path, index, next);
						if (sent) setEditing(false);
						return sent;
					}}
				/>
			) : (
				<>
					{text && <div className="bubble">{text}</div>}
					<MessageActions run={run} view={view} index={index} onEdit={() => setEditing(true)} />
				</>
			)}
		</div>
	);
}

/** When the answer came, how long the run took, and how fast the answering reply was written. */
function ReplyStats({ run }: { run: Run }) {
	const reply = run.reply;
	if (!reply) return null;
	const end = reply.durationMs === undefined ? run.endedAt : reply.at + reply.durationMs;
	const took = end !== undefined && run.startedAt !== undefined ? Math.max(end - run.startedAt, reply.durationMs ?? 0) : reply.durationMs;
	const writing = reply.durationMs === undefined ? 0 : reply.durationMs - (reply.firstTokenMs ?? 0);
	const speed = reply.output && writing > 0 ? (reply.output * 1000) / writing : undefined;
	const when = new Date(end ?? reply.at);
	const today = when.toDateString() === new Date().toDateString();
	const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const parts = [
		today ? clock : `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`,
		took !== undefined && `${duration(took)}`,
		reply.firstTokenMs !== undefined && `first token ${duration(reply.firstTokenMs)}`,
		speed !== undefined && `${speed < 10 ? speed.toFixed(1) : Math.round(speed)} tk/s`,
	].filter(Boolean);
	return (
		<span className="reply-stats" title={`Answered ${when.toLocaleString()}${took !== undefined ? `, ${duration(took)} after it was asked` : ""}`}>
			{parts.join(" · ")}
		</span>
	);
}

function RunBlock({ run, live, view, index }: { run: Run; live: boolean; view: SessionView; index: number }) {
	return (
		<div className="run">
			{Boolean(run.prompt.trim() || run.attachments?.length) && <UserMessage run={run} view={view} index={index} />}
			<div className="agent">
				{run.notice && <SubagentNoticeLine notice={run.notice} />}
				<Steps run={run} live={live} />
				{run.answer && (
					<div className="reply">
						<div className="answer">
							<Markdown text={run.answer} />
						</div>
						{/* Copied as the markdown it was written in; offered once the reply is finished. */}
						{!live && (
							<div className="reply-actions">
								<CopyButton text={run.answer.trim()} label="Copy response" />
								<ReplyStats run={run} />
							</div>
						)}
					</div>
				)}
				{run.error && run.status !== "aborted" && (run.limit ? <LimitCard limit={run.limit} /> : <div className="run-error">{run.error}</div>)}
			</div>
		</div>
	);
}

/**
 * Keeps the thread pinned to the bottom while new output arrives, unless the user scrolled up. Opening
 * another session pins it again.
 */
function useStickToBottom(path: string, dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [away, setAway] = useState(false);
	useLayoutEffect(() => {
		pinned.current = true;
		setAway(false);
	}, [path]);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [path, dep]);
	const onScroll = () => {
		const element = ref.current;
		if (!element) return;
		pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
		setAway(!pinned.current);
	};
	const toBottom = () => {
		const element = ref.current;
		if (!element) return;
		pinned.current = true;
		setAway(false);
		element.scrollTo({ top: element.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
	};
	return { ref, onScroll, away, toBottom };
}

/**
 * Keeps a Code session's git status current: read when the session shows and when the window regains focus,
 * after files may have changed outside Trivium. The main process sends it again after the agent's tool calls.
 */
function useGitStatus(view: SessionView, app: AppId) {
	const enabled = app === "code" && !view.chat;
	useEffect(() => {
		if (!enabled) return;
		void refreshGit(view.path);
		const onFocus = () => void refreshGit(view.path);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [view.path, enabled]);
	return useStore((s) => (enabled ? s.git[view.path] : undefined));
}

/**
 * The branch in the header: its name, how many files changed, and a dot when there are commits to push
 * (blue) or to pull (amber). It opens the branch summary, which says the rest in words.
 */
function BranchButton({ view, git }: { view: SessionView; git: GitStatus }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLButtonElement>(null);
	const count = gitFileCount(git);
	const dot = git.behind > 0 ? "pull" : git.ahead > 0 ? "push" : undefined;
	const close = useCallback(() => setOpen(false), []);
	return (
		<>
			<button
				ref={ref}
				type="button"
				className="changes-toggle branch-toggle"
				aria-haspopup="dialog"
				aria-expanded={open}
				title={branchTitle(git, count)}
				onClick={() => setOpen(!open)}
			>
				<BranchIcon size={14} />
				<span className="mono ellipsis">{branchLabel(git)}</span>
				{count > 0 && <span className="branch-count">{count}</span>}
				{dot && <span className={`branch-dot is-${dot}`} aria-hidden="true" />}
				<Chevron open={open} down size={11} />
			</button>
			{open && ref.current && <BranchSummary view={view} git={git} anchor={ref.current} onClose={close} />}
		</>
	);
}

/** Says the session has services running, and opens the panel on them. */
function ServicesButton({ view }: { view: SessionView }) {
	const services = useServices(view.path);
	const showing = useStore((s) => !s.changesHidden[view.path] && s.panelTab[view.path] === "services");
	if (!services.length) return null;
	const ports = services.flatMap((service) => service.ports.map((port) => `:${port}`));
	return (
		<button
			type="button"
			className="changes-toggle services-toggle"
			aria-pressed={showing}
			title={`${serviceCount(services.length)} running${ports.length ? ` on ${ports.join(", ")}` : ""}. Show them in the panel.`}
			onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: false }, panelTab: { ...s.panelTab, [view.path]: "services" } }))}
		>
			<span className="service-dot" aria-hidden="true" />
			<ServerIcon size={14} />
			<span>{serviceCount(services.length)}</span>
		</button>
	);
}

export function SessionPane({ view }: { view: SessionView }) {
	const allDialogs = useStore((s) => s.dialogs);
	const app = useStore((s) => s.app);
	const open = useStore((s) => panelOpen(s.app, view, s.changesHidden[view.path]));
	const git = useGitStatus(view, app);
	const dialogs = allDialogs.filter((d) => d.sessionPath === view.path);
	const lastRun = view.runs.at(-1);
	// Only the Code panel has a Preview view so far.
	const preview = useMemo(() => (app === "code" ? (file: string) => void openPreview(view.path, file) : undefined), [app, view.path]);
	const scroll = useStickToBottom(view.path, `${view.runs.length}:${lastRun?.answer.length}:${lastRun?.steps.length}:${dialogs.length}`);
	return (
		<main className="pane">
			<header className="pane-head drag">
				<div className="crumb">
					<span className="project-name" title={view.cwd}>
						{view.chat ? "Chats" : baseName(view.cwd)}
					</span>
					<span className="project-name">/</span>
					<h1 className="ellipsis">{view.title}</h1>
				</div>
				<ServicesButton view={view} />
				{git && <BranchButton view={view} git={git} />}
				<button
					type="button"
					className="changes-toggle"
					aria-pressed={open}
					title={open ? "Hide panel" : "Show panel"}
					onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: open } }))}
				>
					<PanelRightIcon size={15} />
					{panelFor(app, view) === "changes" ? (
						<>
							<span>{view.changes.length === 1 ? "1 file" : `${view.changes.length} files`}</span>
							<ChangeCount changes={view.changes} />
						</>
					) : (
						<span>{{ changes: "Changes", note: "Note", review: "Review" }[panelKind(app)]}</span>
					)}
				</button>
			</header>
			<div className="thread-frame">
				<div className="scroller" ref={scroll.ref} onScroll={scroll.onScroll}>
					<div className="thread">
						<PreviewOpener.Provider value={preview}>
							{view.runs.map((run, index) => (
								<RunBlock key={run.id} run={run} view={view} index={index} live={view.running && index === view.runs.length - 1} />
							))}
						</PreviewOpener.Provider>
						{dialogs.map((request) => (
							<AskCard key={request.id} request={request} />
						))}
					</div>
				</div>
				{scroll.away && (
					<button type="button" className="to-latest" onClick={scroll.toBottom} aria-label="Scroll to latest" title="Scroll to latest">
						{/* While the agent works, the dots say there is more coming below. */}
						{view.running ? (
							<span className="to-latest-dots">
								<span />
								<span />
								<span />
							</span>
						) : (
							<Chevron open={false} down size={12} />
						)}
					</button>
				)}
			</div>
			<Composer key={view.path} view={view} />
		</main>
	);
}

export function EmptyPane() {
	const app = useStore((s) => s.app);
	const name = THEMES[app].name;
	return (
		<main className="pane">
			<header className="pane-head drag" />
			<div className="empty">
				<span className="app-badge" style={{ width: 44, height: 44, borderRadius: 12 }}>
					<AppIcon app={app} size={20} />
				</span>
				<h2>Start a {name} session</h2>
				<p>Start a chat, or pick a project folder to work in. Sessions keep running when you switch modes.</p>
				<button type="button" className="btn primary" onClick={() => setState({ overlay: "new" })}>
					<PlusIcon size={14} /> New session
				</button>
			</div>
		</main>
	);
}
