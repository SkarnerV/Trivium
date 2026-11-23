import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FileChange, GitAction, GitArea, GitCommitFile, GitDiff, GitFile, GitHistoryCommit, GitStatus, ProjectFile, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { t } from "../i18n.tsx";
import { BranchIcon, Chevron, CheckIcon, CloudDownIcon, CloudUpIcon, ExternalIcon, MinusIcon, MoreIcon, PlusIcon, UndoIcon } from "../icons.tsx";
import { IS_WINDOWS } from "../platform.ts";
import { askConfirm, attempt, errorText, setState, trivium } from "../store.ts";
import { changeMarks, ContentPane, FileText, type PaneMode, SplitView } from "./ContentPane.tsx";
import { ContextMenu, type MenuEntry } from "./ContextMenu.tsx";
import { DiffView } from "./DiffView.tsx";
import { dirName, emptyNote, FileRow } from "./FileRow.tsx";
import { HistorySection } from "./HistoryPanel.tsx";

/** A path to compare by: git and the session's records may write the same Windows path with other slashes or case. */
export function pathKey(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	return IS_WINDOWS ? slashed.toLowerCase() : slashed;
}

/** The branch as the panel shows it: its name, or the commit a detached HEAD is at. */
export function branchLabel(git: GitStatus): string {
	return git.branch ?? (git.head ? t("detached at {commit}", { commit: git.head }) : t("detached"));
}

/** How many files git has changed, counting a file staged and changed again once. */
export function changedCount(git: GitStatus | null | undefined): number {
	return new Set(git?.files.map((file) => file.rel)).size;
}

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

/** What is open in the pane below the lists: a changed file, a file of a commit, or one of this session's edits outside a repository. */
type Picked =
	| { kind: "file"; rel: string; area: GitArea }
	| { kind: "commit"; id: string; short: string; file: GitCommitFile }
	| { kind: "session"; path: string };

/** A file's row in a group, with its actions beside it, shown while the row is hovered or focused. */
function Row({ file, current, counts, onSelect, actions }: { file: GitFile; current: boolean; counts?: FileChange; onSelect: () => void; actions: ReactNode }) {
	return (
		<div className="sc-row">
			<FileRow status={file.status} rel={file.rel} title={file.from ? `${file.from} → ${file.rel}` : file.rel} current={current} onSelect={onSelect}>
				{counts && counts.adds > 0 && <span className="plus">+{counts.adds}</span>}
				{counts && counts.dels > 0 && <span className="minus">−{counts.dels}</span>}
			</FileRow>
			<span className="sc-row-actions">{actions}</span>
		</div>
	);
}

function Group({ label, count, tone, actions, children }: { label: string; count: number; tone?: "conflict"; actions?: ReactNode; children: ReactNode }) {
	const [folded, setFolded] = useState(false);
	return (
		<section className="sc-group" aria-label={label}>
			<div className={`sc-section-head${tone ? ` is-${tone}` : ""}`}>
				<button type="button" className="sc-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
					<Chevron open={!folded} size={10} />
					<span>{label}</span>
					<span className="sc-count">{count}</span>
				</button>
				{actions && <span className="sc-section-actions">{actions}</span>}
			</div>
			{!folded && children}
		</section>
	);
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
	return (
		<button type="button" className="icon-btn sc-action" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	);
}

/** Loads what the pane shows for a pick, again whenever git is read again, since the file may have changed. */
function usePaneContent(view: SessionView, git: GitStatus | null | undefined, picked: Picked | undefined, mode: PaneMode) {
	const [shown, setShown] = useState<{ key: string; diff?: GitDiff; file?: ProjectFile; error?: string }>();
	const key = picked ? `${JSON.stringify(picked)}:${mode}` : "";
	useEffect(() => {
		if (!picked || picked.kind === "session") return;
		let live = true;
		const load = async () => {
			if (picked.kind === "commit") {
				return mode === "file" ? { file: await trivium.gitFileAt(view.path, picked.id, picked.file.rel) } : { diff: await trivium.gitCommitDiff(view.path, picked.id, picked.file) };
			}
			const listed = git?.files.find((file) => file.rel === picked.rel && file.area === picked.area);
			const diff = await trivium.gitDiff(view.path, { rel: picked.rel, area: picked.area });
			if (mode === "changes" || !listed) return { diff };
			return { diff, file: await trivium.projectFile(view.path, listed.path) };
		};
		load().then(
			(result) => live && setShown({ key, ...result }),
			(error: unknown) => live && setShown({ key, error: errorText(error) }),
		);
		return () => {
			live = false;
		};
	}, [view.path, key, git]);
	return shown?.key === key ? shown : undefined;
}

