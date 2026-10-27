import { useEffect, useState } from "react";
import type { FileChange, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { CloseIcon, ExternalIcon } from "../icons.tsx";
import { codeTab } from "../panels.ts";
import { attempt, trivium, setState, useStore } from "../store.ts";
import { DiffView } from "./DiffView.tsx";
import { EmptyBody } from "./EmptyPanel.tsx";
import { GitChanges, gitFileCount } from "./GitPanel.tsx";
import { Resizer } from "./Resizer.tsx";
import { transition } from "../transition.ts";

function totals(changes: FileChange[]): { adds: number; dels: number } {
	return changes.reduce((sum, change) => ({ adds: sum.adds + change.adds, dels: sum.dels + change.dels }), { adds: 0, dels: 0 });
}

export function ChangeCount({ changes }: { changes: FileChange[] }) {
	const { adds, dels } = totals(changes);
	return (
		<span className="mono change-count">
			<span className="plus">+{adds}</span> <span className="minus">−{dels}</span>
		</span>
	);
}

function firstChangedLine(change: FileChange): number | undefined {
	return change.lines.find((line) => line.kind === "add" || line.kind === "ctx")?.newNo;
}

/** The files this session edited, to keep or revert. */
function SessionChanges({ view }: { view: SessionView }) {
	const { changes } = view;
	const [selected, setSelected] = useState<string | undefined>();
	const [confirmRevert, setConfirmRevert] = useState(false);
	const [busy, setBusy] = useState(false);
	const current = changes.find((change) => change.path === selected) ?? changes[0];

	useEffect(() => {
		if (!confirmRevert) return;
		const timer = setTimeout(() => setConfirmRevert(false), 4000);
		return () => clearTimeout(timer);
	}, [confirmRevert]);

	const apply = async (action: "keep" | "revert") => {
		setBusy(true);
		const next = await attempt(() =>
			action === "keep" ? trivium.keepChanges(view.path) : trivium.revertChanges(view.path),
		);
		setBusy(false);
		setConfirmRevert(false);
		if (next) {
			setState((s) => {
				const latest = s.views[view.path];
				return latest ? { views: { ...s.views, [view.path]: { ...latest, changes: next } } } : {};
			});
		}
	};

	const files = changes.length === 1 ? "1 file" : `${changes.length} files`;
	return (
		<>
			<div className="chips" role="tablist" aria-label="Changed files">
				{changes.map((change) => (
					<button
						key={change.path}
						type="button"
						role="tab"
						className="chip"
						aria-selected={change === current}
						title={change.rel}
						onClick={() => transition("tab", () => setSelected(change.path))}
					>
						<span>{baseName(change.rel)}</span>
						{change.status === "added" && <span className="tag">new</span>}
						{change.status === "deleted" && <span className="tag">deleted</span>}
						{change.adds > 0 && <span className="plus">+{change.adds}</span>}
						{change.dels > 0 && <span className="minus">−{change.dels}</span>}
					</button>
				))}
			</div>
			{current && (
				<div className="diff" role="tabpanel">
					<div className="diff-path">{current.rel}</div>
					<DiffView lines={current.lines} tooLarge={current.tooLarge} empty={current.status === "deleted" ? "File deleted." : "Empty file."} />
				</div>
			)}
			<div className="changes-foot">
				<button type="button" className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void apply("keep")}>
					Keep changes
				</button>
				<button
					type="button"
					className={`btn revert${confirmRevert ? " confirm" : ""}`}
					disabled={busy || view.running}
					title={view.running ? "Stop the run before reverting" : `Restore ${files} to how they were before this session changed them`}
					onClick={() => (confirmRevert ? void apply("revert") : setConfirmRevert(true))}
				>
					{confirmRevert ? `Revert ${files}?` : "Revert"}
				</button>
				{current && current.status !== "deleted" && (
					<button
						type="button"
						className="btn square"
						aria-label="Open in editor"
						title="Open in VS Code"
						onClick={() => void attempt(() => trivium.openInEditor(current.path, firstChangedLine(current)))}
					>
						<ExternalIcon />
					</button>
				)}
			</div>
		</>
	);
}

/**
 * The Code app's side panel. In a git repository it has two tabs: the files this session edited, and every
 * change in the working tree on the current branch, whoever made it.
 */
export function ChangesPanel({ view }: { view: SessionView }) {
	const git = useStore((s) => s.git[view.path]);
	const picked = useStore((s) => s.panelTab[view.path]);
	const tab = codeTab(view, git, picked);
	const pick = (next: "session" | "git") => transition("tab", () => setState((s) => ({ panelTab: { ...s.panelTab, [view.path]: next } })));
	return (
		<aside className="changes" aria-label="Changes">
			<Resizer target="panel" />
			<div className="changes-head">
				{git ? (
					<div className="seg" role="tablist" aria-label="Changes">
						<button type="button" role="tab" aria-selected={tab === "session"} onClick={() => pick("session")}>
							This session {view.changes.length > 0 && <span className="seg-count">{view.changes.length}</span>}
						</button>
						<button type="button" role="tab" aria-selected={tab === "git"} onClick={() => pick("git")}>
							Git {gitFileCount(git) > 0 && <span className="seg-count">{gitFileCount(git)}</span>}
						</button>
					</div>
				) : (
					<h2>Changes</h2>
				)}
				{tab === "session" && view.changes.length > 0 && <ChangeCount changes={view.changes} />}
				<button
					type="button"
					className="icon-btn"
					style={{ marginLeft: "auto" }}
					aria-label="Hide changes"
					title="Hide changes"
					onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: true } }))}
				>
					<CloseIcon size={13} />
				</button>
			</div>
			{tab === "git" && git ? (
				<GitChanges view={view} git={git} />
			) : view.changes.length ? (
				<SessionChanges view={view} />
			) : (
				<EmptyBody kind="changes" />
			)}
		</aside>
	);
}
