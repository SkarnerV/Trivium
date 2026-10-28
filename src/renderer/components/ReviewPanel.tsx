import { diffWordsWithSpace } from "diff";
import { useEffect, useState } from "react";
import type { FileReview, ReviewSegment, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { CloseIcon } from "../icons.tsx";
import { askConfirm, attempt, setState, trivium } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { Resizer } from "./Resizer.tsx";
import { transition } from "../transition.ts";
import { t } from "../i18n.tsx";

type Change = Extract<ReviewSegment, { kind: "change" }>;

function paragraphs(text: string): number {
	return text.split(/\n\s*\n/).filter((part) => part.trim()).length;
}

function describe(change: Change): string {
	if (!change.del.trim()) return t(paragraphs(change.ins) > 1 ? "Added a section" : "Added a paragraph");
	if (!change.ins.trim()) return t(paragraphs(change.del) > 1 ? "Removed a section" : "Removed a paragraph");
	const count = Math.max(paragraphs(change.del), paragraphs(change.ins));
	return count > 1 ? t("Rewrote {n} paragraphs", { n: count }) : t("Rewrote a paragraph");
}

/** The change as running text: removed words struck through, added words underlined. */
function InlineDiff({ change }: { change: Change }) {
	if (!change.del) return <p className="ins-only">{change.ins.trim()}</p>;
	if (!change.ins) return <p className="del-only">{change.del.trim()}</p>;
	const parts = diffWordsWithSpace(change.del.trim(), change.ins.trim());
	// A rewrite reads better as old text then new text than as interleaved fragments.
	const kept = parts.filter((part) => !part.added && !part.removed).reduce((sum, part) => sum + part.value.length, 0);
	if (kept < change.ins.trim().length * 0.5) {
		return (
			<>
				<p className="del-only">{change.del.trim()}</p>
				<p className="ins-only">{change.ins.trim()}</p>
			</>
		);
	}
	return (
		<p>
			{parts.map((part, index) =>
				part.added ? <ins key={index}>{part.value}</ins> : part.removed ? <del key={index}>{part.value}</del> : <span key={index}>{part.value}</span>,
			)}
		</p>
	);
}

/** The Write app's side panel: the document with each change shown in place, to accept or reject one by one. */
export function ReviewPanel({ view }: { view: SessionView }) {
	const files = view.changes.filter((change) => change.status !== "deleted");
	const [selected, setSelected] = useState<string>();
	const [review, setReview] = useState<FileReview>();
	const [busy, setBusy] = useState(false);
	const file = files.find((f) => f.path === selected) ?? files[0];
	const version = file ? `${file.path}:${file.adds}:${file.dels}:${file.lines.length}` : "";

	useEffect(() => {
		if (!file) return;
		let current = true;
		void attempt(() => trivium.reviewFile(view.path, file.path)).then((next) => current && next && setReview(next));
		return () => {
			current = false;
		};
	}, [view.path, version]);

	if (!file) return null;
	const shown = review?.path === file.path ? review : undefined;

	const resolve = async (change: Change, action: "accept" | "reject") => {
		setBusy(true);
		const next = await attempt(() =>
			trivium.resolveChange(view.path, file.path, change.id, action, { del: change.del, ins: change.ins }),
		);
		setBusy(false);
		if (next) setReview(next);
	};

	const resolveAll = async (action: "accept" | "reject") => {
		if (action === "reject") {
			const ok = await askConfirm({
				title: t("Reject every change?"),
				message: t("{file} goes back to how it was before this session changed it.", { file: baseName(file.rel) }),
				confirmLabel: t("Reject all"),
			});
			if (!ok) return;
		}
		setBusy(true);
		const next = await attempt(() =>
			action === "accept" ? trivium.keepChanges(view.path, [file.path]) : trivium.revertChanges(view.path, [file.path]),
		);
		setBusy(false);
		if (next) setState((s) => (s.views[view.path] ? { views: { ...s.views, [view.path]: { ...s.views[view.path]!, changes: next } } } : {}));
	};

	const pending = shown?.pending ?? 0;
	return (
		<aside className="side-panel review-panel" aria-label={t("Document review")}>
			<Resizer target="panel" />
			<div className="side-head">
				<h2 className="mono">{baseName(file.rel)}</h2>
				{pending > 0 && <span className="pending-pill">{t(pending === 1 ? "1 change to review" : "{n} changes to review", { n: pending })}</span>}
				<div className="side-actions">
					<button type="button" className="btn" disabled={busy || view.running} onClick={() => void resolveAll("reject")}>
						{t("Reject all")}
					</button>
					<button type="button" className="btn primary" disabled={busy} onClick={() => void resolveAll("accept")}>
						{t("Accept all")}
					</button>
				</div>
				<button
					type="button"
					className="icon-btn"
					aria-label={t("Hide review")}
					title={t("Hide review")}
					onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: true } }))}
				>
					<CloseIcon size={13} />
				</button>
			</div>
			{files.length > 1 && (
				<div className="chips" role="tablist" aria-label={t("Changed documents")}>
					{files.map((f) => (
						<button key={f.path} type="button" role="tab" className="chip" aria-selected={f === file} title={f.rel} onClick={() => transition("tab", () => setSelected(f.path))}>
							{baseName(f.rel)}
						</button>
					))}
				</div>
			)}
			<div className="side-body">
				<article className="doc answer">
					{shown?.segments.map((segment, index) =>
						segment.kind === "same" ? (
							<Markdown key={`same-${index}`} text={segment.text} />
						) : (
							<div key={`change-${segment.id}`} className="tracked">
								<InlineDiff change={segment} />
								<div className="tracked-bar">
									<span>{describe(segment)}</span>
									<button
										type="button"
										className="btn"
										disabled={busy || view.running}
										aria-label={t("Reject: {change}", { change: describe(segment) })}
										title={view.running ? t("Stop the run before rejecting") : undefined}
										onClick={() => void resolve(segment, "reject")}
									>
										{t("Reject")}
									</button>
									<button
										type="button"
										className="btn primary"
										disabled={busy}
										aria-label={t("Accept: {change}", { change: describe(segment) })}
										onClick={() => void resolve(segment, "accept")}
									>
										{t("Accept")}
									</button>
								</div>
							</div>
						),
					)}
				</article>
			</div>
		</aside>
	);
}