/**
 * The Code panel's Source Control tab, as VS Code has it: the branch and its sync, a commit message box, the staged
 * and unstaged files, and every branch's history. A picked file's diff opens below the lists, in the same tab.
 * Outside a repository it lists this session's edits to review or revert, and offers to make one.
 */
export function SourceControlBody({ view, git }: { view: SessionView; git: GitStatus | null | undefined }) {
	const [picked, setPicked] = useState<Picked>();
	const [mode, setMode] = useState<PaneMode>("changes");
	const [busy, setBusy] = useState<string>();
	const [message, setMessage] = useState("");
	const [linkSession, setLinkSession] = useState(true);
	const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] }>();
	const closed = useRef(0);
	const shown = usePaneContent(view, git, picked, mode);

	const pick = (next: Picked) => {
		setPicked(next);
		setMode("changes");
	};

	const run = async (label: string, action: GitAction): Promise<boolean> => {
		setBusy(label);
		const next = await attempt(() => trivium.gitAction(view.path, action));
		setBusy(undefined);
		if (next === undefined) return false;
		setState((s) => ({ git: { ...s.git, [view.path]: next } }));
		return true;
	};

	const openMenu = (button: HTMLElement, entries: MenuEntry[]) => {
		if (Date.now() - closed.current < 300) return;
		const rect = button.getBoundingClientRect();
		setMenu({ x: rect.right, y: rect.bottom + 6, entries });
	};

	if (git === undefined) return <div className="sc-body" />;
	if (git === null) return <NoRepository view={view} picked={picked?.kind === "session" ? picked.path : undefined} onPick={(path) => pick({ kind: "session", path })} onClose={() => setPicked(undefined)} onInit={() => void run(t("Initializing"), { kind: "init" })} busy={Boolean(busy)} />;

	const files = git.files;
	const conflicts = files.filter((file) => file.area === "conflicted");
	const staged = files.filter((file) => file.area === "staged");
	const changes = files.filter((file) => file.area === "unstaged" || file.area === "untracked");
	const counts = new Map(view.changes.map((change) => [pathKey(change.path), change]));
	const isCurrent = (file: GitFile) => picked?.kind === "file" && picked.rel === file.rel && picked.area === file.area;
	const current = picked?.kind === "file" ? files.find((file) => file.rel === picked.rel && file.area === picked.area) : undefined;
	// A file committed, staged or reverted since it was picked has left its group, and the pane closes with it.
	const open = picked?.kind === "commit" ? picked : current ? picked : undefined;

	const discard = async (list: GitFile[]) => {
		const ok = await askConfirm({
			title: list.length === 1 ? t("Discard changes to {file}?", { file: baseName(list[0]!.rel) }) : t("Discard {n} files' changes?", { n: list.length }),
			message: list.some((file) => file.area === "untracked")
				? t("Changes that aren't staged are lost, and new files are deleted. This can't be undone.")
				: t("Changes that aren't staged are lost. This can't be undone."),
			confirmLabel: t("Discard"),
		});
		if (ok) await run(t("Discarding"), { kind: "discard", files: list.map(({ rel, area }) => ({ rel, area })) });
	};
	const stage = (list: GitFile[]) => run(t("Staging"), { kind: "stage", files: list.map(({ rel, area }) => ({ rel, area })) });
	const unstage = (list: GitFile[]) => run(t("Unstaging"), { kind: "unstage", files: list.map(({ rel, area }) => ({ rel, area })) });
	const openFile = (file: GitFile) => void attempt(() => trivium.openInEditor(file.path));

	const nothing = !files.length;
	const commit = async (options: { amend?: boolean; push?: boolean } = {}) => {
		if (!message.trim() && !options.amend) return;
		const ok = await run(options.push ? t("Committing and pushing") : t("Committing"), {
			kind: "commit",
			message,
			all: !staged.length && !options.amend,
			amend: options.amend,
			push: options.push,
			linkSession,
		});
		if (ok) setMessage("");
	};
	const draft = async () => {
		setBusy(t("Drafting"));
		const text = await attempt(() => trivium.gitDraftMessage(view.path));
		setBusy(undefined);
		if (text) setMessage(text);
	};

	const commitMenu: MenuEntry[] = [
		{ label: t("Commit and push"), disabled: nothing || !message.trim(), onSelect: () => void commit({ push: true }) },
		{ label: t("Amend last commit"), disabled: !git.head, onSelect: () => void commit({ amend: true }) },
		{ label: t("Undo last commit"), disabled: !git.head, onSelect: () => void run(t("Undoing"), { kind: "undoCommit" }) },
		"separator",
		{ label: t("Link this session in commits"), checked: linkSession, onSelect: () => setLinkSession(!linkSession) },
	];
	const syncMenu: MenuEntry[] = [
		{ label: t("Pull"), disabled: !git.upstream, onSelect: () => void run(t("Pulling"), { kind: "pull" }) },
		{ label: t("Push"), disabled: !git.branch, onSelect: () => void run(t("Pushing"), { kind: "push" }) },
		{ label: t("Fetch"), onSelect: () => void run(t("Fetching"), { kind: "fetch" }) },
	];

	const list = (
		<>
			<div className="sc-commit">
				<label className="sr-only" htmlFor={`commit-${view.path}`}>
					{t("Commit message")}
				</label>
				<textarea
					id={`commit-${view.path}`}
					className="sc-message"
					rows={2}
					value={message}
					placeholder={git.branch ? t("Message (Ctrl+Enter to commit on {branch})", { branch: git.branch }) : t("Message (Ctrl+Enter to commit)")}
					onChange={(event) => setMessage(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							void commit();
						}
					}}
				/>
				<div className="sc-commit-bar">
					<button type="button" className="sc-ghost is-accent" disabled={nothing || Boolean(busy)} title={t("Draft a message from the staged changes and this session")} onClick={() => void draft()}>
						{busy === t("Drafting") ? t("Drafting…") : t("Draft message")}
					</button>
					<span className="sc-busy">{busy && busy !== t("Drafting") ? `${busy}…` : ""}</span>
					<span className="sc-split">
						<button type="button" className="sc-primary" disabled={nothing || !message.trim() || Boolean(busy)} onClick={() => void commit()}>
							<CheckIcon size={13} width={2.4} />
							{staged.length ? t("Commit {n}", { n: staged.length }) : t("Commit all")}
						</button>
						<button
							type="button"
							className="sc-primary sc-more"
							aria-label={t("More commit actions")}
							title={t("More commit actions")}
							disabled={Boolean(busy)}
							onClick={(event) => openMenu(event.currentTarget, commitMenu)}
						>
							<Chevron open size={10} />
						</button>
					</span>
				</div>
				{view.running && !nothing && <p className="sc-note">{t("The agent is still working, so a commit now may take half-done edits.")}</p>}
			</div>
			{conflicts.length > 0 && (
				<Group label={t("Merge conflicts")} count={conflicts.length} tone="conflict">
					{conflicts.map((file) => (
						<Row
							key={`${file.area}:${file.rel}`}
							file={file}
							current={isCurrent(file)}
							onSelect={() => pick({ kind: "file", rel: file.rel, area: file.area })}
							actions={
								<>
									<IconAction label={t("Open in VS Code")} onClick={() => openFile(file)}>
										<ExternalIcon size={12} />
									</IconAction>
									<IconAction label={t("Mark as resolved")} disabled={Boolean(busy)} onClick={() => void stage([file])}>
										<PlusIcon size={13} />
									</IconAction>
								</>
							}
						/>
					))}
				</Group>
			)}
			{staged.length > 0 && (
				<Group
					label={t("Staged")}
					count={staged.length}
					actions={
						<IconAction label={t("Unstage all")} disabled={Boolean(busy)} onClick={() => void unstage(staged)}>
							<MinusIcon size={13} />
						</IconAction>
					}
				>
					{staged.map((file) => (
						<Row
							key={`${file.area}:${file.rel}`}
							file={file}
							current={isCurrent(file)}
							counts={counts.get(pathKey(file.path))}
							onSelect={() => pick({ kind: "file", rel: file.rel, area: file.area })}
							actions={
								<>
									{file.status !== "deleted" && (
										<IconAction label={t("Open in VS Code")} onClick={() => openFile(file)}>
											<ExternalIcon size={12} />
										</IconAction>
									)}
									<IconAction label={t("Unstage")} disabled={Boolean(busy)} onClick={() => void unstage([file])}>
										<MinusIcon size={13} />
									</IconAction>
								</>
							}
						/>
					))}
				</Group>
			)}
			<Group
				label={t("Changes")}
				count={changes.length}
				actions={
					changes.length > 0 && (
						<>
							<IconAction label={t("Discard all changes")} disabled={Boolean(busy) || view.running} onClick={() => void discard(changes)}>
								<UndoIcon size={12} />
							</IconAction>
							<IconAction label={t("Stage all changes")} disabled={Boolean(busy)} onClick={() => void stage(changes)}>
								<PlusIcon size={13} />
							</IconAction>
						</>
					)
				}
			>
				{changes.map((file) => (
					<Row
						key={`${file.area}:${file.rel}`}
						file={file}
						current={isCurrent(file)}
						counts={counts.get(pathKey(file.path))}
						onSelect={() => pick({ kind: "file", rel: file.rel, area: file.area })}
						actions={
							<>
								{file.status !== "deleted" && (
									<IconAction label={t("Open in VS Code")} onClick={() => openFile(file)}>
										<ExternalIcon size={12} />
									</IconAction>
								)}
								<IconAction label={view.running ? t("Stop the run before discarding") : t("Discard changes")} disabled={Boolean(busy) || view.running} onClick={() => void discard([file])}>
									<UndoIcon size={12} />
								</IconAction>
								<IconAction label={t("Stage")} disabled={Boolean(busy)} onClick={() => void stage([file])}>
									<PlusIcon size={13} />
								</IconAction>
							</>
						}
					/>
				))}
				{!changes.length && <p className="sc-empty">{nothing ? t("Nothing to commit. The working tree matches the last commit.") : t("Everything is staged.")}</p>}
				{git.truncated && <p className="sc-empty">{t("Showing the first {n} changes.", { n: files.length })}</p>}
			</Group>
			<HistorySection
				view={view}
				git={git}
				picked={picked?.kind === "commit" ? { id: picked.id, rel: picked.file.rel } : undefined}
				onPick={(commit: GitHistoryCommit, file) => pick({ kind: "commit", id: commit.id, short: commit.id.slice(0, 7), file })}
			/>
		</>
	);

	let pane: ReactNode;
	if (open?.kind === "file" && current) {
		const hasFile = current.status !== "deleted";
		const shownMode = hasFile ? mode : "changes";
		const diff = shown?.diff;
		pane = (
			<ContentPane
				name={baseName(current.rel)}
				dir={dirName(current.rel)}
				title={current.rel}
				meta={diff && (diff.adds > 0 || diff.dels > 0) && (
					<span className="mono">
						<span className="plus">+{diff.adds}</span> <span className="minus">−{diff.dels}</span>
					</span>
				)}
				modes={hasFile ? ["changes", "file"] : undefined}
				mode={shownMode}
				onMode={setMode}
				onClose={() => setPicked(undefined)}
				actions={
					<>
						{hasFile && (
							<IconAction label={t("Open in VS Code")} onClick={() => openFile(current)}>
								<ExternalIcon size={13} />
							</IconAction>
						)}
						{current.area === "staged" ? (
							<button type="button" className="sc-ghost is-accent" disabled={Boolean(busy)} onClick={() => void unstage([current])}>
								{t("Unstage")}
							</button>
						) : (
							<button type="button" className="sc-ghost is-accent" disabled={Boolean(busy)} onClick={() => void stage([current])}>
								{current.area === "conflicted" ? t("Mark as resolved") : t("Stage")}
							</button>
						)}
					</>
				}
			>
				{shown?.error ? (
					<p className="diff-note">{shown.error}</p>
				) : shownMode === "file" && shown?.file ? (
					<FileText file={shown.file} marks={changeMarks(shown.diff?.lines)} />
				) : shownMode === "changes" && diff ? (
					<DiffView lines={diff.lines} tooLarge={diff.tooLarge} empty={emptyNote(current.status, diff.binary)} />
				) : null}
			</ContentPane>
		);
	} else if (open?.kind === "commit") {
		const { file } = open;
		const hasFile = file.status !== "deleted";
		const shownMode = hasFile ? mode : "changes";
		pane = (
			<ContentPane
				name={baseName(file.rel)}
				dir={dirName(file.rel)}
				title={file.from ? `${file.from} → ${file.rel}` : file.rel}
				meta={
					<>
						{t("in {commit}", { commit: open.short })}{" "}
						{(file.adds > 0 || file.dels > 0) && (
							<span className="mono">
								<span className="plus">+{file.adds}</span> <span className="minus">−{file.dels}</span>
							</span>
						)}
					</>
				}
				modes={hasFile ? ["changes", "file"] : undefined}
				mode={shownMode}
				onMode={setMode}
				onClose={() => setPicked(undefined)}
			>
				{shown?.error ? (
					<p className="diff-note">{shown.error}</p>
				) : shownMode === "file" && shown?.file ? (
					<FileText file={shown.file} />
				) : shownMode === "changes" && shown?.diff ? (
					<DiffView lines={shown.diff.lines} tooLarge={shown.diff.tooLarge} empty={emptyNote(file.status, shown.diff.binary)} />
				) : null}
			</ContentPane>
		);
	}

	return (
		<div className="sc-body">
			<div className="sc-branch" title={git.root}>
				<BranchIcon size={13} />
				<span className="mono ellipsis">{branchLabel(git)}</span>
				{git.upstream && <span className="sc-upstream mono ellipsis">{git.upstream}</span>}
				<span className="sc-spacer" />
				{git.behind > 0 && (
					<button type="button" className="sc-ghost" disabled={Boolean(busy)} title={t("Pull the upstream's commits")} onClick={() => void run(t("Pulling"), { kind: "pull" })}>
						<CloudDownIcon size={13} />
						{t("Pull {n}", { n: git.behind })}
					</button>
				)}
				{(git.ahead > 0 || (!git.upstream && git.branch && git.head)) && (
					<button type="button" className="sc-ghost is-accent" disabled={Boolean(busy)} title={git.upstream ? t("Push this branch's commits") : t("Publish this branch to the remote")} onClick={() => void run(t("Pushing"), { kind: "push" })}>
						<CloudUpIcon size={13} />
						{git.upstream ? t("Push {n}", { n: git.ahead }) : t("Publish")}
					</button>
				)}
				<button type="button" className="icon-btn sc-action" aria-label={t("More git actions")} title={t("Pull, push and fetch")} disabled={Boolean(busy)} onClick={(event) => openMenu(event.currentTarget, syncMenu)}>
					<MoreIcon size={15} />
				</button>
			</div>
			<SplitView label={t("Source Control")} list={list} pane={pane} />
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					align="right"
					label={t("More")}
					entries={menu.entries}
					onClose={() => {
						closed.current = Date.now();
						setMenu(undefined);
					}}
				/>
			)}
		</div>
	);
}

