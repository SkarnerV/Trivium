import { type KeyboardEvent, useContext, useState } from "react";
import type { LimitNotice, Step, Subagent, SubagentChild, SubagentNotice } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { BranchIcon, PenIcon, ReturnIcon } from "../icons.tsx";
import { AgentSession } from "../agent-context.ts";
import { showAgentChild, useStore } from "../store.ts";
import { claimsOf, middle, phaseOf, stateWord, teamOf } from "../agents.ts";
import { Clamp } from "./Clamp.tsx";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

/** How many of a child's steps an opened subagent step lists before "+ N more". */
const SHOWN_STEPS = 6;

/** The agent's name, tinted, so delegated work stands out when scanning the steps. */
export function AgentTag({ agent, quiet = false }: { agent: string; quiet?: boolean }) {
	return <span className={`agent-tag${quiet ? " quiet" : ""}`}>{agent}</span>;
}

/**
 * The step's target column: who was asked, and what. A fan-out reads "Implementing · 2 writers, 1 reviewer", from the
 * plan's lane modes when there is one, else from the agents' names, as the plan state's head does.
 */
export function SubagentTarget({ subagent, fallback }: { subagent: Subagent; fallback: string }) {
	const { children } = subagent;
	if (!children.length) return <span className="target ellipsis prose">{fallback}</span>;
	const only = children.length === 1 ? children[0] : undefined;
	const agents = [...new Set(children.map((child) => child.agent))];
	return (
		<span className="target subagent-target">
			{(only ? [only.agent] : agents.slice(0, 3)).map((agent) => (
				<AgentTag key={agent} agent={agent} />
			))}
			<span className="ellipsis prose">
				{only ? firstLine(only.task) : t("{phase} · {team}", { phase: phaseOf(subagent), team: teamOf(children, false) })}
			</span>
		</span>
	);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/** The child's usage line: model, context, tokens in and out, tools and time, each only when reported. */
function usage(child: SubagentChild): string {
	return [
		child.model,
		child.context && t("{context} context", { context: child.context }),
		child.inputTokens !== undefined && t("{n} in", { n: tokens(child.inputTokens) }),
		child.outputTokens !== undefined && t("{n} out", { n: tokens(child.outputTokens) }),
		child.tokens && t("{n} tokens", { n: tokens(child.tokens) }),
		child.tools > 0 && t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }),
		duration(child.durationMs),
	]
		.filter(Boolean)
		.join(" · ");
}

