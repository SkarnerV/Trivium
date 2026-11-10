import { type KeyboardEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FitIcon, MinusIcon, PlusIcon } from "../icons.tsx";
import { t } from "../i18n.tsx";

/** How far out and in the view goes, against the picture's own size. */
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;
/** One press of a zoom button or key. */
const STEP = 1.25;
/** A press that moves less than this before it lets go is a click, not a drag. */
const CLICK_SLOP = 4;
/** However far it is dragged, this much of the picture stays in the frame to grab it back by. */
const KEEP = 48;

interface View {
	scale: number;
	x: number;
	y: number;
}

interface Size {
	width: number;
	height: number;
}

const clamp = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The frame's laid-out size, which an animation running on the page or panel doesn't skew. */
function frameSize(node: HTMLElement | null): Size | undefined {
	return node ? { width: node.clientWidth, height: node.clientHeight } : undefined;
}

export interface ZoomViewProps {
	src: string;
	alt: string;
	/** Added to the frame, such as "diagram" for a picture that sits on white. */
	className?: string;
	/** Fitting enlarges a small picture up to this much. */
	maxFit?: number;
	/** Space around the picture on its sheet, in the picture's own pixels, so it grows as the picture does. */
	pad?: number;
	/** Space kept between the fitted picture and the edge of the frame. */
	margin?: number;
	autoFocus?: boolean;
	/** A click on the frame around the picture, not a drag. */
	onBackdrop?: () => void;
}

/**
 * A picture to look around: it fits the frame at first, the wheel or a pinch zooms at the pointer, dragging
 * moves it, and a double-click zooms in there or back out to fit. The buttons below it and the keyboard (+, -,
 * 0 to fit, 1 for actual size, arrows) do the same. Until the user zooms or moves it, it keeps fitting the frame
 * as the frame changes size.
 */
export function ZoomView(props: ZoomViewProps) {
	// Another picture starts over, fitted.
	return <Zoom key={props.src} {...props} />;
}

