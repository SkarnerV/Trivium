import { createContext, useContext, useState } from "react";
import type { LimitNotice, Step, SubagentChild, SubagentNotice } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { BookIcon, BotIcon, BranchIcon, Chevron, CodeIcon, EyeIcon, PenIcon, SearchIcon } from "../icons.tsx";
import { AgentSession } from "../agent-context.ts";
import { claimsOf } from "../agents.ts";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

/*
 * The thread shows each subagent as a row that opens its own session (AgentAvatar, SubagentRow, SubagentGroup,
 * SubagentNoticeLine); the header's menu lists the same rows for the whole session.
 */

/** A subagent whose own session can be opened: its session file, and enough to title it before it loads. */
export interface SubagentTarget {
	file: string;
	agent: string;
	label?: string;
	task: string;
}

/** Opens a subagent's session beside the thread, or in a window of its own. */
export interface SubagentOpener {
	open(target: SubagentTarget, newWindow: boolean): void;
	/** The session file showing now, whose row is marked. */
	current?: string;
	/**
	 * Background children by session file, as their results later reported them. Their launch step ends at
	 * once, so it can't say whether they are still working.
	 */
	background?: ReadonlyMap<string, SubagentChild>;
}

/** Set by whatever shows a thread that can open its subagents; rows without one don't open. */
export const SubagentOpenerContext = createContext<SubagentOpener | null>(null);

/** A child's state as its mark shows it: its status, or waiting while it asks the main agent something. */
export type AgentStatus = SubagentChild["status"] | "waiting";

export function agentStatus(child: SubagentChild): AgentStatus {
	return child.waitingOn === "main" ? "waiting" : child.status;
}

