import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitArea, GitCommit, GitStatus, SessionView } from "../../shared/protocol.ts";
import { BranchIcon, CheckIcon, CloudDownIcon, CloudOffIcon, CloudUpIcon, CopyIcon } from "../icons.tsx";
import { attempt, setState, trivium } from "../store.ts";
import { t, tx } from "../i18n.tsx";

const EDGE = 8;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago". */
export function since(time: number, now = Date.now()): string {
	const minutes = Math.floor((now - time) / 60_000);
	if (minutes < 1) return t("just now");
	if (minutes < 60) return t("{n} min ago", { n: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("{n} h ago", { n: hours });
	const days = Math.floor(hours / 24);
	return days === 1 ? t("yesterday") : t("{n} days ago", { n: days });
}

const commits = (count: number) => t(count === 1 ? "{n} commit" : "{n} commits", { n: count });

/** Files in each area, each counted once. */
function areaCounts(git: GitStatus): Record<GitArea, number> {
	const counts: Record<GitArea, number> = { conflicted: 0, staged: 0, unstaged: 0, untracked: 0 };
	for (const file of git.files) counts[file.area]++;
	return counts;
}

const TILES: { area: GitArea; label: string }[] = [
	{ area: "conflicted", label: "in conflict" },
	{ area: "staged", label: "staged" },
	{ area: "unstaged", label: "changed" },
	{ area: "untracked", label: "untracked" },
];

/** What the header's branch says when hovered: the summary in one line. */
export function branchTitle(git: GitStatus, files: number): string {
	const parts = [
		git.branch ? t("On {branch}", { branch: git.branch }) : git.head ? t("Not on a branch, at {commit}", { commit: git.head }) : t("Not on a branch"),
	];
	if (files) parts.push(t(files === 1 ? "1 file changed" : "{n} files changed", { n: files }));
	if (git.ahead) parts.push(t("{commits} to push", { commits: commits(git.ahead) }));
	if (git.behind) parts.push(t("{commits} to pull", { commits: commits(git.behind) }));
	return parts.join(t(", "));
}

function Commits({ commits, total }: { commits: GitCommit[] | undefined; total: number }) {
	if (!commits?.length) return null;
	return (
		<ol className="bs-commits">
			{commits.map((commit) => (
				<li key={commit.id}>
					<span className="mono">{commit.id}</span>
					<span className="ellipsis" title={commit.subject}>
						{commit.subject}
					</span>
				</li>
			))}
			{total > commits.length && (
				<li className="bs-more">{t(total - commits.length === 1 ? "and 1 more commit" : "and {n} more commits", { n: total - commits.length })}</li>
			)}
		</ol>
	);
}

/** Where the branch stands against its remote, in words. */
function RemoteState({ git }: { git: GitStatus }) {
	if (!git.branch) {
		return (
			<>
				<p className="bs-line">
					<BranchIcon size={15} />
					<span>{git.head ? tx("Not on a branch. You're at {commit}.", { commit: <span className="mono">{git.head}</span> }) : t("Not on a branch.")}</span>
				</p>
				<p className="bs-note">{t("New commits here won't belong to a branch until you make one.")}</p>
			</>
		);
	}
	if (!git.upstream) {
		return (
			<p className="bs-line">
				<CloudOffIcon size={15} />
				<span>{tx("{branch} isn't on a remote yet. It only exists on your computer.", { branch: <span className="mono">{git.branch}</span> })}</span>
			</p>
		);
	}
	if (!git.ahead && !git.behind) {
		return (
			<p className="bs-line is-done">
				<CheckIcon size={15} width={2.2} />
				<span>{tx("Up to date with {upstream}", { upstream: <span className="mono">{git.upstream}</span> })}</span>
			</p>
		);
	}
	return (
		<>
			{git.ahead > 0 && (
				<>
					<p className="bs-line is-push">
						<CloudUpIcon size={15} />
						<span>{tx("{commits} not pushed yet", { commits: <strong>{commits(git.ahead)}</strong> })}</span>
					</p>
					<Commits commits={git.outgoing} total={git.ahead} />
				</>
			)}
			{git.behind > 0 && (
				<>
					<p className="bs-line is-pull">
						<CloudDownIcon size={15} />
						<span>{tx("{commits} on the remote you don't have", { commits: <strong>{commits(git.behind)}</strong> })}</span>
					</p>
					<Commits commits={git.incoming} total={git.behind} />
				</>
			)}
		</>
	);
}

/**
 * The branch summary under the header's branch button: its remote, the commits waiting each way, and what is
 * not committed. It closes on a click elsewhere, Escape, or the window losing focus.
 */
export function BranchSummary({ view, git, anchor, onClose }: { view: SessionView; git: GitStatus; anchor: HTMLElement; onClose: () => void }) {
	const root = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ top: number; left: number }>();

	useLayoutEffect(() => {
		const place = () => {
			const button = anchor.getBoundingClientRect();
			const width = root.current?.offsetWidth ?? 0;
			setPosition({ top: button.bottom + 6, left: Math.max(EDGE, Math.min(button.right - width, window.innerWidth - width - EDGE)) });
		};
		place();
		root.current?.focus();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [anchor]);

	useEffect(() => {
		// The branch button toggles the summary itself, so a press on it is not "elsewhere".
		const outside = (event: Event) => {
			const target = event.target as Node;
			if (!root.current?.contains(target) && !anchor.contains(target)) onClose();
		};
		const close = () => onClose();
		window.addEventListener("mousedown", outside, true);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("mousedown", outside, true);
			window.removeEventListener("blur", close);
		};
	}, [anchor, onClose]);

	const counts = areaCounts(git);
	const tiles = TILES.filter((tile) => counts[tile.area] > 0);
	const showGit = () => {
		onClose();
		setState((s) => ({
			changesHidden: { ...s.changesHidden, [view.path]: false },
			panelTab: { ...s.panelTab, [view.path]: "git" },
		}));
	};
	// Nothing runs until the user sends it.
	const askPush = () => {
		onClose();
		setState((s) => ({ drafts: { ...s.drafts, [view.path]: { text: t("Push {branch} to {upstream}.", { branch: git.branch ?? "", upstream: git.upstream ?? "" }), attachments: [] } } }));
	};

	return createPortal(
		<div
			ref={root}
			className="branch-summary"
			role="dialog"
			aria-label={t("Branch summary")}
			tabIndex={-1}
			style={position ?? { visibility: "hidden" }}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.stopPropagation();
				onClose();
				anchor.focus();
			}}
		>
			<section className="bs-head">
				<div className="bs-name">
					<BranchIcon size={15} />
					<span className="mono ellipsis">{git.branch ?? t("Detached HEAD")}</span>
					{git.branch && (
						<button
							type="button"
							className="icon-btn"
							aria-label={t("Copy branch name")}
							title={t("Copy branch name")}
							onClick={() => void attempt(() => trivium.copyText(git.branch!))}
						>
							<CopyIcon size={13} />
						</button>
					)}
				</div>
				{git.upstream && (
					<p className="bs-sub">
						{tx("Tracks {upstream}", { upstream: <span className="mono">{git.upstream}</span> })}
						{" · "}
						{git.fetchedAt ? t("fetched {when}", { when: since(git.fetchedAt) }) : t("never fetched")}
					</p>
				)}
			</section>
			<section className="bs-section">
				<h3>{t("Remote")}</h3>
				<RemoteState git={git} />
			</section>
			<section className="bs-section">
				<h3>{t("Not committed")}</h3>
				{tiles.length ? (
					<div className="bs-tiles">
						{tiles.map((tile) => (
							<div key={tile.area} className={`bs-tile is-${tile.area}`}>
								<strong>{counts[tile.area]}</strong>
								<span>{t(tile.label)}</span>
							</div>
						))}
					</div>
				) : (
					<p className="bs-line is-done">
						<CheckIcon size={15} width={2.2} />
						<span>{t("Nothing to commit")}</span>
					</p>
				)}
				{git.truncated && <p className="bs-note">{t("Counting the first {n} changes.", { n: git.files.length })}</p>}
			</section>
			<div className="bs-actions">
				<button type="button" className="btn" onClick={showGit}>
					{t("Show in Git")}
				</button>
				{git.ahead > 0 && git.upstream && (
					<button type="button" className="btn ghost" title={t("Puts a message in the box; nothing runs until you send it")} onClick={askPush}>
						{t("Ask the agent to push")}
					</button>
				)}
			</div>
		</div>,
		// Inside the shell, which carries the app's colors; fixed positioning still places it over everything.
		document.querySelector(".shell") ?? document.body,
	);
}
