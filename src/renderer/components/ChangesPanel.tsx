import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FileChange, GitArea, GitDiff, GitFile, GitStatus, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { BranchIcon, Chevron, CloseIcon, CodeIcon, ExternalIcon, EyeIcon, FileIcon, MoreIcon, ServerIcon } from "../icons.tsx";
import { type CodeView, codeTab, codeViews } from "../panels.ts";
import { IS_WINDOWS } from "../platform.ts";
import { attempt, closePanelView, closePreview, errorText, openPreview, selectPreview, trivium, setState, useStore } from "../store.ts";
import { ContextMenu } from "./ContextMenu.tsx";
import { DiffView } from "./DiffView.tsx";
import { EmptyBody } from "./EmptyPanel.tsx";
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

const MARK: Record<GitFile["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	untracked: "U",
	conflicted: "!",
};

/** In the order they need attention: conflicts block a commit, and staged files go into the next one. */
const AREAS: GitArea[] = ["conflicted", "staged", "unstaged", "untracked"];

/** The branch as the panel and its card show it: its name, or the commit a detached HEAD is at. */
export function branchLabel(git: GitStatus): string {
	return git.branch ?? (git.head ? t("detached at {commit}", { commit: git.head }) : t("detached"));
}

/** A path to compare by: git and the session's records may write the same Windows path with other slashes or case. */
function pathKey(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	return IS_WINDOWS ? slashed.toLowerCase() : slashed;
}

/**
 * What git reports that this session did not change: edits made by hand or before the session, and files it
 * kept or committed since. A file both staged and changed again shows once per area, conflicts first.
 */
export function otherChanges(changes: FileChange[], git: GitStatus | null | undefined): GitFile[] {
	if (!git) return [];
	const ours = new Set(changes.map((change) => pathKey(change.path)));
	return git.files
		.filter((file) => !ours.has(pathKey(file.path)))
		.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area));
}

/** The tag a file's row carries when git has it somewhere other than plain changed. */
function areaTag(areas: GitArea[]): string | undefined {
	if (areas.includes("conflicted")) return t("conflict");
	if (areas.includes("staged")) return t("staged");
	return undefined;
}

function dirName(rel: string): string {
	const slash = rel.replaceAll("\\", "/").lastIndexOf("/");
	return slash > 0 ? rel.slice(0, slash) : "";
}

function emptyNote(status: GitFile["status"], binary = false): string {
	if (binary) return t("Binary file.");
	if (status === "deleted") return t("File deleted.");
	if (status === "renamed" || status === "copied" || status === "typechange") return t("No changes to the content.");
	return t("Empty file.");
}

function FileRow({ status, rel, title, current, tag, onSelect, children }: {
	status: GitFile["status"];
	rel: string;
	title?: string;
	current: boolean;
	tag?: string;
	onSelect: () => void;
	children?: ReactNode;
}) {
	return (
		<button type="button" className="change-file" aria-current={current} title={title ?? rel} onClick={() => transition("tab", onSelect)}>
			<span className={`change-mark is-${status}`} aria-label={status}>
				{MARK[status]}
			</span>
			<span className="change-name ellipsis">{baseName(rel)}</span>
			<span className="change-dir ellipsis">{dirName(rel)}</span>
			<span className="change-meta">
				{tag && <span className="tag">{tag}</span>}
				{children}
			</span>
		</button>
	);
}

function Section({ label, count, folded, onFold, children }: { label: string; count: number; folded: boolean; onFold: () => void; children: ReactNode }) {
	return (
		<section className="change-section">
			<button type="button" className="change-section-head" aria-expanded={!folded} onClick={onFold}>
				<Chevron open={!folded} size={10} />
				<span>{label}</span>
				<span className="change-section-count">{count}</span>
			</button>
			{!folded && children}
		</section>
	);
}

type Picked = { kind: "session"; change: FileChange } | { kind: "git"; file: GitFile };

const pickedKey = (picked: Picked) => (picked.kind === "session" ? `session:${picked.change.path}` : `git:${picked.file.area}:${picked.file.rel}`);

/**
 * The Code panel's Changes view: the branch, the files this session edited (to keep or revert), any other
 * uncommitted changes git reports, and the selected file's diff. Outside a repository it is the session's files alone.
 */
