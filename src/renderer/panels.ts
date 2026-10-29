import type { AppId, GitStatus, SessionView } from "../shared/protocol.ts";

/** Each app's side panel, and whether this session has anything to show in it. */
export function panelFor(app: AppId, view: SessionView): "changes" | "note" | "review" | undefined {
	if (app === "code") return view.changes.length ? "changes" : undefined;
	const live = view.changes.filter((change) => change.status !== "deleted");
	if (app === "research") return live.some((change) => /\.(md|markdown|mdx|txt)$/i.test(change.path)) ? "note" : undefined;
	return live.length ? "review" : undefined;
}

export type PanelKind = "changes" | "note" | "review";

/** The side panel each app has, whether or not this session has anything for it yet. */
export function panelKind(app: AppId): PanelKind {
	return app === "code" ? "changes" : app === "research" ? "note" : "review";
}

/** Open or closed as the user last set it for this session; otherwise open once there is something to show. */
export function panelOpen(app: AppId, view: SessionView, hidden: boolean | undefined): boolean {
	return hidden === undefined ? panelFor(app, view) !== undefined : !hidden;
}

/** What the Code panel can show: this session's edits, the repository's changes, files open to read, or what its commands left running. */
export type CodeView = "session" | "git" | "preview" | "services";

/**
 * The views open as tabs in the Code panel, in the order they were opened. Before the user opens any, it is
 * this session's edits when it has any, else the repository's changes. Git closes when there is no repository.
 */
export function codeViews(view: SessionView, git: GitStatus | null | undefined, open: CodeView[] | undefined): CodeView[] {
	const views = (open ?? [git && !view.changes.length ? "git" : "session"]).filter((name) => name !== "git" || git);
	return views.length ? views : ["session"];
}

/** The tab showing: the one the user picked while it is open, else the one opened last. */
export function codeTab(views: CodeView[], picked: CodeView | undefined): CodeView {
	return picked && views.includes(picked) ? picked : views.at(-1)!;
}
