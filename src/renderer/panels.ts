import type { AppId, SessionView } from "../shared/protocol.ts";

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
