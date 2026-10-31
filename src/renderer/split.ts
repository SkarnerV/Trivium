import type { AppId } from "../shared/protocol.ts";

/** Two sessions side by side, by session path: the left pane's first. */
export type Split = [left: string, right: string];

/** Each half of the split is at least this wide; a narrower card shows the focused pane only, with tabs. */
export const SPLIT_PANE_MIN = 360;

/** The data type a sidebar row carries while it is dragged, holding the session's path. */
export const SESSION_DRAG_TYPE = "application/x-trivium-session";

/**
 * The split after `path` is shown in the focused pane, as a click in the sidebar does: one already on screen
 * keeps its place (the caller focuses it), any other takes the focused pane's place.
 */
export function showInSplit(split: Split | undefined, focused: string | undefined, path: string): Split | undefined {
	if (!split || split.includes(path)) return split;
	const next: Split = [...split];
	next[focused === split[1] ? 1 : 0] = path;
	return next;
}

/**
 * The split after `path` opens beside the focused session: in the given half, else the one not focused.
 * Without a focused session, or when `path` is the focused one, there is nothing to pair it with.
 */
export function placeInSplit(split: Split | undefined, focused: string | undefined, path: string, side?: 0 | 1): Split | undefined {
	if (split?.includes(path)) return split;
	if (!split) {
		if (!focused || focused === path) return undefined;
		return side === 0 ? [path, focused] : [focused, path];
	}
	const next: Split = [...split];
	next[side ?? (focused === split[0] ? 1 : 0)] = path;
	return next;
}

/** Forgets sessions that are gone: a split missing either one closes, and the one left becomes the selected session. */
export function withoutSessions(
	split: Partial<Record<AppId, Split>>,
	selected: Partial<Record<AppId, string>>,
	gone: (path: string) => boolean,
): { split: Partial<Record<AppId, Split>>; selected: Partial<Record<AppId, string>> } {
	const nextSplit: Partial<Record<AppId, Split>> = {};
	const nextSelected: Partial<Record<AppId, string>> = {};
	for (const [app, path] of Object.entries(selected) as [AppId, string | undefined][]) {
		if (path && !gone(path)) nextSelected[app] = path;
	}
	for (const [app, pair] of Object.entries(split) as [AppId, Split | undefined][]) {
		if (!pair) continue;
		const left = pair.filter((path) => !gone(path));
		if (left.length === 2 && pair[0] !== pair[1]) {
			nextSplit[app] = pair;
			// The selected session is always one of the two.
			if (!pair.includes(nextSelected[app] ?? "")) nextSelected[app] = pair[0];
		} else if (left.length && !nextSelected[app]) {
			nextSelected[app] = left[0];
		}
	}
	return { split: nextSplit, selected: nextSelected };
}

/** The sessions on screen in an app: both halves of its split, else the selected one. */
export function visibleSessions(split: Split | undefined, selected: string | undefined): string[] {
	return split ? [...split] : selected ? [selected] : [];
}
