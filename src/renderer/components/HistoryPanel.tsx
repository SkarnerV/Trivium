import { useEffect, useMemo, useState } from "react";
import type { GitCommitDetail, GitCommitFile, GitHistory, GitHistoryCommit, GitRef, GitStatus, SessionView } from "../../shared/protocol.ts";
import { relativeTime } from "../format.ts";
import { type GraphLine, type GraphRow, layoutGraph, linesBelow } from "../graph.ts";
import { t } from "../i18n.tsx";
import { Chevron } from "../icons.tsx";
import { errorText, openSession, trivium, useStore } from "../store.ts";
import { FileRow } from "./FileRow.tsx";

/** Commits read at first, and each time the list goes further back. */
const PAGE = 200;

const ROW_HEIGHT = 28;
const LANE_WIDTH = 12;
const GRAPH_INSET = 6;
/** Past this many columns the graph is cut off, so the commits' subjects keep their room in a narrow panel. */
const MAX_LANES = 10;

const laneX = (lane: number) => GRAPH_INSET + lane * LANE_WIDTH + LANE_WIDTH / 2;

/** A line down from (x1, y1) to (x2, y2) that leaves and arrives vertically. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
	if (x1 === x2) return `M${x1} ${y1}V${y2}`;
	const middle = (y1 + y2) / 2;
	return `M${x1} ${y1}C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`;
}

function GraphCell({ row, width, merge, head }: { row: GraphRow; width: number; merge: boolean; head: boolean }) {
	const x = laneX(row.lane);
	const mid = ROW_HEIGHT / 2;
	return (
		<svg className="commit-graph" width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`} aria-hidden="true">
			{row.through.map((line) => (
				<path key={`t${line.lane}`} d={`M${laneX(line.lane)} 0V${ROW_HEIGHT}`} className={`graph-line c${line.color}`} />
			))}
			{row.into.map((line) => (
				<path key={`i${line.lane}`} d={curve(laneX(line.lane), 0, x, mid)} className={`graph-line c${line.color}`} />
			))}
			{row.out.map((line) => (
				<path key={`o${line.lane}`} d={curve(x, mid, laneX(line.lane), ROW_HEIGHT)} className={`graph-line c${line.color}`} />
			))}
			{head && <circle cx={x} cy={mid} r={6.5} className={`graph-head c${row.color}`} />}
			<circle cx={x} cy={mid} r={merge ? 3 : 3.5} className={`graph-dot c${row.color}${merge ? " is-merge" : ""}`} />
		</svg>
	);
}

/** The graph's lines carried on down the space under an open commit. */
function GraphRail({ lines, width }: { lines: GraphLine[]; width: number }) {
	return (
		<div className="commit-rail" style={{ width }} aria-hidden="true">
			{lines.map((line) => (
				<span key={line.lane} className={`graph-rail c${line.color}`} style={{ left: laneX(line.lane) - 0.75 }} />
			))}
		</div>
	);
}

function RefTag({ value }: { value: GitRef }) {
	return (
		<span className={`commit-ref is-${value.kind}${value.current ? " is-current" : ""}`} title={value.name}>
			{value.name}
		</span>
	);
}

function commitTitle(commit: GitHistoryCommit): string {
	return `${commit.subject}\n${commit.id.slice(0, 7)} · ${commit.author} · ${new Date(commit.time).toLocaleString()}`;
}

/** The session a commit's trailer names: its title and a way to open it when Trivium knows it. */
function SessionLine({ id }: { id: string }) {
	const session = useStore((s) => s.sessions.find((summary) => summary.id === id));
	return (
		<p className="commit-session">
			<span className="ellipsis">{session ? t("Session: {title}", { title: session.title }) : t("Session {id}", { id: id.slice(0, 8) })}</span>
			{session && (
				<button type="button" className="link-btn" onClick={() => void openSession(session.path)}>
					{t("Open session")}
				</button>
			)}
		</p>
	);
}

