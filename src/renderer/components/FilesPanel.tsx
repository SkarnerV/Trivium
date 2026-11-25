import { type ReactElement, useEffect, useMemo, useState } from "react";
import type { GitDiff, GitFile, GitStatus, ProjectFile, ProjectTree, SessionView } from "../../shared/protocol.ts";
import { t } from "../i18n.tsx";
import { Chevron, ExternalIcon, FileIcon, FolderIcon, FolderOpenIcon } from "../icons.tsx";
import { attempt, errorText, setState, trivium } from "../store.ts";
import { changeMarks, ContentPane, FileText, type PaneMode, SplitView } from "./ContentPane.tsx";
import { DiffView } from "./DiffView.tsx";
import { emptyNote } from "./FileRow.tsx";
import { pathKey } from "./SourceControl.tsx";

/** Most matches a filter lists. */
const MAX_MATCHES = 300;

interface Folder {
	name: string;
	path: string;
	folders: Map<string, Folder>;
	files: string[];
	/** Git ignores it; it is listed but not read into. */
	ignored?: boolean;
}

/** The files as folders, each folder's subfolders before its files, both by name as a file manager sorts them. */
function buildTree(tree: ProjectTree): Folder {
	const root: Folder = { name: "", path: "", folders: new Map(), files: [] };
	const folderAt = (parts: string[]) => {
		let folder = root;
		for (const part of parts) {
			let next = folder.folders.get(part);
			if (!next) {
				next = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [] };
				folder.folders.set(part, next);
			}
			folder = next;
		}
		return folder;
	};
	for (const rel of tree.files) {
		const parts = rel.split("/");
		folderAt(parts.slice(0, -1)).files.push(rel);
	}
	for (const rel of tree.ignored) {
		const isFolder = rel.endsWith("/");
		const parts = rel.replace(/\/$/, "").split("/");
		if (isFolder) folderAt(parts).ignored = true;
		else folderAt(parts.slice(0, -1)).files.push(rel);
	}
	return root;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/** Which of git's statuses a file shows when it has more than one: a conflict first, then a change, then a new file. */
const RANK: GitFile["status"][] = ["conflicted", "deleted", "modified", "renamed", "copied", "typechange", "added", "untracked"];
const LETTER: Partial<Record<GitFile["status"], string>> = { conflicted: "!", deleted: "D", modified: "M", renamed: "R", copied: "C", typechange: "T", added: "A", untracked: "U" };

/**
 * The Code panel's Files tab: every file in the session's project as a tree, with git's status on changed files and
 * a dot on folders that hold some, a filter by name, and the picked file below the tree, in the same tab.
 */