export function firstLine(text: string | undefined): string {
	return text?.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/** An answer's first line as plain words for a one-line preview: no list marks, emphasis, code ticks or link targets. */
function preview(text: string | undefined): string {
	return firstLine(text?.replace(/^[\s>#*\-+]+/gm, ""))
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]+/g, "");
}

/** An icon for the kind of work an agent does, from its name. Any other agent gets a robot. */
const ICONS: [RegExp, typeof BotIcon][] = [
	// Before search, which "researcher" also contains.
	[/research|oracle|librar|doc/i, BookIcon],
	[/scout|explor|search|find|map/i, SearchIcon],
	[/review|check|audit|verif/i, EyeIcon],
	[/work|writ|delegat|implement|fix|build|code|edit/i, PenIcon],
];

/** The agent's round mark, with a dot in its corner for how it is doing. */
export function AgentAvatar({ agent, status, size = 24 }: { agent: string; status?: AgentStatus; size?: number }) {
	const Icon = ICONS.find(([pattern]) => pattern.test(agent))?.[1] ?? BotIcon;
	return (
		<span className={`agent-avatar${status ? ` is-${status}` : ""}`} style={{ ["--avatar" as string]: `${size}px` }} aria-hidden="true">
			<Icon size={Math.round(size * 0.54)} width={2.2} />
			{status && <span className="agent-avatar-dot" />}
		</span>
	);
}

const STATUS_WORDS: Record<AgentStatus, string> = {
	pending: "Queued",
	running: "Running",
	done: "Done",
	error: "Failed",
	stopped: "Stopped",
	waiting: "Waiting",
};

export function statusWord(status: AgentStatus): string {
	return t(STATUS_WORDS[status]);
}

/** What a child is doing, or how it ended, in one line. Tool calls read as code. */
function rowActivity(child: SubagentChild, claims?: string[]): { text: string; code: boolean; warn?: boolean } {
	// The states with words of their own: waiting, timed out, stopped, unreported, a writer's patch.
	if (child.timedOut || child.waitingOn || child.unreported || child.status === "stopped" || (child.status === "done" && child.handoff && (child.handoff.error || !child.handoff.changed))) {
		const { text, tone } = activity(child);
		return { text, code: false, warn: tone === "warn" };
	}
	// Before it starts, a planned lane says which files it will change.
	if (child.status === "pending" && claims?.length) return { text: claimsOf(claims), code: true };
	// Without a message, the status word beside it already says it failed; the task says what failed.
	if (child.status === "error") return { text: firstLine(child.error) || firstLine(child.task) || t("Failed"), code: false };
	if (child.status === "done") return { text: preview(child.output) || t("Done"), code: false };
	if (child.status === "pending") return { text: t(child.queued ? "Queued · starts when a slot frees" : "Waiting to start"), code: false };
	if (child.current) return { text: `${child.current.tool} ${child.current.target}`.trim(), code: true };
	return { text: t(child.tools ? "Thinking" : "Starting"), code: false };
}

/** What it is using now, how many tools it called and the tokens it spent, in one line. */
function workLine(child: SubagentChild): string {
	return [
		child.status === "running" && child.current ? `${child.current.tool} ${child.current.target}`.trim() : "",
		child.tools ? t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }) : "",
		child.tokens ? t("{n} tokens", { n: tokens(child.tokens) }) : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** A model's chip, for the card's model line. */
function ChipIcon() {
	return (
		<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="4" width="10" height="9" rx="2" />
			<path d="M8 1.75V4M6 8.25h.01M10 8.25h.01" />
		</svg>
	);
}

/** A shell prompt, for the card's line of what it is doing. */
function PromptIcon() {
	return (
		<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 4.5L6.5 8 3 11.5M8 12h5" />
		</svg>
	);
}

/** The status's shape beside its word: a dashed ring while it works, a tick, a cross, or a square once stopped. */
function StatusIcon({ status }: { status: AgentStatus }) {
	const props = { "aria-hidden": true, width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	if (status === "done") return <svg {...props}><path d="M3.5 8.5l3 3 6-7" /></svg>;
	if (status === "error") return <svg {...props}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>;
	if (status === "stopped") return <svg {...props}><rect x="4.5" y="4.5" width="7" height="7" rx="1" /></svg>;
	return <svg {...props} strokeDasharray="2.2 2.2"><circle cx="8" cy="8" r="5.75" /></svg>;
}

/** The card a thread row shows while hovered or focused: which agent, its model, how it is doing, its branch and its work. */
function RowCard({ child, status, time, opens }: { child: SubagentChild; status: AgentStatus; time: string; opens: boolean }) {
	const work = workLine(child);
	return (
		<span className="agent-card" role="tooltip">
			<strong>{[child.agent, child.label].filter(Boolean).join(" · ")}</strong>
			{child.model && (
				<span className="agent-card-line">
					<ChipIcon />
					<span className="ellipsis">{child.model}</span>
				</span>
			)}
			<span className="agent-card-line spread">
				<span className={`agent-status is-${status} agent-card-status`}>
					<StatusIcon status={status} />
					{statusWord(status)}
				</span>
				{time && <span className="mono">{time}</span>}
			</span>
			{child.handoff?.branch && (
				<span className="agent-card-line">
					<BranchIcon size={12} />
					<span className="mono ellipsis">{child.handoff.branch}</span>
				</span>
			)}
			{work && (
				<span className="agent-card-line">
					<PromptIcon />
					<span className="mono">{work}</span>
				</span>
			)}
			{opens && <span className="agent-card-hint">{t("Click to open its session · Shift-click for a new window")}</span>}
		</span>
	);
}

export function targetOf(child: SubagentChild): SubagentTarget | undefined {
	return child.sessionFile ? { file: child.sessionFile, agent: child.agent, label: child.label, task: child.task } : undefined;
}

/**
 * One subagent: its mark, name and what it is doing now (or its answer's first line once done). Clicking opens its
 * own session; Shift-click opens it in a new window. In the thread a finished row leaves out its status word and
 * shows a card while hovered; in the header's menu every row says how it is doing, and the menu has its own button
 * for a new window.
 */
export function SubagentRow({
	child: reported,
	background = false,
	claims,
	place = "thread",
}: {
	child: SubagentChild;
	background?: boolean;
	claims?: string[];
	place?: "thread" | "menu";
}) {
	const opener = useContext(SubagentOpenerContext);
	// A background child works on after its launch step ends, until its result says otherwise.
	const later = background && reported.sessionFile ? opener?.background?.get(reported.sessionFile) : undefined;
	const child: SubagentChild = background ? (later ?? { ...reported, status: "running" }) : reported;
	const target = targetOf(child);
	const { text, code: asCode, warn } =
		background && child.status === "running" ? { text: t("Its result arrives as its own message"), code: false, warn: false } : rowActivity(child, claims);
	const status = agentStatus(child);
	const finished = child.status === "done" || child.status === "error" || child.status === "stopped";
	const time = finished || child.status === "running" ? duration(child.durationMs) : "";
	const menu = place === "menu";
	const opens = Boolean(target && opener);
	const content = (
		<>
			<AgentAvatar agent={child.agent} status={status} />
			<span className="agent-row-main">
				<span className="agent-row-name">
					<span className="agent-row-agent">{child.agent}</span>
					{child.label ? <span className="agent-row-key">{child.label}</span> : <span className="agent-row-task ellipsis">{firstLine(child.task)}</span>}
				</span>
				<span className={`agent-row-activity ellipsis${asCode ? " code" : ""}${child.status === "error" && child.error ? " error" : warn ? " warn" : ""}`}>{text}</span>
			</span>
			{background && !finished ? (
				<span className="agent-pill">{t("Runs on its own")}</span>
			) : (
				(menu || status !== "done") && <span className={`agent-status is-${status}`}>{statusWord(status)}</span>
			)}
			<span className="agent-row-time">{time}</span>
			{opens && !menu && <Chevron open={false} />}
			{!menu && <RowCard child={child} status={status} time={time} opens={opens} />}
		</>
	);
	if (!target || !opener) return <div className="agent-row">{content}</div>;
	return (
		<button
			type="button"
			className={`agent-row is-button${opener.current === target.file ? " current" : ""}`}
			aria-label={t("Open {agent}'s session", { agent: [child.agent, child.label].filter(Boolean).join(" ") })}
			onClick={(event) => opener.open(target, event.shiftKey)}
		>
			{content}
		</button>
	);
}

/** "2 working · 1 done · 1 failed", leaving out what is zero. */
export function statusSummary(children: { status: AgentStatus }[]): string {
	const count = (match: (status: AgentStatus) => boolean) => children.filter((child) => match(child.status)).length;
	const working = count((status) => status === "running");
	const queued = count((status) => status === "pending");
	const done = count((status) => status === "done");
	const failed = count((status) => status === "error");
	const stopped = count((status) => status === "stopped");
	const waiting = count((status) => status === "waiting");
	return [
		working && t("{n} working", { n: working }),
		waiting && t("{n} waiting on the main agent", { n: waiting }),
		queued && t("{n} queued", { n: queued }),
		done && t("{n} done", { n: done }),
		failed && t("{n} failed", { n: failed }),
		stopped && t("{n} stopped", { n: stopped }),
	]
		.filter(Boolean)
		.join(" · ");
}

/** Up to three agents' marks, overlapping, and how many more there are. */
export function AvatarStack({ agents, size = 24, max = 3, more = true }: { agents: string[]; size?: number; max?: number; more?: boolean }) {
	return (
		<span className="avatar-stack" aria-hidden="true">
			{agents.slice(0, max).map((agent, index) => (
				<AgentAvatar key={index} agent={agent} size={size} />
			))}
			{more && agents.length > max && (
				<span className="avatar-more" style={{ ["--avatar" as string]: `${size}px` }}>
					+{agents.length - max}
				</span>
			)}
		</span>
	);
}

/**
 * What a subagent call's rows can't say: it never started because the folder had uncommitted changes, the budget ran
 * out, a usage limit ended the run during it, or a worktree was kept, with where it is and why.
 */
function GroupNotes({ step, limit }: { step: Step; limit?: LimitNotice }) {
	const code = Boolean(useContext(AgentSession));
	const subagent = step.subagent!;
	const { children } = subagent;
	const rejected = step.status === "error" && children.length > 0 && children.every((child) => child.status === "pending");
	const dirty = code && rejected && /dirty|uncommitted|clean (?:git |working |work |source |folder |tree)/i.test(step.output ?? "");
	return (
		<>
			{dirty && (
				<p className="fanout-note warn">
					{t(
						"Not started: the project folder has uncommitted changes, and separate worktrees need a clean folder. The main agent will use one writer or ask you.",
					)}
				</p>
			)}
			{subagent.budgetExhausted && <p className="fanout-note warn">{t("The subagent budget ran out. Completed work is kept.")}</p>}
			{limit && <FanoutLimit limit={limit} agents={children} />}
			{code &&
				subagent.keptWorktrees?.map((kept) => (
					<p key={kept.path} className="fanout-note warn">
						<span>{t("A worktree was kept: {reason}", { reason: kept.reason })}</span>
						<code className="agent-kept-path">{kept.path}</code>
					</p>
				))}
		</>
	);
}

/**
 * A subagent call in the thread. One child is a single row; several get a header that says how they are
 * doing, over a row each. The group stays open while they work and folds once they are done.
 */
export function SubagentGroup({ step, now, limit }: { step: Step; now: number; limit?: LimitNotice }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const { children, background, preflight } = step.subagent!;
	const running = step.status === "running";
	// A planned lane's files, shown in its row until the child starts.
	const claims = (child: SubagentChild) => preflight?.lanes.find((lane) => lane.key === child.label)?.claims;
	if (!children.length) {
		return (
			<div className="agent-single">
				<div className="agent-row">
					<AgentAvatar agent="" status={running ? "running" : step.status === "error" ? "error" : "done"} />
					<span className="agent-row-main">
						<span className="agent-row-name">
							<span className="agent-row-task ellipsis">{step.target}</span>
						</span>
						<span className="agent-row-activity ellipsis">{t(running ? "Starting subagents…" : step.status === "error" ? "Failed" : "Done")}</span>
					</span>
				</div>
			</div>
		);
	}
	if (children.length === 1 || background) {
		return (
			<div className="agent-single">
				{children.map((child, index) => (
					<SubagentRow key={child.childId ?? index} child={child} background={background} claims={claims(child)} />
				))}
				<GroupNotes step={step} limit={limit} />
			</div>
		);
	}
	const shown = open ?? running;
	const failed = children.some((child) => child.status === "error");
	const time = running && step.startedAt ? duration(now - step.startedAt) : duration(step.durationMs);
	return (
		<div className={`agent-group${shown ? " open" : ""}${running ? " live" : ""}`}>
			<button type="button" className="agent-group-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
				<AvatarStack agents={children.map((child) => child.agent)} />
				<span className="agent-group-title">
					<strong>{t(running ? "Running {n} subagents" : "Ran {n} subagents", { n: children.length })}</strong>
					<span className={`agent-group-summary ellipsis${running ? " active" : failed ? " error" : ""}`}>{statusSummary(children.map((child) => ({ status: agentStatus(child) })))}</span>
				</span>
				<span className="agent-row-time">{time}</span>
				<Chevron open={shown} down />
			</button>
			{shown && (
				<div className="agent-rows">
					{children.map((child, index) => (
						<SubagentRow key={child.childId ?? index} child={child} claims={claims(child)} />
					))}
				</div>
			)}
			<GroupNotes step={step} limit={limit} />
		</div>
	);
}

const NOTICE_STATUS: Record<SubagentNotice["status"], { status: AgentStatus; word: string }> = {
	completed: { status: "done", word: "Finished" },
	failed: { status: "error", word: "Failed" },
	paused: { status: "stopped", word: "Paused" },
	stopped: { status: "stopped", word: "Stopped" },
};

/** The row that opens a run started by a background subagent's result, in place of a user message. */
export function SubagentNoticeLine({ notice }: { notice: SubagentNotice }) {
	const [open, setOpen] = useState(false);
	const { status, word } = NOTICE_STATUS[notice.status];
	const command = notice.command !== undefined;
	// A command's verdict is what it printed last.
	const line = command ? firstLine(notice.text.trim().split("\n").at(-1) ?? "") : preview(notice.text);
	return (
		<div className={`agent-notice${open ? " open" : ""}`}>
			<div className="agent-notice-head">
				<button type="button" className="agent-row is-button" aria-expanded={open} disabled={!notice.text} onClick={() => setOpen(!open)}>
					{command ? (
						<span className={`agent-avatar is-${status}`} style={{ ["--avatar" as string]: "24px" }} aria-hidden="true">
							<CodeIcon size={12} />
							<span className="agent-avatar-dot" />
						</span>
					) : (
						<AgentAvatar agent={notice.agent} status={status} />
					)}
					<span className="agent-row-main">
						<span className="agent-row-name">
							{command ? <code className="agent-row-command ellipsis">{notice.command!.split("\n")[0]}</code> : <span className="agent-row-agent">{notice.agent}</span>}
						</span>
						<span className={`agent-row-activity ellipsis${command ? " code" : ""}${status === "error" ? " error" : ""}`}>{line || t(word)}</span>
					</span>
					<span className={`agent-status is-${status}`}>{t(word)}</span>
					<span className="agent-row-time">{duration(notice.durationMs)}</span>
					{notice.text && <Chevron open={open} />}
				</button>
			</div>
			{open && (
				<div className="agent-notice-body">
					<Markdown text={notice.text} />
				</div>
			)}
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
