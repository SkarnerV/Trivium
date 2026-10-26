import { useLayoutEffect, useRef } from "react";
import type { LimitNotice, Run, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { AppIcon, BranchIcon, ExternalIcon, FileIcon, ImageIcon, PanelRightIcon, PenIcon, PlusIcon } from "../icons.tsx";
import { askConfirm, forkFrom, rewindTo, setState, useStore } from "../store.ts";
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

/** Asks before taking the conversation back, since the later messages leave it and Trivium can't show them again. */
async function editMessage(view: SessionView, index: number): Promise<void> {
	const changed = view.changes.length
		? " Files the agent changed stay as they are; revert them in the Changes panel if you need to."
		: " Files on disk stay as they are.";
	const ok = await askConfirm({
		title: "Edit this message?",
		message: `The conversation goes back to just before it, and the message moves to the box to edit and send again. The replies after it leave the conversation.${changed}`,
		confirmLabel: "Edit message",
	});
	if (ok) await rewindTo(view.path, index);
}

function PromptActions({ view, index }: { view: SessionView; index: number }) {
	return (
		<div className="prompt-actions">
			<button
				type="button"
				className="prompt-action"
				aria-label="Edit message"
				title={view.running ? "Stop the run to edit an earlier message" : "Edit and send again from here"}
				disabled={view.running}
				onClick={() => void editMessage(view, index)}
			>
				<PenIcon size={13} width={2} />
			</button>
			<button
				type="button"
				className="prompt-action"
				aria-label="Fork from here"
				title="Fork: a new session from before this message, with it ready to edit"
				onClick={() => void forkFrom(view.path, index)}
			>
				<BranchIcon size={13} />
			</button>
		</div>
	);
}

function RunBlock({ run, live, view, index }: { run: Run; live: boolean; view: SessionView; index: number }) {
	const sent = Boolean(run.prompt.trim() || run.attachments?.length);
	return (
		<div className="run">
			{sent && (
				<div className="prompt">
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
					<div className="prompt-line">
						<PromptActions view={view} index={index} />
						{run.prompt.trim() && <div className="bubble">{run.prompt.trim()}</div>}
					</div>
				</div>
			)}
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
