import type { KeyboardEvent, PointerEvent } from "react";
import { setState, useStore } from "../store.ts";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;
const PANEL_MIN = 340;
/** The session pane keeps at least this much of the card when the panel grows. */
const PANE_MIN = 420;
const STEP = 16;

type Target = "sidebar" | "panel";

const variable = (target: Target) => (target === "sidebar" ? "--sidebar-width" : "--panel-width");

function limits(target: Target, box: HTMLElement): [number, number] {
	if (target === "sidebar") return [SIDEBAR_MIN, SIDEBAR_MAX];
	const card = box.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
	return [PANEL_MIN, Math.max(PANEL_MIN, card - PANE_MIN)];
}

function save(target: Target, width: number | undefined): void {
	setState(target === "sidebar" ? { sidebarWidth: width } : { panelWidth: width });
}

/**
 * The drag handle on the sidebar's right edge or the right panel's left edge. While dragging it sets
 * a CSS variable on the shell, so the layout follows the pointer without re-rendering; the width is
 * saved on release. Double-click restores the default width; arrow keys nudge it.
 */
export function Resizer({ target }: { target: Target }) {
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const box = handle.parentElement!;
		const shell = handle.closest<HTMLElement>(".shell")!;
		const [min, max] = limits(target, box);
		const startX = event.clientX;
		const startWidth = box.getBoundingClientRect().width;
		let width = startWidth;
		handle.setPointerCapture(event.pointerId);
		document.body.classList.add("resizing");
		const move = (moved: globalThis.PointerEvent) => {
			const delta = moved.clientX - startX;
			width = Math.min(max, Math.max(min, target === "sidebar" ? startWidth + delta : startWidth - delta));
			shell.style.setProperty(variable(target), `${width}px`);
		};
		const end = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			document.body.classList.remove("resizing");
			if (width !== startWidth) save(target, Math.round(width));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};

	const reset = (event: { currentTarget: HTMLDivElement }) => {
		event.currentTarget.closest<HTMLElement>(".shell")?.style.removeProperty(variable(target));
		save(target, undefined);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const box = event.currentTarget.parentElement!;
		const [min, max] = limits(target, box);
		const grow = (event.key === "ArrowRight") === (target === "sidebar") ? STEP : -STEP;
		save(target, Math.min(max, Math.max(min, Math.round(box.getBoundingClientRect().width + grow))));
	};

	const width = useStore((s) => (target === "sidebar" ? s.sidebarWidth : s.panelWidth));
	return (
		<div
			className={`resizer resizer-${target}`}
			role="separator"
			aria-orientation="vertical"
			aria-label={target === "sidebar" ? "Resize sidebar" : "Resize panel"}
			aria-valuenow={width}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onDoubleClick={reset}
			onKeyDown={onKeyDown}
		/>
	);
}
