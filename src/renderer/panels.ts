import type { AppId, FileChange, Run, SessionView } from "../shared/protocol.ts";

/** The changes that still have a file to show. */
export function liveChanges(view: Pick<SessionView, "changes">): FileChange[] {
	return view.changes.filter((change) => change.status !== "deleted");
}

/** Each app's side panel, and whether this session has anything to show in it. */
export function panelFor(app: AppId, view: SessionView): "changes" | "note" | "document" | undefined {
	if (app === "code") return view.changes.length ? "changes" : undefined;
	const live = liveChanges(view);
	if (app === "research") return live.some((change) => /\.(md|markdown|mdx|txt)$/i.test(change.path)) ? "note" : undefined;
	return live.length ? "document" : undefined;
}

export type PanelKind = "changes" | "note" | "document";

/** The side panel each app has, whether or not this session has anything for it yet. */
export function panelKind(app: AppId): PanelKind {
	return app === "code" ? "changes" : app === "research" ? "note" : "document";
}

/** Open or closed as the user last set it for this session; otherwise open once there is something to show. */
export function panelOpen(app: AppId, view: SessionView, hidden: boolean | undefined): boolean {
	return hidden === undefined ? panelFor(app, view) !== undefined : !hidden;
}

/** What the tabbed panel can show: the changes (this session's edits and the repository's others), files open to read, what commands left running, or a document's edits to accept or reject. */
export type PanelView = "session" | "preview" | "services" | "review";

/**
 * The views in a session's tabbed panel. Code's are the ones open as tabs, in the order they were opened, or the
 * changes before the user opens any. Write always has its documents, and Review for as long as there are edits.
 */
export function panelViews(view: Pick<SessionView, "app" | "changes">, open: PanelView[] | undefined): PanelView[] {
	if (view.app === "write") return liveChanges(view).length ? ["preview", "review"] : ["preview"];
	return open?.length ? open : ["session"];
}

/** The tab showing: the one the user picked while it is open, else the last one. */
export function shownView(views: PanelView[], picked: PanelView | undefined): PanelView {
	return picked && views.includes(picked) ? picked : views.at(-1)!;
}

/**
 * The file a Write session is working on, to show without waiting for a change: the last one it edited, or
 * while no document is open, the last one it read.
 */
export function workingDocument(runs: Run[], noneOpen: boolean): string | undefined {
	const steps = runs.flatMap((run) => run.steps).filter((step) => step.status === "done" && step.target);
	const edited = steps.findLast((step) => step.tool === "edit" || step.tool === "write");
	if (edited || !noneOpen) return edited?.target;
	return steps.findLast((step) => step.tool === "read" && /\.(md|markdown|mdx|txt)$/i.test(step.target))?.target;
}
