import type { SessionView } from "../../shared/protocol.ts";
import { CloseIcon, FileIcon, PenIcon } from "../icons.tsx";
import type { PanelKind } from "../panels.ts";
import { setState } from "../store.ts";
import { Resizer } from "./Resizer.tsx";

const COPY: Record<PanelKind, { title: string; heading: string; text: string }> = {
	changes: {
		title: "Changes",
		heading: "No changes yet",
		text: "Files this session edits show up here, ready to keep or revert.",
	},
	note: {
		title: "Note",
		heading: "No note yet",
		text: "The Markdown note this session writes shows up here as it goes, with its sources.",
	},
	review: {
		title: "Review",
		heading: "Nothing to review yet",
		text: "Documents this session edits show up here with each change marked, to accept or reject.",
	},
};

/** The side panel before the session has anything for it. */
export function EmptyPanel({ view, kind }: { view: SessionView; kind: PanelKind }) {
	const copy = COPY[kind];
	return (
		<aside className="side-panel" aria-label={copy.title}>
			<Resizer target="panel" />
			<div className="side-head">
				<h2 className="side-title">{copy.title}</h2>
				<button
					type="button"
					className="icon-btn"
					aria-label={`Hide ${copy.title.toLowerCase()}`}
					title={`Hide ${copy.title.toLowerCase()}`}
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
export function EmptyBody({ kind }: { kind: PanelKind }) {
	const copy = COPY[kind];
	return (
		<div className="side-body panel-empty">
			<span className="panel-empty-icon">{kind === "changes" ? <FileIcon size={18} /> : <PenIcon size={18} />}</span>
			<h3>{copy.heading}</h3>
			<p>{copy.text}</p>
		</div>
	);
}
