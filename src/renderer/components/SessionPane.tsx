import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LimitNotice, Run, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { AppIcon, BranchIcon, CheckIcon, CopyIcon, ExternalIcon, FileIcon, ImageIcon, PanelRightIcon, PenIcon, PlusIcon } from "../icons.tsx";
import { attempt, editMessage, forkFrom, setState, trivium, useStore } from "../store.ts";
import { THEMES } from "../theme.ts";
import { AskCard } from "./AskCard.tsx";
import { panelFor, panelKind, panelOpen } from "../panels.ts";
import { ChangeCount } from "./ChangesPanel.tsx";
import { Composer } from "./Composer.tsx";
import { ImageTile } from "./ImageTile.tsx";
import { Markdown } from "./Markdown.tsx";
import { Steps } from "./Steps.tsx";

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
	const ready = !sending && (text.trim().length > 0 || canSendEmpty) && text.trim() !== initial;
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

function MessageActions({ run, view, index, onEdit }: { run: Run; view: SessionView; index: number; onEdit: () => void }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	const text = run.prompt.trim();
	return (
		<div className="prompt-actions">
			{text && (
				<button
					type="button"
					className="prompt-action"
					aria-label={copied ? "Copied" : "Copy message"}
					title={copied ? "Copied" : "Copy"}
					onClick={() => void attempt(() => trivium.copyText(text).then(() => true)).then((ok) => ok && setCopied(true))}
				>
					{copied ? <CheckIcon size={14} width={1.75} /> : <CopyIcon size={14} width={1.75} />}
				</button>
			)}
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

function RunBlock({ run, live, view, index }: { run: Run; live: boolean; view: SessionView; index: number }) {
	return (
		<div className="run">
			{Boolean(run.prompt.trim() || run.attachments?.length) && <UserMessage run={run} view={view} index={index} />}
			<div className="agent">
				<Steps run={run} live={live} />
				{run.answer && (
					<div className="answer">
						<Markdown text={run.answer} />
					</div>
				)}
				{run.error && run.status !== "aborted" && (run.limit ? <LimitCard limit={run.limit} /> : <div className="run-error">{run.error}</div>)}
			</div>
		</div>
	);
}

/** Keeps the thread pinned to the bottom while new output arrives, unless the user scrolled up. */
function useStickToBottom(dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [dep]);
	const onScroll = () => {
		const element = ref.current;
		if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
	};
	return { ref, onScroll };
}

export function SessionPane({ view }: { view: SessionView }) {
	const allDialogs = useStore((s) => s.dialogs);
	const app = useStore((s) => s.app);
	const open = useStore((s) => panelOpen(s.app, view, s.changesHidden[view.path]));
	const dialogs = allDialogs.filter((d) => d.sessionPath === view.path);
	const lastRun = view.runs.at(-1);
	const scroll = useStickToBottom(`${view.path}:${view.runs.length}:${lastRun?.answer.length}:${lastRun?.steps.length}:${dialogs.length}`);
	return (
		<main className="pane">
			<header className="pane-head drag">
				<div className="crumb">
					<span className="project-name" title={view.cwd}>
						{baseName(view.cwd)}
					</span>
					<span className="project-name">/</span>
					<h1 className="ellipsis">{view.title}</h1>
				</div>
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
			<div className="scroller" ref={scroll.ref} onScroll={scroll.onScroll}>
				<div className="thread">
					{view.runs.map((run, index) => (
						<RunBlock key={run.id} run={run} view={view} index={index} live={view.running && index === view.runs.length - 1} />
					))}
					{dialogs.map((request) => (
						<AskCard key={request.id} request={request} />
					))}
				</div>
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
				<p>Pick a project folder to start. Sessions keep running when you switch apps.</p>
				<button type="button" className="btn primary" onClick={() => setState({ overlay: "new" })}>
					<PlusIcon size={14} /> New session
				</button>
			</div>
		</main>
	);
}