/** What opens under a commit: when it was made, the rest of its message, the session it came from, and the files it changed. */
function CommitFiles({ commit, detail, picked, onPick }: {
	commit: GitHistoryCommit;
	detail: { commit?: GitCommitDetail; error?: string } | undefined;
	picked: string | undefined;
	onPick: (file: GitCommitFile) => void;
}) {
	return (
		<div className="commit-body">
			<p className="commit-meta">
				<span className="mono">{commit.id.slice(0, 7)}</span> · {commit.author} · {new Date(commit.time).toLocaleString()}
			</p>
			{commit.parents.length > 1 && <p className="commit-meta">{t("Merge: changes against its first parent.")}</p>}
			{detail?.error && <p className="commit-meta">{detail.error}</p>}
			{detail?.commit && (
				<>
					{detail.commit.body && <p className="commit-message">{detail.commit.body}</p>}
					{detail.commit.session && <SessionLine id={detail.commit.session} />}
					{detail.commit.files.map((file) => (
						<FileRow
							key={file.rel}
							status={file.status}
							rel={file.rel}
							title={file.from ? `${file.from} → ${file.rel}` : file.rel}
							current={picked === file.rel}
							onSelect={() => onPick(file)}
						>
							{file.adds > 0 && <span className="plus">+{file.adds}</span>}
							{file.dels > 0 && <span className="minus">−{file.dels}</span>}
						</FileRow>
					))}
					{!detail.commit.files.length && <p className="commit-meta">{t("No files changed.")}</p>}
					{detail.commit.truncated && <p className="commit-meta">{t("Showing the first {n} changes.", { n: detail.commit.files.length })}</p>}
				</>
			)}
		</div>
	);
}

/**
 * Source Control's History: every branch's commits as a graph, under a heading that folds it. A commit opens in
 * place to its files; picking one shows its diff in the pane below the list.
 */
export function HistorySection({ view, git, picked, onPick }: {
	view: SessionView;
	git: GitStatus;
	picked: { id: string; rel: string } | undefined;
	onPick: (commit: GitHistoryCommit, file: GitCommitFile) => void;
}) {
	const [folded, setFolded] = useState(false);
	const [limit, setLimit] = useState(PAGE);
	const [history, setHistory] = useState<GitHistory>();
	const [error, setError] = useState<string>();
	const [openId, setOpenId] = useState<string>();
	const [detail, setDetail] = useState<{ id: string; commit?: GitCommitDetail; error?: string }>();

	// Read again when a commit lands, the branch changes or the remote is fetched. A new read keeps how far back the list goes.
	const version = `${git.head}:${git.branch}:${git.ahead}:${git.behind}:${git.fetchedAt}`;
	useEffect(() => {
		let live = true;
		trivium.gitHistory(view.path, limit).then(
			(next) => {
				if (!live) return;
				setHistory(next);
				setError(undefined);
			},
			(reason: unknown) => live && setError(errorText(reason)),
		);
		return () => {
			live = false;
		};
	}, [view.path, version, limit]);

	useEffect(() => {
		if (!openId) return;
		let live = true;
		trivium.gitCommit(view.path, openId).then(
			(commit) => live && setDetail({ id: openId, commit }),
			(reason: unknown) => live && setDetail({ id: openId, error: errorText(reason) }),
		);
		return () => {
			live = false;
		};
	}, [view.path, openId]);

	const commits = history?.commits ?? [];
	const graph = useMemo(() => layoutGraph(commits), [commits]);
	const width = GRAPH_INSET * 2 + Math.min(graph.lanes, MAX_LANES) * LANE_WIDTH;

	return (
		<section className="sc-history" aria-label={t("History")}>
			<div className="sc-section-head">
				<button type="button" className="sc-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
					<Chevron open={!folded} size={10} />
					<span>{t("History")}</span>
				</button>
			</div>
			{!folded &&
				(error ? (
					<p className="sc-empty">{error}</p>
				) : history && !commits.length ? (
					<p className="sc-empty">{t("No commits yet.")}</p>
				) : (
					<div role="list" aria-label={t("Commits")}>
						{commits.map((commit, index) => {
							const row = graph.rows[index]!;
							const open = commit.id === openId;
							const head = commit.refs.some((ref) => ref.current || ref.kind === "head");
							return (
								<div key={commit.id} role="listitem">
									<button type="button" className="commit-row" aria-expanded={open} title={commitTitle(commit)} onClick={() => setOpenId(open ? undefined : commit.id)}>
										<GraphCell row={row} width={width} merge={commit.parents.length > 1} head={head} />
										{commit.refs.length > 0 && (
											<span className="commit-refs">
												{commit.refs.map((ref) => (
													<RefTag key={`${ref.kind}:${ref.name}`} value={ref} />
												))}
											</span>
										)}
										<span className="commit-subject ellipsis">{commit.subject}</span>
										<span className="commit-time">{relativeTime(commit.time)}</span>
									</button>
									{open && (
										<div className="commit-detail">
											<GraphRail lines={linesBelow(row)} width={width} />
											<CommitFiles
												commit={commit}
												detail={detail?.id === commit.id ? detail : undefined}
												picked={picked?.id === commit.id ? picked.rel : undefined}
												onPick={(file) => onPick(commit, file)}
											/>
										</div>
									)}
								</div>
							);
						})}
						{history?.more && (
							<button type="button" className="history-more" onClick={() => setLimit(commits.length + PAGE)}>
								{t("Show older commits")}
							</button>
						)}
					</div>
				))}
		</section>
	);
}
