import { useLayoutEffect, useRef } from "react";
import type { Run, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { AppIcon, PlusIcon } from "../icons.tsx";
import { setState, useStore } from "../store.ts";
import { THEMES } from "../theme.ts";
import { AskCard } from "./AskCard.tsx";
import { panelFor } from "../panels.ts";
import { ChangeCount } from "./ChangesPanel.tsx";
import { Composer } from "./Composer.tsx";
import { Markdown } from "./Markdown.tsx";
import { Steps } from "./Steps.tsx";

function RunBlock({ run, live }: { run: Run; live: boolean }) {
	return (
		<div className="run">
			{run.prompt && <div className="bubble">{run.prompt}</div>}
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
	const changesHidden = useStore((s) => Boolean(s.changesHidden[view.path]));
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
				{panelFor(app, view) && (
					<button
						type="button"
						className="changes-toggle"
						aria-pressed={!changesHidden}
						title={changesHidden ? "Show panel" : "Hide panel"}
						onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: !changesHidden } }))}
					>
						{panelFor(app, view) === "changes" ? (
							<>
								<span>{view.changes.length === 1 ? "1 file" : `${view.changes.length} files`}</span>
								<ChangeCount changes={view.changes} />
							</>
						) : panelFor(app, view) === "note" ? (
							<span>Note</span>
						) : (
							<span>Review</span>
						)}
					</button>
				)}
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
				<p>Pick a project folder and say what you need. Sessions keep running when you switch apps.</p>
				<button type="button" className="btn primary" onClick={() => setState({ overlay: "new" })}>
					<PlusIcon size={14} /> New session <span className="kbd">⌘N</span>
				</button>
			</div>
		</main>
	);
}