function ChangesBody({ view, git }: { view: SessionView; git: GitStatus | null | undefined }) {
	const { changes } = view;
	const others = otherChanges(changes, git);
	const [selected, setSelected] = useState<string | undefined>();
	const [folded, setFolded] = useState<{ session?: boolean; other?: boolean }>({});
	const [confirmRevert, setConfirmRevert] = useState(false);
	const [busy, setBusy] = useState(false);
	const [shown, setShown] = useState<{ key: string; diff?: GitDiff; error?: string }>();
	const items: Picked[] = [
		...changes.map((change) => ({ kind: "session" as const, change })),
		...others.map((file) => ({ kind: "git" as const, file })),
	];
	const current = items.find((item) => pickedKey(item) === selected) ?? items[0];
	const key = current ? pickedKey(current) : "";
	const gitFile = current?.kind === "git" ? current.file : undefined;

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

	useEffect(() => {
		if (!gitFile) return;
		let live = true;
		trivium.gitDiff(view.path, { rel: gitFile.rel, area: gitFile.area }).then(
			(diff) => live && setShown({ key, diff }),
			(error: unknown) => live && setShown({ key, error: errorText(error) }),
		);
		return () => {
			live = false;
		};
		// A new status object means git was read again, and the file may have changed since.
	}, [view.path, key, git]);

	// Where git has each file this session changed, to tag the ones staged or in conflict.
	const areas = new Map<string, GitArea[]>();
	for (const file of git?.files ?? []) areas.set(pathKey(file.path), [...(areas.get(pathKey(file.path)) ?? []), file.area]);

	const files = t(changes.length === 1 ? "1 file" : "{n} files", { n: changes.length });
	const gitDiff = shown?.key === key ? shown : undefined;
	const path = current?.kind === "session" ? current.change.path : current?.file.path;
	const rel = (current?.kind === "session" ? current.change.rel : current?.file.rel) ?? "";
	const status = current?.kind === "session" ? current.change.status : current?.file.status;
	const counts = current?.kind === "session" ? current.change : gitDiff?.diff;
	return (
		<>
			{git && (
				<div className="git-branch" title={git.root}>
					<BranchIcon size={13} />
					<span className="mono ellipsis">{branchLabel(git)}</span>
					{git.upstream && <span className="git-upstream mono ellipsis">{git.upstream}</span>}
					{git.ahead > 0 && <span className="git-sync">{t("{n} to push", { n: git.ahead })}</span>}
					{git.behind > 0 && <span className="git-sync is-pull">{t("{n} to pull", { n: git.behind })}</span>}
				</div>
			)}
			{!current ? (
				<EmptyBody kind="changes" />
			) : (
				<>
					<div className="change-list">
						{changes.length > 0 && (
							<Section
								label={t("This session")}
								count={changes.length}
								folded={Boolean(folded.session)}
								onFold={() => setFolded({ ...folded, session: !folded.session })}
							>
								{changes.map((change) => (
									<FileRow
										key={change.path}
										status={change.status}
										rel={change.rel}
										current={current.kind === "session" && current.change === change}
										tag={areaTag(areas.get(pathKey(change.path)) ?? [])}
										onSelect={() => setSelected(`session:${change.path}`)}
									>
										{change.adds > 0 && <span className="plus">+{change.adds}</span>}
										{change.dels > 0 && <span className="minus">−{change.dels}</span>}
									</FileRow>
								))}
							</Section>
						)}
						{others.length > 0 && (
							<Section
								label={t("Other uncommitted changes")}
								count={others.length}
								folded={Boolean(folded.other)}
								onFold={() => setFolded({ ...folded, other: !folded.other })}
							>
								{others.map((file) => (
									<FileRow
										key={`${file.area}:${file.rel}`}
										status={file.status}
										rel={file.rel}
										title={file.from ? `${file.from} → ${file.rel}` : file.rel}
										current={current.kind === "git" && current.file === file}
										tag={areaTag([file.area])}
										onSelect={() => setSelected(`git:${file.area}:${file.rel}`)}
									/>
								))}
							</Section>
						)}
						{git?.truncated && <p className="change-more">{t("Showing the first {n} changes.", { n: git.files.length })}</p>}
					</div>
					<div className={`diff${changes.length ? "" : " is-last"}`} role="region" aria-label={t("Diff of {file}", { file: rel })}>
						<div className="diff-path change-diff-path" title={current.kind === "git" && current.file.from ? `${current.file.from} → ${current.file.rel}` : rel}>
							<span className="change-name ellipsis">{baseName(rel)}</span>
							<span className="change-dir ellipsis">{dirName(rel)}</span>
							{counts && (counts.adds > 0 || counts.dels > 0) && (
								<span className="change-count">
									<span className="plus">+{counts.adds}</span> <span className="minus">−{counts.dels}</span>
								</span>
							)}
							{path && status !== "deleted" && (
								<button type="button" className="icon-btn" aria-label={t("Preview")} title={t("Preview")} onClick={() => void openPreview(view.path, path)}>
									<EyeIcon size={14} />
								</button>
							)}
							{path && status !== "deleted" && (
								<button
									type="button"
									className="icon-btn"
									aria-label={t("Open in editor")}
									title={t("Open in VS Code")}
									onClick={() => void attempt(() => trivium.openInEditor(path, current.kind === "session" ? firstChangedLine(current.change) : undefined))}
								>
									<ExternalIcon size={13} />
								</button>
							)}
						</div>
						{current.kind === "session" ? (
							<DiffView lines={current.change.lines} tooLarge={current.change.tooLarge} empty={emptyNote(current.change.status)} />
						) : gitDiff?.error ? (
							<p className="diff-note">{gitDiff.error}</p>
						) : gitDiff?.diff ? (
							<DiffView lines={gitDiff.diff.lines} tooLarge={gitDiff.diff.tooLarge} empty={emptyNote(current.file.status, gitDiff.diff.binary)} />
						) : null}
					</div>
				</>
			)}
			{changes.length > 0 && (
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
				</div>
			)}
		</>
	);
}

const VIEW_ICONS: Record<CodeView, (size: number) => ReactNode> = {
	session: (size) => <FileIcon size={size} />,
	preview: (size) => <EyeIcon size={size} />,
	services: (size) => <ServerIcon size={size} />,
};

const VIEW_NAMES: Record<CodeView, string> = { session: "Changes", preview: "Preview", services: "Services" };

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
 * this session edited beside the repository's other uncommitted changes, the services its commands left running,
 * and each file open to read in a tab of its own. The summary cards open them.
 */
export function ChangesPanel({ view }: { view: SessionView }) {
	const git = useStore((s) => s.git[view.path]);
	const picked = useStore((s) => s.panelTab[view.path]);
	const tabs = useStore((s) => s.panelTabs[view.path]);
	const previews = useStore((s) => s.previews[view.path]);
	const views = codeViews(tabs);
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
			) : (
				<ChangesBody view={view} git={git} />
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
