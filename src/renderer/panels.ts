import type { AppId, SessionView } from "../shared/protocol.ts";

/** Each app's side panel, and whether this session has anything to show in it. */
export function panelFor(app: AppId, view: SessionView): "changes" | "note" | "review" | undefined {
	if (app === "code") return view.changes.length ? "changes" : undefined;
	const live = view.changes.filter((change) => change.status !== "deleted");
	if (app === "research") return live.some((change) => /\.(md|markdown|mdx|txt)$/i.test(change.path)) ? "note" : undefined;
	return live.length ? "review" : undefined;
}
