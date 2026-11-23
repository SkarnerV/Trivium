import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import type { DiffLine, ProjectFile } from "../../shared/protocol.ts";
import { t } from "../i18n.tsx";
import { CloseIcon } from "../icons.tsx";

/** The list keeps at least this much height, and so does the pane below it. */
const MIN_LIST = 96;
const MIN_PANE = 120;
const STEP = 24;

/** The list's height, shared by the tabs that split, so it stays where the user left it. */
let savedHeight: number | undefined;

/**
 * A list above and what was picked from it below, in one tab. The line between them drags to give either more
 * room, or moves with the arrow keys; double-click puts it back. Without a pane the list has the whole height.
 */
export function SplitView({ list, pane, label }: { list: ReactNode; pane?: ReactNode; label: string }) {
	const box = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number | undefined>(savedHeight);
	const clamp = (value: number) => {
		const total = box.current?.getBoundingClientRect().height ?? 600;
		return Math.round(Math.min(Math.max(MIN_LIST, value), Math.max(MIN_LIST, total - MIN_PANE)));
	};
	const set = (value: number | undefined) => {
		savedHeight = value;
		setHeight(value);
	};
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const list = handle.previousElementSibling as HTMLElement;
		const startY = event.clientY;
		const start = list.getBoundingClientRect().height;
		let next = start;
		handle.setPointerCapture(event.pointerId);
		document.body.classList.add("resizing-rows");
		const move = (moved: globalThis.PointerEvent) => {
			next = clamp(start + moved.clientY - startY);
			list.style.flexBasis = `${next}px`;
		};
		const end = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			document.body.classList.remove("resizing-rows");
			set(next);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const list = event.currentTarget.previousElementSibling as HTMLElement;
		set(clamp(list.getBoundingClientRect().height + (event.key === "ArrowDown" ? STEP : -STEP)));
	};
	return (
		<div className="split-view" ref={box}>
			<div className={`split-list${pane ? " has-pane" : ""}`} style={pane && height ? { flexBasis: height } : undefined}>
				{list}
			</div>
			{pane && (
				<>
					<div
						className="split-handle"
						role="separator"
						aria-orientation="horizontal"
						aria-label={t("Resize {name}", { name: label })}
						title={t("Drag to resize")}
						tabIndex={0}
						onPointerDown={onPointerDown}
						onKeyDown={onKeyDown}
						onDoubleClick={() => set(undefined)}
					>
						<span />
					</div>
					<div className="split-pane">{pane}</div>
				</>
			)}
		</div>
	);
}

export type PaneMode = "changes" | "file";

/**
 * What was picked from a list, below it: its name and folder, a switch between its changes and the whole file when
 * it has both, its actions, and its lines. Escape closes it.
 */
export function ContentPane({ name, dir, title, meta, modes, mode, onMode, actions, onClose, children }: {
	name: string;
	dir?: string;
	title?: string;
	meta?: ReactNode;
	modes?: PaneMode[];
	mode?: PaneMode;
	onMode?: (mode: PaneMode) => void;
	actions?: ReactNode;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<section
			className="content-pane"
			aria-label={title ?? name}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !event.defaultPrevented) onClose();
			}}
		>
			<div className="cp-head" title={title}>
				<span className="cp-name mono ellipsis">{name}</span>
				<span className="cp-dir ellipsis">
					{dir}
					{meta && <span className="cp-meta">{meta}</span>}
				</span>
				{modes && modes.length > 1 && onMode && (
					<span className="cp-switch" role="group" aria-label={t("Show")}>
						{modes.map((each) => (
							<button key={each} type="button" aria-pressed={each === mode} onClick={() => onMode(each)}>
								{each === "changes" ? t("Changes") : t("File")}
							</button>
						))}
					</span>
				)}
				{actions}
				<button type="button" className="icon-btn" aria-label={t("Close {name}", { name })} title={t("Close")} onClick={onClose}>
					<CloseIcon size={12} />
				</button>
			</div>
			<div className="cp-body">{children}</div>
		</section>
	);
}

/** Lines git sees as added or changed, by their number in the file, from that file's diff. */
export function changeMarks(lines: DiffLine[] | undefined): Map<number, "add" | "change"> {
	const marks = new Map<number, "add" | "change">();
	let removed = 0;
	for (const line of lines ?? []) {
		if (line.kind === "del") removed++;
		else if (line.kind === "add") {
			marks.set(line.newNo!, removed > 0 ? "change" : "add");
			if (removed > 0) removed--;
		} else removed = 0;
	}
	return marks;
}

/** A file's text with line numbers, and git's added and changed lines marked in the margin. */
export function FileText({ file, marks }: { file: ProjectFile; marks?: Map<number, "add" | "change"> }) {
	if (file.tooLarge) return <p className="diff-note">{t("This file is too large to show.")}</p>;
	if (file.binary || file.text === null) return <p className="diff-note">{t("Binary file.")}</p>;
	if (!file.text) return <p className="diff-note">{t("Empty file.")}</p>;
	const rows = file.text.split(/\r?\n/);
	if (rows.at(-1) === "") rows.pop();
	return (
		<div className="file-lines">
			{rows.map((row, index) => (
				<div key={index} className={`file-line${marks?.has(index + 1) ? ` is-${marks.get(index + 1)}` : ""}`}>
					<span className="no">{index + 1}</span>
					<span className="text">{row || " "}</span>
				</div>
			))}
		</div>
	);
}
