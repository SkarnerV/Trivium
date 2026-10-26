import { flushSync } from "react-dom";

/** What changed, which picks the animation in styles.css. */
export type TransitionKind = "app" | "session" | "page" | "section" | "tab";

/**
 * Applies a switch (app, session, page, settings section or panel tab) inside a view transition: the browser
 * snapshots the screen before and after and animates between them, so nothing remounts and drafts, scroll
 * positions and focus stay as they are. Without support, or with reduced motion, the switch is instant.
 */
export function transition(kind: TransitionKind, update: () => void): void {
	const root = document.documentElement;
	if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden) {
		update();
		return;
	}
	root.dataset.transition = kind;
	const view = document.startViewTransition(() => flushSync(update));
	void view.finished.finally(() => {
		if (root.dataset.transition === kind) delete root.dataset.transition;
	});
}
