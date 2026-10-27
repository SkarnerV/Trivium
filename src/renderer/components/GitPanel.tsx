import { useEffect, useState } from "react";
import type { GitArea, GitDiff, GitFile, GitStatus, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { BranchIcon, Chevron, ExternalIcon, EyeIcon } from "../icons.tsx";
import { attempt, errorText, openPreview, trivium } from "../store.ts";
import { transition } from "../transition.ts";
import { DiffView } from "./DiffView.tsx";

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
const AREAS: { area: GitArea; label: string }[] = [
	{ area: "conflicted", label: "Conflicts" },
	{ area: "staged", label: "Staged" },
	{ area: "unstaged", label: "Changes" },
	{ area: "untracked", label: "Untracked" },
];

const keyOf = (file: GitFile) => `${file.area}:${file.rel}`;

/** Changed files, counting a file that is both staged and changed again once. */
export function gitFileCount(git: GitStatus): number {
	return new Set(git.files.map((file) => file.rel)).size;
}

/** The branch as the header shows it: its name, or the commit a detached HEAD is at. */
export function branchLabel(git: GitStatus): string {
	return git.branch ?? (git.head ? `detached at ${git.head}` : "detached");
}

function dirName(rel: string): string {
	const slash = rel.lastIndexOf("/");
	return slash > 0 ? rel.slice(0, slash) : "";
}

function emptyNote(file: GitFile, diff: GitDiff): string {
	if (diff.binary) return "Binary file.";
	if (file.status === "deleted") return "File deleted.";
	if (file.status === "renamed" || file.status === "copied" || file.status === "typechange") return "No changes to the content.";
	return "Empty file.";
}

/** The Code panel's Git tab: the branch, the working tree's changes by area, and the selected file's diff. */
export function GitChanges({ view, git }: { view: SessionView; git: GitStatus }) {
	const [selected, setSelected] = useState<string>();
	const [folded, setFolded] = useState<Partial<Record<GitArea, boolean>>>({});
	const [shown, setShown] = useState<{ key: string; diff?: GitDiff; error?: string }>();
	const current = git.files.find((file) => keyOf(file) === selected) ?? git.files[0];
	const key = current ? keyOf(current) : "";

	useEffect(() => {
		if (!current) return;
		let live = true;
		trivium.gitDiff(view.path, { rel: current.rel, area: current.area }).then(
			(diff) => live && setShown({ key, diff }),
			(error: unknown) => live && setShown({ key, error: errorText(error) }),
		);
		return () => {
			live = false;
		};
		// A new status object means git was read again, and the file may have changed since.
	}, [view.path, key, git]);

	const diff = shown?.key === key ? shown : undefined;
	return (
		<>
			<div className="git-branch" title={git.root}>
				<BranchIcon size={13} />
				<span className="mono ellipsis">{branchLabel(git)}</span>
				{git.upstream && <span className="git-upstream mono ellipsis">{git.upstream}</span>}
				{git.ahead > 0 && <span title={`${git.ahead} commits not pushed`}>↑{git.ahead}</span>}
				{git.behind > 0 && <span title={`${git.behind} commits not pulled`}>↓{git.behind}</span>}
			</div>
			{!current ? (
				<div className="side-body panel-empty">
					<h3>Nothing to commit</h3>
					<p>The working tree matches the last commit.</p>
				</div>
			) : (
				<>
					<div className="git-files">
						{AREAS.map(({ area, label }) => {
							const files = git.files.filter((file) => file.area === area);
							if (!files.length) return null;
							return (
								<section key={area} className="git-section">
									<button
										type="button"
										className="git-section-head"
										aria-expanded={!folded[area]}
										onClick={() => setFolded({ ...folded, [area]: !folded[area] })}
									>
										<Chevron open={!folded[area]} size={10} />
										<span>{label}</span>
										<span className="git-section-count">{files.length}</span>
									</button>
									{!folded[area] &&
										files.map((file) => (
											<button
												key={keyOf(file)}
												type="button"
												className="git-file"
												aria-current={file === current}
												title={file.from ? `${file.from} → ${file.rel}` : file.rel}
												onClick={() => transition("tab", () => setSelected(keyOf(file)))}
											>
												<span className={`git-mark is-${file.status}`} aria-label={file.status}>
													{MARK[file.status]}
												</span>
												<span className="git-name ellipsis">{baseName(file.rel)}</span>
												<span className="git-dir ellipsis">{dirName(file.rel)}</span>
											</button>
										))}
								</section>
							);
						})}
						{git.truncated && <p className="git-more">Showing the first {git.files.length} changes.</p>}
					</div>
					<div className="diff git-diff" role="region" aria-label={`Diff of ${current.rel}`}>
						<div className="diff-path git-diff-path">
							<span className="ellipsis">{current.from ? `${current.from} → ${current.rel}` : current.rel}</span>
							{diff?.diff && (diff.diff.adds > 0 || diff.diff.dels > 0) && (
								<span className="change-count">
									<span className="plus">+{diff.diff.adds}</span> <span className="minus">−{diff.diff.dels}</span>
								</span>
							)}
							{current.status !== "deleted" && (
								<button type="button" className="icon-btn" aria-label="Preview" title="Preview" onClick={() => void openPreview(view.path, current.path)}>
									<EyeIcon size={14} />
								</button>
							)}
							{current.status !== "deleted" && (
								<button
									type="button"
									className="icon-btn"
									aria-label="Open in editor"
									title="Open in VS Code"
									onClick={() => void attempt(() => trivium.openInEditor(current.path))}
								>
									<ExternalIcon size={13} />
								</button>
							)}
						</div>
						{diff?.error ? (
							<p className="diff-note">{diff.error}</p>
						) : diff?.diff ? (
							<DiffView lines={diff.diff.lines} tooLarge={diff.diff.tooLarge} empty={emptyNote(current, diff.diff)} />
						) : null}
					</div>
				</>
			)}
		</>
	);
}