/** Outside a repository: this session's edits, each with its diff and a revert, and a way to make the folder a repository. */
function NoRepository({ view, picked, onPick, onClose, onInit, busy }: {
	view: SessionView;
	picked: string | undefined;
	onPick: (path: string) => void;
	onClose: () => void;
	onInit: () => void;
	busy: boolean;
}) {
	const [reverting, setReverting] = useState(false);
	const change = view.changes.find((each) => each.path === picked);
	const revert = async (target: FileChange) => {
		const file = baseName(target.rel);
		const ok = await askConfirm({
			title: t("Revert {files}?", { files: file }),
			message: t(target.status === "added" ? "This session created {file}, so reverting deletes it." : "{file} goes back to how it was before this session changed it.", { file }),
			confirmLabel: t("Revert"),
		});
		if (!ok) return;
		setReverting(true);
		const next = await attempt(() => trivium.revertChanges(view.path, [target.path]));
		setReverting(false);
		if (next) {
			setState((s) => {
				const latest = s.views[view.path];
				return latest ? { views: { ...s.views, [view.path]: { ...latest, changes: next } } } : {};
			});
		}
	};
	const list = (
		<>
			<div className="sc-norepo">
				<p>{t("This folder has no git repository. This session's edits still show here, each with its diff, and each can be reverted.")}</p>
				<button type="button" className="sc-ghost is-outline" disabled={busy} onClick={onInit}>
					{t("Initialize repository")}
				</button>
			</div>
			{view.changes.length > 0 && (
				<Group label={t("This session")} count={view.changes.length}>
					{view.changes.map((each) => (
						<div key={each.path} className="sc-row">
							<FileRow status={each.status} rel={each.rel} current={each.path === picked} onSelect={() => onPick(each.path)}>
								{each.adds > 0 && <span className="plus">+{each.adds}</span>}
								{each.dels > 0 && <span className="minus">−{each.dels}</span>}
							</FileRow>
							<span className="sc-row-actions">
								<IconAction label={view.running ? t("Stop the run before reverting") : t("Revert this file")} disabled={reverting || view.running} onClick={() => void revert(each)}>
									<UndoIcon size={12} />
								</IconAction>
							</span>
						</div>
					))}
				</Group>
			)}
		</>
	);
	const pane = change && (
		<ContentPane
			name={baseName(change.rel)}
			dir={dirName(change.rel)}
			title={change.rel}
			meta={<ChangeCount changes={[change]} />}
			onClose={onClose}
			actions={
				<button type="button" className="sc-ghost" disabled={reverting || view.running} onClick={() => void revert(change)}>
					{t("Revert")}
				</button>
			}
		>
			<DiffView lines={change.lines} tooLarge={change.tooLarge} empty={emptyNote(change.status, change.binary)} />
		</ContentPane>
	);
	return (
		<div className="sc-body">
			<SplitView label={t("Source Control")} list={list} pane={pane} />
		</div>
	);
}