/** A tool call's end, as a time of day: pi-subagents reports when each call ended, not how long it took. */
function endTime(endMs: number | undefined): string {
	return endMs === undefined ? "" : new Date(endMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * What a child's state asks the reader to know before its steps: it is waiting on the main agent (§8.4), or it ran
 * out of time (§8.2). Information, not a request: the main agent answers a child, and decides what to do next.
 */
function ChildCallouts({ child }: { child: SubagentChild }) {
	const question = child.current?.tool === "contact_supervisor" ? child.current.target : undefined;
	return (
		<>
			{child.waitingOn === "main" && (
				<p className="fanout-note warn">
					{question ? t("It asked the main agent: “{question}”", { question: firstLine(question) }) : t("It is waiting on the main agent.")}
				</p>
			)}
			{child.timedOut && (
				<p className="fanout-note warn">{t(child.output ? "It ran out of time. What it wrote so far is below." : "It ran out of time.")}</p>
			)}
		</>
	);
}

export function ChildDetail({ child, heading }: { child: SubagentChild; heading: boolean }) {
	const shown = child.steps.slice(0, SHOWN_STEPS);
	const more = Math.max(child.tools, child.steps.length) - shown.length;
	const meta = usage(child);
	const patch = child.handoff;
	return (
		<div className="subagent-child">
			{heading && (
				<div className="subagent-child-head">
					<AgentTag agent={child.agent} />
					{child.label && <span className="subagent-label">{child.label}</span>}
					<span className="subagent-child-time">{duration(child.durationMs)}</span>
				</div>
			)}
			{child.task && (
				<>
					<div className="step-detail-label">{t("Task")}</div>
					<Clamp lines={6}>
						<p className="subagent-task">{child.task}</p>
					</Clamp>
				</>
			)}
			<ChildCallouts child={child} />
			{shown.length > 0 && (
				<>
					<div className="step-detail-label">{t("Steps")}</div>
					<ol className="subagent-steps">
						{shown.map((step, index) => (
							<li key={index}>
								<span className="tool">{step.tool}</span>
								<span className="ellipsis">{step.target}</span>
								{step.endMs !== undefined && <span className="subagent-step-time">{endTime(step.endMs)}</span>}
							</li>
						))}
						{more > 0 && <li className="more">{t("+{n} more", { n: more })}</li>}
					</ol>
				</>
			)}
			{(child.output || child.error) && (
				<>
					<div className="step-detail-label">{t(child.error ? "Error" : "Result")}</div>
					{child.status === "error" && child.failedTool && (
						<p className="subagent-usage">{t("Failed after {time} at {tool}", { time: duration(child.durationMs) || "0s", tool: child.failedTool })}</p>
					)}
					{child.error && <pre className="subagent-error">{child.error}</pre>}
					{child.output && (
						<div className="subagent-result">
							<Markdown text={child.output} diagrams />
						</div>
					)}
				</>
			)}
			{meta && <div className="subagent-usage">{meta}</div>}
			{patch && (
				<div className="subagent-usage" title={patch.branch}>
					{t(patch.filesChanged === 1 ? "{adds} added · {dels} removed · 1 file · {branch}" : "{adds} added · {dels} removed · {files} files · {branch}", {
						adds: patch.insertions,
						dels: patch.deletions,
						files: patch.filesChanged,
						branch: middle(patch.branch),
					})}
				</div>
			)}
		</div>
	);
}

/** An opened subagent step: each child's task, its own steps and its answer. */
export function SubagentDetail({ subagent, stepId }: { subagent: Subagent; stepId?: string }) {
	const path = useContext(AgentSession);
	return (
		<div className="subagent-detail">
			{subagent.background && <p className="subagent-note">{t("Running in the background. Its result arrives as its own message.")}</p>}
			{subagent.children.map((child, index) => (
				<div key={index}>
					<ChildDetail child={child} heading={subagent.children.length > 1} />
					{/* Only where there is a panel: a chat session has no Agents tab to show the patch in. */}
					{path && stepId && child.handoff && (
						<button type="button" className="btn ghost" onClick={() => showAgentChild(path, stepId, index)}>
							{t("Show changes in the panel")}
						</button>
					)}
				</div>
			))}
		</div>
	);
}

/** What a running child is doing, in a few words: its tool now, or how it ended. */
export function activity(child: SubagentChild): { text: string; tone: "" | "done" | "error" | "warn" } {
	if (child.timedOut) return { text: t("Timed out after {time}", { time: duration(child.durationMs) }), tone: "error" };
	if (child.waitingOn === "main") {
		const question = child.current?.target;
		return {
			text: question ? t("Waiting on the main agent · {question}", { question: firstLine(question) }) : t("Waiting on the main agent"),
			tone: "warn",
		};
	}
	// A background child whose run ended, or vanished, without its result reaching this session.
	if (child.unreported) return { text: t("Not running · its result didn't arrive here"), tone: "warn" };
	if (child.status === "stopped") return { text: t("Stopped"), tone: "warn" };
	if (child.status === "done" && child.handoff?.error) return { text: t("Done · changes not captured"), tone: "warn" };
	if (child.status === "done" && child.handoff?.changed === false) return { text: t("Done · no changes"), tone: "done" };
	if (child.status === "error") return { text: child.error ? `${t("Failed")} · ${firstLine(child.error)}` : t("Failed"), tone: "error" };
	if (child.status === "done") return { text: child.output ? `${t("Done")} · ${firstLine(child.output)}` : t("Done"), tone: "done" };
	if (child.status === "pending") return { text: t(child.queued ? "Queued · starts when a slot frees" : "Starting"), tone: "" };
	if (child.current) return { text: `${child.current.tool} ${child.current.target}`.trim(), tone: "" };
	return { text: t(child.tools ? "Thinking" : "Starting"), tone: "" };
}

/** A writer's change counts once it handed back a patch with changes, as `+120 −14`. */
function PatchCounts({ child }: { child: SubagentChild }) {
	if (!child.handoff?.changed) return null;
	return (
		<>
			<span className="plus">+{child.handoff.insertions}</span> <span className="minus">−{child.handoff.deletions}</span>
		</>
	);
}

const finishedStatus = (child: SubagentChild) => child.status === "done" || child.status === "error" || child.status === "stopped";

/**
 * The live line while subagents run. One child gets a second line for what it is doing now; several get
 * a row each, and finished rows rest so the ones still working stand out.
 */
export function SubagentLive({ step, now }: { step: Step; now: number }) {
	const path = useContext(AgentSession);
	const [detail, setDetail] = useState<number>();
	const subagent = step.subagent!;
	const running = step.status === "running";
	const time = running && step.startedAt ? duration(now - step.startedAt) : "";
	const { children } = subagent;
	// With a panel, a row opens the child there; without one (a chat, Research, Write), its detail opens in place.
	const open = (index: number) => (path ? showAgentChild(path, step.id, index) : setDetail(detail === index ? undefined : index));
	if (children.length > 1 || subagent.preflight) {
		return (
			<>
				<Fanout step={step} now={now} onChild={open} />
				{detail !== undefined && children[detail] && <ChildDetail child={children[detail]!} heading />}
			</>
		);
	}
	const child = children[0];
	const counts =
		child &&
		[child.tools && t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }), child.tokens && t("{n} tok", { n: tokens(child.tokens) })]
			.filter(Boolean)
			.join(" · ");
	// A single writer's +/− once it is done (§5.3); until then the time.
	const changes = child && child.role === "mutation" && finishedStatus(child) && child.handoff?.changed;
	return (
		<div className={`live-cmd subagent-live${running ? "" : " idle"}`}>
			<div className="live-cmd-head">
				<span className="live-dot" />
				<span className="live-cmd-label">{t(subagent.background ? "Started" : running ? "Delegating to" : "Delegated to")}</span>
				{child && (
					<>
						<AgentTag agent={child.agent} />
						{path && <ChildRole child={child} />}
					</>
				)}
				<span className="live-cmd-prose ellipsis">
					{child ? firstLine(child.task) : step.target}
					{subagent.background && <span className="subagent-bg"> · {t("in the background")}</span>}
				</span>
				<span className="live-cmd-time">{changes ? <PatchCounts child={child} /> : time}</span>
			</div>
			{child && running && !subagent.background && (
				<button type="button" className="subagent-now subagent-single-open" onClick={() => open(0)} title={t(path ? "Show in the panel" : "Show details")}>
					<span className="ellipsis">↳ {activity(child).text}</span>
					{counts && <span className="subagent-now-count">{counts}</span>}
				</button>
			)}
			{detail === 0 && child && <ChildDetail child={child} heading />}
		</div>
	);
}

