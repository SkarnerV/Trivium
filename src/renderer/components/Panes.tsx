import { type DragEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { SessionView } from "../../shared/protocol.ts";
import { focusPane, openInSplit, useStore } from "../store.ts";
import { SESSION_DRAG_TYPE, SPLIT_PANE_MIN } from "../split.ts";
import { SplitIcon } from "../icons.tsx";
import { t } from "../i18n.tsx";
import { Resizer } from "./Resizer.tsx";
import { SessionPane } from "./SessionPane.tsx";

/** The element's width, kept up to date as the window and the panels around it change. */
function useWidth(ref: RefObject<HTMLElement | null>): number | undefined {
	const [width, setWidth] = useState<number>();
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return width;
}

/** The half a dragged session is over: 0 is the left. */
function halfAt(event: DragEvent<HTMLElement>): 0 | 1 {
	const rect = event.currentTarget.getBoundingClientRect();
	return event.clientX < rect.left + rect.width / 2 ? 0 : 1;
}

/**
 * The session on screen, or the two of a split side by side with a handle between them. When the card is too
 * narrow for both, the focused one shows alone with tabs to switch. A session dragged from the sidebar opens
 * in the half it is dropped on.
 */
export function Panes({ view }: { view: SessionView }) {
	const split = useStore((s) => s.split[s.app]);
	const left = useStore((s) => (split ? s.views[split[0]] : undefined));
	const right = useStore((s) => (split ? s.views[split[1]] : undefined));
	const ref = useRef<HTMLDivElement>(null);
	const width = useWidth(ref);
	const [dropSide, setDropSide] = useState<0 | 1>();
	// The half not loaded yet shows once it is; meanwhile the focused one fills the card.
	const pair = left && right && (left.path === view.path || right.path === view.path) ? ([left, right] as const) : undefined;
	const narrow = width !== undefined && width < SPLIT_PANE_MIN * 2;
	const side = pair && !narrow;
	const shown = side ? pair : [view];

	const onDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setDropSide(halfAt(event));
	};
	const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropSide(undefined);
	};
	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		const path = event.dataTransfer.getData(SESSION_DRAG_TYPE);
		setDropSide(undefined);
		if (!path) return;
		event.preventDefault();
		void openInSplit(path, halfAt(event));
	};

	return (
		<div ref={ref} className={`panes${side ? " split" : ""}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
			{shown.map((pane, index) => (
				<div
					key={pane.path}
					className={`split-slot${pane.path === view.path ? " focused" : ""}`}
					onPointerDownCapture={(event) => {
						if (!(event.target as Element).closest(".resizer")) focusPane(pane.path);
					}}
					onFocusCapture={() => focusPane(pane.path)}
				>
					<SessionPane view={pane} split={pair && { focused: pane.path === view.path, tabs: side ? undefined : pair }} />
					{side && index === 0 && <Resizer target="split" />}
				</div>
			))}
			{dropSide !== undefined && (
				<div className={`drop-half ${dropSide === 0 ? "left" : "right"}`} aria-hidden="true">
					<SplitIcon size={26} />
					<span>{t("Open here")}</span>
				</div>
			)}
		</div>
	);
}