export function FilesBody({ view, git }: { view: SessionView; git: GitStatus | null | undefined }) {
	const [ignored, setIgnored] = useState(false);
	const [tree, setTree] = useState<ProjectTree>();
	const [error, setError] = useState<string>();
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const [picked, setPicked] = useState<string>();
	const [mode, setMode] = useState<PaneMode>("file");
	const [shown, setShown] = useState<{ key: string; file?: ProjectFile; diff?: GitDiff; error?: string }>();

	// Listed again when git sees new changes or the session's edits change, so new files show up.
	const version = `${JSON.stringify(git?.files.map((file) => file.rel))}:${view.changes.length}`;
	useEffect(() => {
		let live = true;
		trivium.projectFiles(view.path, ignored).then(
			(next) => {
				if (!live) return;
				setTree(next);
				setError(undefined);
			},
			(reason: unknown) => live && setError(errorText(reason)),
		);
		return () => {
			live = false;
		};
	}, [view.path, ignored, version]);

	const root = useMemo(() => (tree ? buildTree(tree) : undefined), [tree]);

	// Git's status by the file's path from the project folder; git's own paths are from the repository's top folder.
	const cwd = pathKey(view.cwd).replace(/\/$/, "");
	const statusOf = useMemo(() => {
		const map = new Map<string, GitFile>();
		for (const file of git?.files ?? []) {
			const key = pathKey(file.path);
			if (!key.startsWith(`${cwd}/`)) continue;
			const rel = file.path.replaceAll("\\", "/").slice(cwd.length + 1);
			const before = map.get(rel);
			if (!before || RANK.indexOf(file.status) < RANK.indexOf(before.status)) map.set(rel, file);
		}
		return map;
	}, [git, cwd]);
	const changedFolders = useMemo(() => {
		const folders = new Set<string>();
		for (const rel of statusOf.keys()) {
			const parts = rel.split("/");
			for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
		}
		return folders;
	}, [statusOf]);

	const status = picked ? statusOf.get(picked) : undefined;
	const hasChanges = Boolean(status && status.status !== "deleted");
	const shownMode = hasChanges ? mode : "file";
	const key = picked ? `${picked}:${shownMode}:${status?.area}` : "";
	useEffect(() => {
		if (!picked) return;
		let live = true;
		const load = async () => {
			const diff = status ? await trivium.gitDiff(view.path, { rel: status.rel, area: status.area }).catch(() => undefined) : undefined;
			if (shownMode === "changes") return { diff };
			return { diff, file: await trivium.projectFile(view.path, picked) };
		};
		load().then(
			(result) => live && setShown({ key, ...result }),
			(reason: unknown) => live && setShown({ key, error: errorText(reason) }),
		);
		return () => {
			live = false;
		};
	}, [view.path, key, git]);
	const content = shown?.key === key ? shown : undefined;

	const toggle = (path: string) =>
		setOpen((before) => {
			const next = new Set(before);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	const pick = (rel: string) => {
		setPicked(rel);
		setMode("file");
	};
	const mention = (rel: string) => setState((s) => ({ drafts: { ...s.drafts, [view.path]: { text: `@${rel} `, attachments: [], place: "after" } } }));
	const openInEditor = (rel: string) => void attempt(() => trivium.openInEditor(`${view.cwd}/${rel}`));

	const fileRow = (rel: string, depth: number, dir?: string, dim?: boolean) => {
		const change = statusOf.get(rel);
		const letter = change ? LETTER[change.status] : undefined;
		return (
			<div key={rel} role="treeitem" aria-selected={picked === rel} className={`tree-row${dim ? " is-ignored" : ""}`}>
				<button
					type="button"
					className={`tree-item${change ? ` is-${change.status}` : ""}`}
					style={{ paddingLeft: 8 + depth * 14 }}
					title={rel}
					onClick={() => !dim && pick(rel)}
				>
					<span className="tree-chevron" />
					<FileIcon size={13} />
					<span className="tree-name ellipsis">{baseOf(rel)}</span>
					{dir !== undefined && <span className="tree-dir ellipsis">{dir}</span>}
				</button>
				{letter && <span className={`tree-status is-${change!.status}`}>{letter}</span>}
				{!dim && (
					<span className="tree-actions">
						<button type="button" className="icon-btn sc-action" aria-label={t("Open in VS Code")} title={t("Open in VS Code")} onClick={() => openInEditor(rel)}>
							<ExternalIcon size={12} />
						</button>
						<button type="button" className="icon-btn sc-action" aria-label={t("Mention {file} in the message", { file: baseOf(rel) })} title={t("Mention in the message (@)")} onClick={() => mention(rel)}>
							@
						</button>
					</span>
				)}
			</div>
		);
	};

	const folderRows = (folder: Folder, depth: number, dim: boolean): ReactElement[] => {
		const rows: ReactElement[] = [];
		for (const child of [...folder.folders.values()].sort((a, b) => byName(a.name, b.name))) {
			const faint = dim || Boolean(child.ignored);
			const expanded = open.has(child.path);
			const empty = !child.folders.size && !child.files.length;
			rows.push(
				<div key={`d:${child.path}`} role="treeitem" aria-expanded={empty ? undefined : expanded} aria-selected={false} className={`tree-row${faint ? " is-ignored" : ""}`}>
					<button type="button" className="tree-item" style={{ paddingLeft: 8 + depth * 14 }} title={child.path} disabled={empty} onClick={() => toggle(child.path)}>
						<span className="tree-chevron">{!empty && <Chevron open={expanded} size={10} />}</span>
						{expanded ? <FolderOpenIcon size={13} /> : <FolderIcon size={13} />}
						<span className="tree-name ellipsis">{child.name}</span>
					</button>
					{!faint && changedFolders.has(child.path) && <span className="tree-dot" title={t("Has changes inside")} />}
				</div>,
			);
			if (expanded) rows.push(...folderRows(child, depth + 1, faint));
		}
		for (const rel of [...folder.files].sort((a, b) => byName(baseOf(a), baseOf(b)))) rows.push(fileRow(rel, depth, undefined, dim));
		return rows;
	};

	const q = query.trim().toLowerCase();
	const matches = q && tree ? tree.files.filter((rel) => baseOf(rel).toLowerCase().includes(q)) : [];
	const fileCount = tree?.files.length ?? 0;
	const summary = q
		? t(matches.length === 1 ? "1 match" : "{n} matches", { n: matches.length })
		: tree
			? t("{files} · {changed} changed", { files: t(fileCount === 1 ? "1 file" : "{n} files", { n: fileCount }), changed: statusOf.size })
			: "";

	const list = (
		<>
			<div className="files-head">
				<span className="files-summary ellipsis">{summary}</span>
				{tree?.git && (
					<button type="button" className="sc-ghost files-toggle" aria-pressed={ignored} title={t("Show files git ignores, such as node_modules")} onClick={() => setIgnored(!ignored)}>
						{t("Ignored")}
					</button>
				)}
				<button type="button" className="icon-btn sc-action" aria-label={t("Collapse all folders")} title={t("Collapse all")} onClick={() => setOpen(new Set())}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="m7 4 5 5 5-5M7 20l5-5 5 5" />
					</svg>
				</button>
			</div>
			<div className="files-filter">
				<label className="sr-only" htmlFor={`files-${view.path}`}>
					{t("Filter files")}
				</label>
				<input id={`files-${view.path}`} value={query} placeholder={t("Filter files by name")} onChange={(event) => setQuery(event.target.value)} />
			</div>
			<div role="tree" aria-label={t("Files")} className="files-tree">
				{error ? (
					<p className="sc-empty">{error}</p>
				) : q ? (
					<>
						{matches.slice(0, MAX_MATCHES).map((rel) => fileRow(rel, 0, dirOf(rel)))}
						{!matches.length && <p className="sc-empty">{t("No file names match “{query}”.", { query })}</p>}
						{matches.length > MAX_MATCHES && <p className="sc-empty">{t("Showing the first {n} matches.", { n: MAX_MATCHES })}</p>}
					</>
				) : root ? (
					<>
						{folderRows(root, 0, false)}
						{!fileCount && <p className="sc-empty">{t("This folder has no files yet.")}</p>}
						{tree?.truncated && <p className="sc-empty">{t("Showing the first {n} files.", { n: fileCount })}</p>}
					</>
				) : null}
			</div>
		</>
	);

	const pane = picked && (
		<ContentPane
			name={baseOf(picked)}
			dir={dirOf(picked)}
			title={picked}
			meta={status && <span className={`tree-status is-${status.status}`}>{LETTER[status.status]}</span>}
			modes={hasChanges ? ["file", "changes"] : undefined}
			mode={shownMode}
			onMode={setMode}
			onClose={() => setPicked(undefined)}
			actions={
				<>
					<button type="button" className="icon-btn sc-action" aria-label={t("Mention {file} in the message", { file: baseOf(picked) })} title={t("Mention in the message (@)")} onClick={() => mention(picked)}>
						@
					</button>
					<button type="button" className="icon-btn sc-action" aria-label={t("Open in VS Code")} title={t("Open in VS Code")} onClick={() => openInEditor(picked)}>
						<ExternalIcon size={13} />
					</button>
				</>
			}
		>
			{content?.error ? (
				<p className="diff-note">{content.error}</p>
			) : shownMode === "changes" && content?.diff ? (
				<DiffView lines={content.diff.lines} tooLarge={content.diff.tooLarge} empty={emptyNote(status!.status, content.diff.binary)} />
			) : shownMode === "file" && content?.file ? (
				<FileText file={content.file} marks={changeMarks(content.diff?.lines)} />
			) : null}
		</ContentPane>
	);

	return (
		<div className="sc-body">
			<SplitView label={t("Files")} list={list} pane={pane || undefined} />
		</div>
	);
}
