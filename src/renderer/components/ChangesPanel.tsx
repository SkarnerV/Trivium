import { useEffect, useState } from "react";
import type { FileChange, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { CloseIcon, ExternalIcon } from "../icons.tsx";
import { attempt, trivium, setState } from "../store.ts";

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

function DiffView({ change }: { change: FileChange }) {
	if (change.tooLarge) return <p className="diff-note">This file is too large to show a diff.</p>;
	if (!change.lines.length) return <p className="diff-note">{change.status === "deleted" ? "File deleted." : "Empty file."}</p>;
	return (
		<>
			{change.lines.map((line, index) =>
				line.kind === "hunk" ? (
					<div key={index} className="diff-hunk">
						{line.text}
					</div>
				) : (
					<div key={index} className={`diff-line is-${line.kind}`}>
						<span className="no">{line.kind === "del" ? line.oldNo : line.newNo}</span>
						<span className="text">{line.text || " "}</span>
					</div>
				),
			)}
		</>
	);
}

function firstChangedLine(change: FileChange): number | undefined {
	return change.lines.find((line) => line.kind === "add" || line.kind === "ctx")?.newNo;
}

export function ChangesPanel({ view }: { view: SessionView }) {
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
		<aside className="changes" aria-label="Changes">
			<div className="changes-head">
				<h2>Changes</h2>
				<ChangeCount changes={changes} />
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
			<div className="chips" role="tablist" aria-label="Changed files">
				{changes.map((change) => (
					<button
						key={change.path}
						type="button"
						role="tab"
						className="chip"
						aria-selected={change === current}
						title={change.rel}
						onClick={() => setSelected(change.path)}
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
					<DiffView change={current} />
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
		</aside>
	);
}
