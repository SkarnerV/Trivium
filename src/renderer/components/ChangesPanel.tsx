import { type ReactNode, useRef, useState } from "react";
import type { SessionView } from "../../shared/protocol.ts";
import { BranchIcon, CloseIcon, CodeIcon, EyeIcon, FolderIcon, MoreIcon, PenIcon, ServerIcon } from "../icons.tsx";
import { liveChanges, type PanelView, panelViews, shownView } from "../panels.ts";
import { closePanelView, closePreview, selectPreview, setState, useStore } from "../store.ts";
import { ContextMenu } from "./ContextMenu.tsx";
import { FilesBody } from "./FilesPanel.tsx";
import { hasSource, PreviewBody, previewMenu } from "./PreviewPanel.tsx";
import { Resizer } from "./Resizer.tsx";
import { ReviewBody } from "./ReviewPanel.tsx";
import { ServicesBody } from "./ServicesPanel.tsx";
import { changedCount, pathKey, SourceControlBody } from "./SourceControl.tsx";
import { transition } from "../transition.ts";
import { t } from "../i18n.tsx";

const VIEW_ICONS: Record<PanelView, (size: number) => ReactNode> = {
	git: (size) => <BranchIcon size={size} />,
	files: (size) => <FolderIcon size={size} />,
	preview: (size) => <EyeIcon size={size} />,
	services: (size) => <ServerIcon size={size} />,
	review: (size) => <PenIcon size={size} />,
};

const VIEW_NAMES: Record<PanelView, string> = { git: "Source Control", files: "Files", preview: "Preview", services: "Services", review: "Review" };

/** One tab in the panel's head, closed by its own button or a middle click, as a browser's are. One with no `onClose` stays. */
function PanelTab({ name, icon, title, badge, current, onSelect, onClose }: {
	name: string;
	icon: ReactNode;
	title?: string;
	/** A count beside the name, such as Source Control's changed files. */
	badge?: number;
	current: boolean;
	onSelect: () => void;
	onClose?: () => void;
}) {
	return (
		<div
			className="panel-tab"
			aria-current={current}
			title={title ?? name}
			onAuxClick={(event) => {
				if (event.button !== 1) return;
				event.preventDefault();
				onClose?.();
			}}
		>
			<button type="button" role="tab" aria-selected={current} className="panel-tab-name" onClick={onSelect}>
				{icon}
				<span className="ellipsis">{name}</span>
				{badge ? <span className="panel-tab-badge">{badge}</span> : null}
			</button>
			{onClose && (
				<button type="button" className="panel-tab-close" aria-label={t("Close {name}", { name })} title={t("Close")} onClick={onClose}>
					<CloseIcon size={10} width={2.4} />
				</button>
			)}
		</div>
	);
}

/**
 * The Code and Write apps' side panel. Its head holds the views open in it as tabs, as a browser holds pages. In
 * Code, Source Control (the repository's changes, commits and history), the project's files, the services its
 * commands left running, and each file open to preview in a tab of its own; the summary cards open them. In Write,
 * the documents rendered, and their edits to review once there are any.
 */
export function ChangesPanel({ view }: { view: SessionView }) {
	const git = useStore((s) => s.git[view.path]);
	const picked = useStore((s) => s.panelTab[view.path]);
	const tabs = useStore((s) => s.panelTabs[view.path]);
	const previews = useStore((s) => s.previews[view.path]);
	const views = panelViews(view, tabs);
	const tab = shownView(views, picked);
	const files = previews?.files ?? [];
	const file = files.find((f) => f.id === previews?.active) ?? files.at(-1);
	// Rendered or source, by file path, for as long as the panel is open.
	const [sources, setSources] = useState<Record<string, boolean>>({});
	const source = Boolean(file && hasSource(file) && sources[file.path]);
	const [menu, setMenu] = useState<{ x: number; y: number }>();
	// A click on the More button closes its menu on mousedown; the click that follows must not open it again.
	const closed = useRef(0);
	const pick = (next: PanelView, then?: () => void) =>
		transition("tab", () => {
			setState((s) => ({ panelTab: { ...s.panelTab, [view.path]: next } }));
			then?.();
		});
	return (
		<aside className="changes" aria-label={t(VIEW_NAMES[tab])}>
			<Resizer target="panel" />
			<div className={`panel-head${tab === "preview" ? " is-flush" : ""}`}>
				<div className="panel-tabs" role="tablist" aria-label={t("Panel views")}>
					{views.flatMap((name) =>
						name === "preview" && files.length
							? files.map((open) => (
									<PanelTab
										key={open.id}
										name={open.name}
										title={open.rel}
										icon={VIEW_ICONS.preview(13)}
										current={tab === "preview" && open.id === file?.id}
										onSelect={() => pick("preview", () => selectPreview(view.path, open.id))}
										onClose={() => closePreview(view.path, open.id)}
									/>
								))
							: [
									<PanelTab
										key={name}
										name={t(VIEW_NAMES[name])}
										icon={VIEW_ICONS[name](13)}
										badge={name === "git" ? changedCount(git) : undefined}
										current={tab === name}
										onSelect={() => pick(name)}
										onClose={name === "review" ? undefined : () => closePanelView(view.path, name)}
									/>,
								],
					)}
				</div>
				<div className="panel-tools">
					{tab === "preview" && file && hasSource(file) && (
						<button
							type="button"
							className="icon-btn"
							aria-pressed={source}
							aria-label={t("Show source")}
							title={t(source ? "Show it rendered" : "Show source")}
							onClick={() => setSources({ ...sources, [file.path]: !source })}
						>
							<CodeIcon size={15} />
						</button>
					)}
					{tab === "preview" && (
						<button
							type="button"
							className="icon-btn"
							aria-label={t("More")}
							title={t("More")}
							aria-expanded={Boolean(menu)}
							onClick={(event) => {
								if (Date.now() - closed.current < 300) return;
								const rect = event.currentTarget.getBoundingClientRect();
								setMenu({ x: rect.right, y: rect.bottom + 6 });
							}}
						>
							<MoreIcon size={16} />
						</button>
					)}
					<span className="panel-sep" aria-hidden="true" />
					<button
						type="button"
						className="icon-btn"
						aria-label={t("Hide panel")}
						title={t("Hide panel")}
						onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: true } }))}
					>
						<CloseIcon size={13} />
					</button>
				</div>
			</div>
			{tab === "services" ? (
				<ServicesBody view={view} />
			) : tab === "files" ? (
				<FilesBody key={view.path} view={view} git={git} />
			) : tab === "review" ? (
				<ReviewBody view={view} current={liveChanges(view).find((change) => file && pathKey(change.path) === pathKey(file.path))?.path} />
			) : tab === "preview" ? (
				<PreviewBody path={view.path} file={file} source={source} />
			) : (
				<SourceControlBody key={view.path} view={view} git={git} />
			)}
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					align="right"
					label={t("More")}
					entries={previewMenu(view.path, file)}
					onClose={() => {
						closed.current = Date.now();
						setMenu(undefined);
					}}
				/>
			)}
		</aside>
	);
}
