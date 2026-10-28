import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { FileChange, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { BranchIcon, CloseIcon, CodeIcon, ExternalIcon, EyeIcon, FileIcon, MoreIcon, ServerIcon, ViewsIcon } from "../icons.tsx";
import { type CodeView, codeTab } from "../panels.ts";
import { attempt, openPreview, trivium, setState, useStore } from "../store.ts";
import { ContextMenu, type MenuEntry } from "./ContextMenu.tsx";
import { DiffView } from "./DiffView.tsx";
import { EmptyBody } from "./EmptyPanel.tsx";
import { GitChanges, gitFileCount } from "./GitPanel.tsx";
import { hasSource, PreviewBody, PreviewTabs, previewMenu } from "./PreviewPanel.tsx";
import { Resizer } from "./Resizer.tsx";
import { ServicesBody, useServices } from "./ServicesPanel.tsx";
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

/**
 * The Code app's side panel. It shows one view at a time, picked from a menu: the files this session edited,
 * every change in the working tree when the project is a git repository, files open to read, or the services
 * its commands left running.
 */
export function ChangesPanel({ view }: { view: SessionView }) {
	const git = useStore((s) => s.git[view.path]);
	const picked = useStore((s) => s.panelTab[view.path]);
	const previews = useStore((s) => s.previews[view.path]);
	const services = useServices(view.path);
	const tab = codeTab(view, git, picked);
	const files = previews?.files ?? [];
	const file = files.find((f) => f.id === previews?.active) ?? files.at(-1);
	// Rendered or source, by file path, for as long as the panel is open.
	const [sources, setSources] = useState<Record<string, boolean>>({});
	const source = Boolean(file && hasSource(file) && sources[file.path]);
	const [menu, setMenu] = useState<{ kind: "views" | "more"; x: number; y: number }>();
	// A click on a menu's own button closes it on mousedown; the click that follows must not open it again.
	const closed = useRef<{ kind: string; at: number }>(undefined);
	const pick = (next: CodeView) => transition("tab", () => setState((s) => ({ panelTab: { ...s.panelTab, [view.path]: next } })));
	const toggleMenu = (kind: "views" | "more") => (event: MouseEvent<HTMLButtonElement>) => {
		if (closed.current?.kind === kind && Date.now() - closed.current.at < 300) return;
		const rect = event.currentTarget.getBoundingClientRect();
		setMenu({ kind, x: rect.right, y: rect.bottom + 6 });
	};
	const title = t({ session: "Changes", git: "Git", preview: "Preview", services: "Services" }[tab]);
	const views: MenuEntry[] = [
		{
			label: t("Changes"),
			icon: <FileIcon size={14} />,
			hint: view.changes.length ? fileCount(view.changes.length) : undefined,
			checked: tab === "session",
			onSelect: () => pick("session"),
		},
		...(git
			? [{ label: t("Git"), icon: <BranchIcon size={14} />, hint: gitFileCount(git) ? fileCount(gitFileCount(git)) : undefined, checked: tab === "git", onSelect: () => pick("git") }]
			: []),
		{ label: t("Preview"), icon: <EyeIcon size={14} />, hint: files.length ? t("{n} open", { n: files.length }) : undefined, checked: tab === "preview", onSelect: () => pick("preview") },
		{
			label: t("Services"),
			icon: <ServerIcon size={14} />,
			hint: services.length ? t("{n} running", { n: services.length }) : undefined,
			checked: tab === "services",
			onSelect: () => pick("services"),
		},
	];
	return (
		<aside className="changes" aria-label={title}>
			<Resizer target="panel" />
			<div className="panel-head">
				{tab === "preview" && files.length ? (
					<PreviewTabs path={view.path} files={files} active={file?.id} />
				) : (
					<h2 className="panel-title">
						{title}
						{tab === "session" && view.changes.length > 0 && <ChangeCount changes={view.changes} />}
					</h2>
				)}
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
						<button type="button" className="icon-btn" aria-label={t("More")} title={t("More")} aria-expanded={menu?.kind === "more"} onClick={toggleMenu("more")}>
							<MoreIcon size={16} />
						</button>
					)}
					<button
						type="button"
						className="icon-btn"
						aria-label={t("Choose what the panel shows")}
						title={t("Panel views")}
						aria-haspopup="menu"
						aria-expanded={menu?.kind === "views"}
						onClick={toggleMenu("views")}
					>
						<ViewsIcon size={16} />
					</button>
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
					label={t(menu.kind === "views" ? "Show in panel" : "More")}
					entries={menu.kind === "views" ? views : previewMenu(view.path, file)}
					onClose={() => {
						closed.current = { kind: menu.kind, at: Date.now() };
						setMenu(undefined);
					}}
				/>
			)}
		</aside>
	);
}

function fileCount(n: number): string {
	return t(n === 1 ? "1 file" : "{n} files", { n });
}