/** Where a child works, in words: what the role glyph says to a screen reader and in its title. */
export function childRole(child: SubagentChild): string {
	return child.role === "mutation" ? t(child.worktree ? "Writes in its own worktree" : "Writes in the project folder") : t("Reads only");
}

/** A branch for a writer in its own worktree, a pen for one in the project folder, nothing for a reader. */
export function ChildRole({ child }: { child: SubagentChild }) {
	return (
		<span className="subagent-role" title={childRole(child)} aria-label={childRole(child)}>
			{child.role === "mutation" && (child.worktree ? <BranchIcon size={11} /> : <PenIcon size={11} />)}
		</span>
	);
}

/**
 * Moves focus among a list's rows with ↑/↓, Home and End (roving tabindex: only the current row is in the tab order).
 * Only a key the user pressed moves focus; live updates re-render the rows without touching it.
 */
function roveRows(event: KeyboardEvent<HTMLElement>, onMove: (index: number) => void): void {
	const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".subagent-row")];
	const from = rows.indexOf(document.activeElement as HTMLButtonElement);
	if (from < 0) return;
	const to =
		event.key === "ArrowDown" ? Math.min(rows.length - 1, from + 1)
			: event.key === "ArrowUp" ? Math.max(0, from - 1)
				: event.key === "Home" ? 0
					: event.key === "End" ? rows.length - 1
						: -1;
	if (to < 0) return;
	event.preventDefault();
	onMove(to);
	rows[to]!.focus();
}

/**
 * All lanes stay in order; shape and words carry state independently of the segment colors. In the Agents tab
 * (`list`), the rows are a list moved through with the arrow keys; in the thread they are ordinary buttons in the
 * tab order. Without a panel (`AgentSession` unset: a chat, Research or Write), nothing Code-only shows: no role
 * glyphs, worktrees or uncommitted-changes notes, and a row opens its detail in place.
 */
