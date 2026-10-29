import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FileChange, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { BranchIcon, CloseIcon, CodeIcon, ExternalIcon, EyeIcon, FileIcon, MoreIcon, ServerIcon } from "../icons.tsx";
import { type CodeView, codeTab, codeViews } from "../panels.ts";
import { attempt, closePanelView, closePreview, openPreview, selectPreview, trivium, setState, useStore } from "../store.ts";
import { ContextMenu } from "./ContextMenu.tsx";
import { DiffView } from "./DiffView.tsx";
import { EmptyBody } from "./EmptyPanel.tsx";
import { GitChanges } from "./GitPanel.tsx";
import { hasSource, PreviewBody, previewMenu } from "./PreviewPanel.tsx";
import { Resizer } from "./Resizer.tsx";
import { ServicesBody } from "./ServicesPanel.tsx";
import { transition } from "../transition.ts";
import { t } from "../i18n.tsx";

function totals(changes: FileChange[]): { adds: number; dels: number } {
	return changes.reduce((sum, change) => ({ adds: sum.adds + change.adds, dels: sum.dels + change.dels }), { adds: 0, dels: 0 });
}

export function ChangeCount({ changes }: { changes: FileChange[] }) {
	const { adds, dels } = totals(changes);
	return (
		<span className="mono change-count">
			<span className="plus">+{adds}</span> <span className="minus">−{dels}</span>
		</span>
	);
}

function firstChangedLine(change: FileChange): number | undefined {
	return change.lines.find((line) => line.kind === "add" || line.kind === "ctx")?.newNo;
}

/** The files this session edited, to keep or revert. */
function SessionChanges({ view }: { view: SessionView }) {
	const { changes } = view;
	const [selected, setSelected] = useState<string | undefined>();
	const [confirmRevert, setConfirmRevert] = useState(false);
	const [busy, setBusy] = useState(false);
	const current = changes.find((change) => change.path === selected) ?? changes[0];

	useEffect(() => {
		if (!confirmRevert) return;
		const timer = setTimeout(() => setConfirmRevert(false), 4000);
		return () => clearTimeout(timer);
	}, [confirmRevert]);

	const apply = async (action: "keep" | "revert") => {
		setBusy(true);
		const next = await attempt(() =>
			action === "keep" ? trivium.keepChanges(view.path) : trivium.revertChanges(view.path),
		);
		setBusy(false);
		setConfirmRevert(false);
		if (next) {
			setState((s) => {
				const latest = s.views[view.path];
				return latest ? { views: { ...s.views, [view.path]: { ...latest, changes: next } } } : {};
			});
		}
	};

	const files = t(changes.length === 1 ? "1 file" : "{n} files", { n: changes.length });
	return (
		<>
			<div className="chips" role="tablist" aria-label={t("Changed files")}>
				{changes.map((change) => (
					<button
						key={change.path}
						type="button"
						role="tab"
						className="chip"
						aria-selected={change === current}
						title={change.rel}
						onClick={() => transition("tab", () => setSelected(change.path))}
					>
						<span>{baseName(change.rel)}</span>
						{change.status === "added" && <span className="tag">{t("new")}</span>}
						{change.status === "deleted" && <span className="tag">{t("deleted")}</span>}
						{change.adds > 0 && <span className="plus">+{change.adds}</span>}
						{change.dels > 0 && <span className="minus">−{change.dels}</span>}
					</button>
				))}
			</div>
			{current && (
				<div className="diff" role="tabpanel">
					<div className="diff-path">{current.rel}</div>
					<DiffView lines={current.lines} tooLarge={current.tooLarge} empty={t(current.status === "deleted" ? "File deleted." : "Empty file.")} />
				</div>
			)}
			<div className="changes-foot">
				<button type="button" className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void apply("keep")}>
					{t("Keep changes")}
				</button>
				<button
					type="button"
					className={`btn revert${confirmRevert ? " confirm" : ""}`}
					disabled={busy || view.running}
					title={view.running ? t("Stop the run before reverting") : t("Restore {files} to how they were before this session changed them", { files })}
					onClick={() => (confirmRevert ? void apply("revert") : setConfirmRevert(true))}
				>
					{confirmRevert ? t("Revert {files}?", { files }) : t("Revert")}
				</button>
				{current && current.status !== "deleted" && (
					<button type="button" className="btn square" aria-label={t("Preview")} title={t("Preview")} onClick={() => void openPreview(view.path, current.path)}>
						<EyeIcon size={15} />
					</button>
				)}
				{current && current.status !== "deleted" && (
					<button
						type="button"
						className="btn square"
						aria-label={t("Open in editor")}
						title={t("Open in VS Code")}
						onClick={() => void attempt(() => trivium.openInEditor(current.path, firstChangedLine(current)))}
					>
						<ExternalIcon />
					</button>
				)}
			</div>
		</>
	);
}

