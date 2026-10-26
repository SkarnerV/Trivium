import { useLayoutEffect, useRef } from "react";
import type { Run, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { AppIcon, FileIcon, ImageIcon, PlusIcon } from "../icons.tsx";
import { setState, useStore } from "../store.ts";
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

function RunBlock({ run, live }: { run: Run; live: boolean }) {
	return (
		<div className="run">
			{run.attachments?.length ? (
				<div className="bubble-files">
					{run.attachments.map((file, index) =>
						file.id ? (
							<ImageTile key={index} image={{ id: file.id, name: file.name, mimeType: file.mimeType ?? "image/png", thumb: file.thumb }} />
						) : (
							<span key={index} className="bubble-file" title={file.name}>
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
			{run.prompt.trim() && <div className="bubble">{run.prompt.trim()}</div>}
			<div className="agent">
				<Steps run={run} live={live} />
				{run.answer && (
					<div className="answer">
						<Markdown text={run.answer} />
					</div>
				)}
				{run.error && run.status !== "aborted" && <div className="run-error">{run.error}</div>}
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
						<RunBlock key={run.id} run={run} live={view.running && index === view.runs.length - 1} />
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