export function Fanout({ step, now, onChild, list = false, limit }: { step: Step; now: number; onChild: (index: number) => void; list?: boolean; limit?: LimitNotice }) {
	const path = useContext(AgentSession);
	const code = Boolean(path);
	const dirty = useStore((s) => Boolean(path && s.git[path]?.files.length));
	const [active, setActive] = useState(0);
	const subagent = step.subagent!;
	const { children } = subagent;
	const finished = children.filter(finishedStatus).length;
	const failed = children.filter((child) => child.status === "error").length;
	const waiting = children.filter((child) => child.waitingOn === "main").length;
	const stopped = children.filter((child) => child.status === "stopped").length;
	const plan = children.length > 0 && children.every((child) => child.status === "pending");
	const writers = children.filter((child) => child.role === "mutation");
	const rejected = step.status === "error" && plan;
	const dirtyRejected = code && rejected && /dirty|uncommitted|clean (?:working|work|source|folder|tree)/i.test(step.output ?? "");
	const phase = phaseOf(subagent);
	const kept = subagent.keptWorktrees?.length ?? 0;
	const summary = plan
		? t("{phase} · {team}", { phase, team: code ? teamOf(children) : t(children.length === 1 ? "{n} agent" : "{n} agents", { n: children.length }) })
		: t("{phase} · {finished} of {total} finished", { phase, finished, total: children.length });
	return (
		<div
			className={`live-cmd subagent-live fanout${plan ? " is-plan" : ""}${rejected ? " not-started" : ""}`}
			role="group"
			aria-label={summary}
		>
			<div className="live-cmd-head">
				<span className="live-dot" aria-hidden="true" />
				{/* Announced when a count changes. The timer beside it stays out, or it would be read out every second. */}
				<span className="live-cmd-prose" role="status" aria-live="polite">
					{summary}
					{failed > 0 && <span className="steps-failed"> · {t("{n} failed", { n: failed })}</span>}
					{waiting > 0 && <span className="warn"> · {t("{n} waiting on the main agent", { n: waiting })}</span>}
					{stopped > 0 && <span className="warn"> · {t("{n} stopped", { n: stopped })}</span>}
				</span>
				<span className="live-cmd-time">{duration(step.durationMs ?? (step.startedAt ? now - step.startedAt : undefined))}</span>
			</div>
			<div className="fanout-bar" aria-hidden="true">
				{children.map((child, index) => (
					<i key={index} className={child.waitingOn ? "waiting" : child.status} />
				))}
			</div>
			<div
				className="fanout-rows"
				role={list ? "list" : undefined}
				onKeyDown={list ? (event) => roveRows(event, setActive) : undefined}
			>
				{children.map((child, index) => {
					const row = (
						<FanoutRow
							key={child.childId ?? index}
							step={step}
							index={index}
							child={child}
							plan={plan}
							rejected={rejected}
							code={code}
							tabIndex={list ? (index === Math.min(active, children.length - 1) ? 0 : -1) : undefined}
							onFocus={list ? () => setActive(index) : undefined}
							onOpen={() => onChild(index)}
						/>
					);
					// The item wrapper takes no box (display: contents), so the row stays on the block's shared grid.
					return list ? (
						<div role="listitem" className="fanout-item" key={child.childId ?? index}>
							{row}
						</div>
					) : (
						row
					);
				})}
			</div>
			{code && writers.length === 1 && !writers[0]!.worktree && dirty && !dirtyRejected && (
				<p className="fanout-note">{t("One writer, in the project folder: there are uncommitted changes, and separate worktrees need a clean folder.")}</p>
			)}
			{dirtyRejected && (
				<p className="fanout-note warn">
					{t(
						"Not started: the project folder has uncommitted changes, and separate worktrees need a clean folder. The main agent will use one writer or ask you.",
					)}
				</p>
			)}
			{subagent.budgetExhausted && <p className="fanout-note warn">{t("The subagent budget ran out. Completed work is kept.")}</p>}
			{limit && <FanoutLimit limit={limit} agents={children} />}
			{code && kept > 0 && (
				<p className="fanout-note warn">
					{t(kept === 1 ? "1 worktree was kept. See the Agents tab for its path and reason." : "{n} worktrees were kept. See the Agents tab for their paths and reasons.", { n: kept })}
				</p>
			)}
		</div>
	);
}

/**
 * A provider's usage limit that ended the run during a fan-out (§8.8, run level): the limit notice's own words and
 * link, then what it meant for the agents. Which child hit it is not classified (v1.1).
 */
export function FanoutLimit({ limit, agents }: { limit: LimitNotice; agents: SubagentChild[] }) {
	const stopped = agents.filter((child) => child.status === "stopped" || child.status === "pending").length;
	const kept = agents.filter((child) => child.status === "done").length;
	return (
		<div className="fanout-note warn">
			<p>
				{limit.message} {stopped > 0 && t(stopped === 1 ? "1 agent stopped." : "{n} agents stopped.", { n: stopped })}{" "}
				{kept > 0 && t(kept === 1 ? "The one that finished kept its work." : "The {n} that finished kept their work.", { n: kept })}
			</p>
			{limit.link && (
				<a href={limit.link.url} target="_blank" rel="noreferrer">
					{limit.link.label}
				</a>
			)}
		</div>
	);
}

