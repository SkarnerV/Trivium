import type { SessionView } from "../../shared/protocol.ts";
import { CloseIcon, FileIcon, HistoryIcon, PenIcon } from "../icons.tsx";
import { setState } from "../store.ts";
import { Resizer } from "./Resizer.tsx";
import { t } from "../i18n.tsx";

type EmptyKind = "changes" | "history" | "noRepo" | "note";

const COPY: Record<EmptyKind, { title: string; heading: string; text: string }> = {
	changes: {
		title: "Changes",
		heading: "No changes yet",
		text: "Files this session edits show up here, ready to review or revert.",
	},
	history: {
		title: "History",
		heading: "No commits yet",
		text: "Once this repository has commits, each branch shows up here with the files every commit changed.",
	},
	noRepo: {
		title: "History",
		heading: "Not a git repository",
		text: "This folder has no commits to show. Run git init here, or ask the agent to, and its history shows up in this tab.",
	},
	note: {
		title: "Note",
		heading: "No note yet",
		text: "The Markdown note this session writes shows up here as it goes, with its sources.",
	},
};

/** The side panel before the session has anything for it. */
export function EmptyPanel({ view, kind }: { view: SessionView; kind: EmptyKind }) {
	const copy = COPY[kind];
	return (
		<aside className="side-panel" aria-label={t(copy.title)}>
			<Resizer target="panel" />
			<div className="side-head">
				<h2 className="side-title">{t(copy.title)}</h2>
				<button
					type="button"
					className="icon-btn"
					aria-label={t("Hide panel")}
					title={t("Hide panel")}
					onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: true } }))}
				>
					<CloseIcon size={13} />
				</button>
			</div>
			<EmptyBody kind={kind} />
		</aside>
	);
}

/** What the panel says while there is nothing in it, below its head. */
export function EmptyBody({ kind }: { kind: EmptyKind }) {
	const copy = COPY[kind];
	return (
		<div className="side-body panel-empty">
			<span className="panel-empty-icon">{kind === "changes" ? <FileIcon size={18} /> : kind === "note" ? <PenIcon size={18} /> : <HistoryIcon size={18} />}</span>
			<h3>{t(copy.heading)}</h3>
			<p>{t(copy.text)}</p>
		</div>
	);
}