function Zoom({ src, alt, className, maxFit = 2, pad = 0, margin = 24, autoFocus, onBackdrop }: ZoomViewProps) {
	const frame = useRef<HTMLDivElement>(null);
	const sheet = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<Size>();
	const [view, setView] = useState<View>();
	const [grabbing, setGrabbing] = useState(false);
	// The view follows the fit until the user moves it.
	const fitted = useRef(true);
	const drag = useRef<{ id: number; x: number; y: number; from: View; moved: boolean; onSheet: boolean } | undefined>(undefined);

	/** Keeps some of the picture in the frame, wherever it is moved or zoomed to. */
	const bound = useCallback(
		(next: View): View => {
			const box = frameSize(frame.current);
			if (!box || !size) return next;
			const width = size.width * next.scale;
			const height = size.height * next.scale;
			const keepX = Math.min(KEEP, width);
			const keepY = Math.min(KEEP, height);
			return {
				scale: next.scale,
				x: Math.min(box.width - keepX, Math.max(keepX - width, next.x)),
				y: Math.min(box.height - keepY, Math.max(keepY - height, next.y)),
			};
		},
		[size],
	);

	const fit = useCallback((): View | undefined => {
		const box = frameSize(frame.current);
		if (!box?.width || !box.height || !size) return undefined;
		const scale = clamp(Math.min(maxFit, (box.width - margin * 2) / size.width, (box.height - margin * 2) / size.height));
		return { scale, x: (box.width - size.width * scale) / 2, y: (box.height - size.height * scale) / 2 };
	}, [size, maxFit, margin]);

	const showFit = useCallback(() => {
		const next = fit();
		if (!next) return;
		fitted.current = true;
		setView(next);
	}, [fit]);

	/** Zooms by `factor`, keeping the point under the pointer (or the frame's middle) where it is. */
	const zoomBy = useCallback(
		(factor: number, clientX?: number, clientY?: number) => {
			const box = frameSize(frame.current);
			const at = frame.current?.getBoundingClientRect();
			if (!box || !at) return;
			const px = clientX === undefined ? box.width / 2 : clientX - at.left;
			const py = clientY === undefined ? box.height / 2 : clientY - at.top;
			fitted.current = false;
			setView((current) => {
				if (!current) return current;
				const scale = clamp(current.scale * factor);
				const k = scale / current.scale;
				return bound({ scale, x: px - (px - current.x) * k, y: py - (py - current.y) * k });
			});
		},
		[bound],
	);

	const moveBy = useCallback(
		(dx: number, dy: number) => {
			fitted.current = false;
			setView((current) => current && bound({ ...current, x: current.x + dx, y: current.y + dy }));
		},
		[bound],
	);

	// Fitted once the picture's size is known, and again whenever the frame changes size until the user moves it.
	useLayoutEffect(() => {
		if (!size || !frame.current) return;
		showFit();
		const observer = new ResizeObserver(() => fitted.current && showFit());
		observer.observe(frame.current);
		return () => observer.disconnect();
	}, [size, showFit]);

	// React's wheel listener is passive, so it could not keep the page from scrolling.
	useEffect(() => {
		const node = frame.current;
		if (!node) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
			// A touchpad pinch arrives as a wheel with Ctrl held, in small steps.
			const rate = event.ctrlKey ? 0.01 : 0.0015;
			zoomBy(Math.exp(-Math.max(-300, Math.min(300, delta)) * rate), event.clientX, event.clientY);
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, [zoomBy]);

	useEffect(() => {
		if (autoFocus) frame.current?.focus({ preventScroll: true });
	}, [autoFocus]);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || !view || (event.target as Element).closest(".zoom-controls")) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		const onSheet = Boolean(sheet.current?.contains(event.target as Node));
		drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: view, moved: false, onSheet };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		if (!current.moved) setGrabbing(true);
		current.moved = true;
		fitted.current = false;
		setView(bound({ ...current.from, x: current.from.x + dx, y: current.from.y + dy }));
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		drag.current = undefined;
		setGrabbing(false);
		if (event.type === "pointerup" && !current.moved && !current.onSheet) onBackdrop?.();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const moves: Record<string, [number, number]> = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] };
		if (event.key === "+" || event.key === "=") zoomBy(STEP);
		else if (event.key === "-" || event.key === "_") zoomBy(1 / STEP);
		else if (event.key === "0") showFit();
		else if (event.key === "1" && view) zoomBy(1 / view.scale);
		else if (moves[event.key]) moveBy(...moves[event.key]!);
		else return;
		event.preventDefault();
	};

	const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
		if (!view || !sheet.current?.contains(event.target as Node)) return;
		// Zoomed in already: back out to fit.
		if (!fitted.current) showFit();
		else zoomBy(2, event.clientX, event.clientY);
	};

	return (
		<div
			ref={frame}
			className={`zoom-frame${grabbing ? " grabbing" : ""}${className ? ` ${className}` : ""}`}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onDoubleClick={onDoubleClick}
			onKeyDown={onKeyDown}
		>
			<div
				ref={sheet}
				className="zoom-sheet"
				style={
					view && size
						? {
								width: size.width * view.scale,
								height: size.height * view.scale,
								padding: pad * view.scale,
								transform: `translate(${Math.round(view.x)}px, ${Math.round(view.y)}px)`,
							}
						: { visibility: "hidden" }
				}
			>
				<img
					src={src}
					alt={alt}
					draggable={false}
					onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth + pad * 2, height: event.currentTarget.naturalHeight + pad * 2 })}
				/>
			</div>
			{view && (
				<div className="zoom-controls" role="toolbar" aria-label={t("Zoom")}>
					<button type="button" aria-label={t("Zoom out")} title={t("Zoom out")} disabled={view.scale <= MIN_SCALE} onClick={() => zoomBy(1 / STEP)}>
						<MinusIcon size={14} />
					</button>
					<button type="button" className="zoom-level" title={t("Actual size")} onClick={() => zoomBy(1 / view.scale)}>
						{Math.round(view.scale * 100)}%
					</button>
					<button type="button" aria-label={t("Zoom in")} title={t("Zoom in")} disabled={view.scale >= MAX_SCALE} onClick={() => zoomBy(STEP)}>
						<PlusIcon size={14} />
					</button>
					<span className="zoom-sep" aria-hidden="true" />
					<button type="button" aria-label={t("Fit to view")} title={t("Fit to view")} onClick={showFit}>
						<FitIcon size={14} />
					</button>
				</div>
			)}
		</div>
	);
}