/**
 * One child in a fan-out: mark · agent · key · role · activity · meta, on the block's shared grid. Before any child
 * starts, the activity column shows the lane's claimed files, or its task, and the meta column says it is starting.
 */
function FanoutRow({
	step,
	index,
	child,
	plan,
	rejected,
	code,
	tabIndex,
	onFocus,
	onOpen,
}: {
	step: Step;
	index: number;
	child: SubagentChild;
	plan: boolean;
	rejected: boolean;
	code: boolean;
	tabIndex?: number;
	onFocus?: () => void;
	onOpen: () => void;
}) {
	const subagent = step.subagent!;
	const lane = subagent.preflight?.lanes.find((lane) => lane.key === child.label);
	const state = child.waitingOn ? "waiting" : child.status;
	const { text, tone } = activity(child);
	const display = rejected ? t("Not started") : plan ? (lane?.claims?.length ? claimsOf(lane.claims) : "") || firstLine(child.task) || text : text;
	const done = finishedStatus(child);
	const tools = !done && child.tools > 0 ? t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }) : "";
	const time = duration(child.durationMs);
	const meta = plan ? text : done && child.handoff?.changed ? `+${child.handoff.insertions} −${child.handoff.deletions}` : [tools, time].filter(Boolean).join(" · ");
	const key = child.label ? (subagent.background ? t("{key} · in the background", { key: child.label }) : child.label) : subagent.background ? t("in the background") : "";
	const label = { agent: child.agent, label: key || child.agent, role: childRole(child), state: stateWord(child), activity: display, meta };
	return (
		<button
			type="button"
			data-agent-step={step.id}
			data-agent-child={index}
			className={`subagent-row${done ? " finished" : ""}`}
			title={t(code ? "Show in the panel" : "Show details")}
			tabIndex={tabIndex}
			onFocus={onFocus}
			aria-label={t(meta ? "{agent} {label}, {role}, {state}, {activity}, {meta}" : "{agent} {label}, {role}, {state}, {activity}", label)}
			onClick={onOpen}
		>
			<span className={`subagent-mark ${state}`} aria-hidden="true">
				{child.waitingOn ? "Ⅱ" : child.status === "done" ? "✓" : child.status === "error" ? "×" : child.status === "stopped" ? "■" : ""}
			</span>
			<AgentTag agent={child.agent} quiet={done} />
			<span className="subagent-label ellipsis" title={key}>
				{key}
			</span>
			{code ? <ChildRole child={child} /> : <span className="subagent-role" />}
			<span className={`subagent-activity ellipsis ${plan ? "" : tone}`} title={display}>
				{display}
			</span>
			<span className="subagent-now-count">
				{plan ? (
					text
				) : done && child.handoff?.changed ? (
					<PatchCounts child={child} />
				) : (
					<>
						{tools && <span className="fanout-tools">{tools} · </span>}
						{time}
					</>
				)}
			</span>
		</button>
	);
}

const NOTICE_VERBS: Record<SubagentNotice["status"], string> = {
	completed: "finished",
	failed: "failed",
	paused: "paused",
	stopped: "was stopped",
};

/** The line that opens a run started by a background subagent's result, in place of a user message. */
export function SubagentNoticeLine({ notice }: { notice: SubagentNotice }) {
	const [open, setOpen] = useState(false);
	const took =
		notice.durationMs !== undefined ? ` ${t(notice.status === "completed" ? "in {time}" : "after {time}", { time: duration(notice.durationMs) })}` : "";
	// A command's verdict is what it printed last.
	const preview = notice.command !== undefined ? firstLine(notice.text.trim().split("\n").at(-1) ?? "") : firstLine(notice.text.replace(/^[#>*\-\s]+/gm, ""));
	return (
		<div className={`subagent-notice${notice.status === "completed" ? "" : " problem"}`}>
			<div className="subagent-notice-head">
				<span className="subagent-notice-icon">
					<ReturnIcon />
				</span>
				{notice.command !== undefined ? (
					<code className="subagent-notice-command ellipsis">{notice.command.split("\n")[0]}</code>
				) : (
					notice.agent.split(", ").map((agent) => <AgentTag key={agent} agent={agent} />)
				)}
				<span className="subagent-notice-status">
					{t(NOTICE_VERBS[notice.status])}
					{took}
				</span>
				{!open && preview && <span className="subagent-notice-preview ellipsis">· {preview}</span>}
				{notice.text && (
					<button type="button" className="subagent-notice-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
						{t(open ? "Hide result" : "Show result")}
					</button>
				)}
			</div>
			{open && (
				<div className="subagent-notice-body">
					<Markdown text={notice.text} />
				</div>
			)}
		</div>
	);
}
