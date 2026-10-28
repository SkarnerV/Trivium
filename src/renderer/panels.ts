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
 * The Code panel's view: the user's pick (Git only in a repository), else this session's edits when it has
 * any, else the repository's changes.
 */
export function codeTab(view: SessionView, git: GitStatus | null | undefined, picked: CodeView | undefined): CodeView {
	if (picked === "preview" || picked === "services" || (picked === "git" && git)) return picked;
	if (picked === "session" || !git) return "session";
	return view.changes.length ? "session" : "git";
}