const VIEW_ICONS: Record<CodeView, (size: number) => ReactNode> = {
	session: (size) => <FileIcon size={size} />,
	git: (size) => <BranchIcon size={size} />,
	preview: (size) => <EyeIcon size={size} />,
	services: (size) => <ServerIcon size={size} />,
};

const VIEW_NAMES: Record<CodeView, string> = { session: "Changes", git: "Git", preview: "Preview", services: "Services" };

/** One tab in the panel's head, closed by its own button or a middle click, as a browser's are. */
function PanelTab({ name, icon, title, current, onSelect, onClose }: {
	name: string;
	icon: ReactNode;
	title?: string;
	current: boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	return (
		<div
			className="panel-tab"
			aria-current={current}
			title={title ?? name}
			onAuxClick={(event) => {
				if (event.button !== 1) return;
				event.preventDefault();
				onClose();
			}}
		>
			<button type="button" role="tab" aria-selected={current} className="panel-tab-name" onClick={onSelect}>
				{icon}
				<span className="ellipsis">{name}</span>
			</button>
			<button type="button" className="panel-tab-close" aria-label={t("Close {name}", { name })} title={t("Close")} onClick={onClose}>
				<CloseIcon size={10} width={2.4} />
			</button>
		</div>
	);
}

/**
 * The Code app's side panel. Its head holds the views open in it as tabs, as a browser holds pages: the files
 * this session edited, every change in the working tree when the project is a git repository, the services its
 * commands left running, and each file open to read in a tab of its own. The summary cards open them.
 */
export function ChangesPanel({ view }: { view: SessionView }) {
	const git = useStore((s) => s.git[view.path]);
	const picked = useStore((s) => s.panelTab[view.path]);
	const tabs = useStore((s) => s.panelTabs[view.path]);
	const previews = useStore((s) => s.previews[view.path]);
	const views = codeViews(view, git, tabs);
	const tab = codeTab(views, picked);
	const files = previews?.files ?? [];
	const file = files.find((f) => f.id === previews?.active) ?? files.at(-1);
	// Rendered or source, by file path, for as long as the panel is open.
	const [sources, setSources] = useState<Record<string, boolean>>({});
	const source = Boolean(file && hasSource(file) && sources[file.path]);
	const [menu, setMenu] = useState<{ x: number; y: number }>();
	// A click on the More button closes its menu on mousedown; the click that follows must not open it again.
	const closed = useRef(0);
	const pick = (next: CodeView, then?: () => void) =>
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
										current={tab === name}
										onSelect={() => pick(name)}
										onClose={() => closePanelView(view.path, name)}
									/>,
								],
					)}
				</div>
				<div className="panel-tools">
					{tab === "session" && view.changes.length > 0 && <ChangeCount changes={view.changes} />}
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
			) : tab === "preview" ? (
				<PreviewBody path={view.path} file={file} source={source} />
			) : tab === "git" && git ? (
				<GitChanges view={view} git={git} />
			) : view.changes.length ? (
				<SessionChanges view={view} />
			) : (
				<EmptyBody kind="changes" />
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
