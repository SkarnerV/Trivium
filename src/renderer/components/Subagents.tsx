import { createContext, type KeyboardEvent, useContext, useEffect, useState } from "react";
import type { LimitNotice, Step, Subagent, SubagentChild, SubagentNotice } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { BookIcon, BotIcon, BranchIcon, Chevron, CodeIcon, ExternalIcon, EyeIcon, PenIcon, SearchIcon } from "../icons.tsx";
import { AgentSession } from "../agent-context.ts";
import { showAgentChild, trivium, useStore } from "../store.ts";
import { claimsOf, middle, phaseOf, stateWord, teamOf } from "../agents.ts";
import { Clamp } from "./Clamp.tsx";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

/*
 * Two views of the same children. The thread shows each subagent as a row that opens its own session (AgentAvatar,
 * SubagentRow, SubagentGroup, SubagentNoticeLine). The Agents tab shows a fan-out's lanes and each child's detail
 * (Fanout, ChildDetail and the rest).
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
	// The states the Agents tab words the same way: waiting, timed out, stopped, unreported, a writer's patch.
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

/** The model, tool count and tokens, for a row's tooltip. */
function usageLine(child: SubagentChild): string {
	return [
		child.model,
		child.tools ? t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }) : "",
		child.tokens ? t("{n} tokens", { n: tokens(child.tokens) }) : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export function targetOf(child: SubagentChild): SubagentTarget | undefined {
	return child.sessionFile ? { file: child.sessionFile, agent: child.agent, label: child.label, task: child.task } : undefined;
}

/**
 * One subagent: its mark, name and what it is doing now (or its answer's first line once done). Clicking
 * opens its own session; Shift-click opens it in a new window.
 */
export function SubagentRow({ child: reported, background = false, claims }: { child: SubagentChild; background?: boolean; claims?: string[] }) {
	const opener = useContext(SubagentOpenerContext);
	// Roles and worktrees are Code's, shown where the session has an Agents tab.
	const code = Boolean(useContext(AgentSession));
	// A background child works on after its launch step ends, until its result says otherwise.
	const later = background && reported.sessionFile ? opener?.background?.get(reported.sessionFile) : undefined;
	const child: SubagentChild = background ? (later ?? { ...reported, status: "running" }) : reported;
	const target = targetOf(child);
	const { text, code: asCode, warn } =
		background && child.status === "running" ? { text: t("Running in the background. Its result arrives as its own message."), code: false, warn: false } : rowActivity(child, claims);
	const status = agentStatus(child);
	const finished = child.status === "done" || child.status === "error" || child.status === "stopped";
	const content = (
		<>
			<AgentAvatar agent={child.agent} status={status} />
			<span className="agent-row-main">
				<span className="agent-row-name">
					<span className="agent-row-agent">{child.agent}</span>
					{code && child.role === "mutation" && <ChildRole child={child} />}
					{child.label ? <span className="agent-row-key">{child.label}</span> : <span className="agent-row-task ellipsis">{firstLine(child.task)}</span>}
				</span>
				<span className={`agent-row-activity ellipsis${asCode ? " code" : ""}${child.status === "error" && child.error ? " error" : warn ? " warn" : ""}`}>{text}</span>
			</span>
			{background && !finished ? (
				<span className="agent-pill">{t("Runs on its own")}</span>
			) : (
				status !== "done" && <span className={`agent-status is-${status}`}>{statusWord(status)}</span>
			)}
			{child.status === "done" && child.handoff?.changed && (
				<span className="agent-row-patch">
					<PatchCounts child={child} />
				</span>
			)}
			<span className="agent-row-time">{finished || child.status === "running" ? duration(child.durationMs) : ""}</span>
			{target && opener && <Chevron open={false} />}
		</>
	);
	const usage = usageLine(child);
	if (!target || !opener) {
		return (
			<div className="agent-row" title={usage || undefined}>
				{content}
			</div>
		);
	}
	return (
		<button
			type="button"
			className={`agent-row is-button${opener.current === target.file ? " current" : ""}`}
			aria-label={t("Open {agent}'s session", { agent: [child.agent, child.label].filter(Boolean).join(" ") })}
			title={[usage, t("Shift-click opens it in a new window")].filter(Boolean).join("\n")}
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
 * A subagent call in the thread. One child is a single row; several get a header that says how they are
 * doing, over a row each. The group stays open while they work and folds once they are done.
 */
/**
 * What a subagent call's rows can't say: it never started because the folder had uncommitted changes, the budget ran
 * out, a usage limit ended the run during it, or worktrees were kept. The Agents tab has the details.
 */
function GroupNotes({ step, limit }: { step: Step; limit?: LimitNotice }) {
	const code = Boolean(useContext(AgentSession));
	const subagent = step.subagent!;
	const { children } = subagent;
	const rejected = step.status === "error" && children.length > 0 && children.every((child) => child.status === "pending");
	const dirty = code && rejected && /dirty|uncommitted|clean (?:git |working |work |source |folder |tree)/i.test(step.output ?? "");
	const kept = subagent.keptWorktrees?.length ?? 0;
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
			{code && kept > 0 && (
				<p className="fanout-note warn">
					{t(kept === 1 ? "1 worktree was kept. See the Agents tab for its path and reason." : "{n} worktrees were kept. See the Agents tab for their paths and reasons.", { n: kept })}
				</p>
			)}
		</>
	);
}

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
	const opener = useContext(SubagentOpenerContext);
	const { status, word } = NOTICE_STATUS[notice.status];
	const command = notice.command !== undefined;
	// A command's verdict is what it printed last.
	const line = command ? firstLine(notice.text.trim().split("\n").at(-1) ?? "") : preview(notice.text);
	const sessionFile = notice.sessionFile;
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
				{sessionFile && opener && (
					<button
						type="button"
						className="icon-btn agent-notice-open"
						aria-label={t("Open its session")}
						title={t("Open its session. Shift-click opens it in a new window.")}
						onClick={(event) => opener.open({ file: sessionFile, agent: notice.agent, task: "" }, event.shiftKey)}
					>
						<ExternalIcon size={13} />
					</button>
				)}
			</div>
			{open && (
				<div className="agent-notice-body">
					<Markdown text={notice.text} />
				</div>
			)}
		</div>
	);
}

/* The Agents tab's fan-out and child detail. */

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
	const path = useContext(AgentSession);
	const [history, setHistory] = useState<{ file: string; steps?: SubagentChild["steps"]; error?: boolean }>();
	const [expanded, setExpanded] = useState(false);
	const sessionFile = child.sessionFile;
	useEffect(() => {
		let active = true;
		setExpanded(false);
		if (path && sessionFile) {
			setHistory({ file: sessionFile });
			trivium.subagentActivity(path, sessionFile).then(
				(steps) => active && setHistory({ file: sessionFile, steps }),
				() => active && setHistory({ file: sessionFile, error: true }),
			);
		}
		return () => { active = false; };
	}, [path, sessionFile]);
	const loaded = history?.file === sessionFile ? history : undefined;
	const steps = loaded?.steps ?? child.steps;
	const shown = expanded ? steps : steps.slice(0, SHOWN_STEPS);
	const more = steps.length - shown.length;
	const meta = usage({ ...child, tools: Math.max(child.tools, steps.length) });
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
			<div className="step-detail-label">{t("Activity")}</div>
			{child.current && <p className="subagent-current">{activity(child).text}</p>}
			{shown.length > 0 ? (
					<ol className="subagent-steps">
						{shown.map((step, index) => (
							<li key={index}>
								{step.input !== undefined || step.output !== undefined ? (
									<details className="subagent-call">
										<summary>
											<span className="tool">{step.tool}</span>
											<span className="ellipsis" title={step.target}>{step.target}</span>
											<span className={`subagent-call-state${step.status === "error" ? " error" : ""}`}>{t(step.status === "error" ? "Failed" : "Done")}</span>
											{step.endMs !== undefined && <span className="subagent-step-time">{endTime(step.endMs)}</span>}
											<span className="subagent-open">{t("Details")} ›</span>
										</summary>
										<div className="step-detail">
											<div className="step-detail-label">{t("Input")}</div>
											<pre>{step.input ?? step.target}</pre>
											<div className="step-detail-label">{t("Output")}</div>
											<pre>{step.output || t("No text output.")}</pre>
										</div>
									</details>
								) : (
									<><span className="tool">{step.tool}</span><span className="ellipsis">{step.target}</span>{step.endMs !== undefined && <span className="subagent-step-time">{endTime(step.endMs)}</span>}</>
								)}
							</li>
						))}
						{more > 0 && <li className="more"><button type="button" className="btn ghost" onClick={() => setExpanded(true)}>{t("Show all {n} steps", { n: steps.length })}</button></li>}
					</ol>
			) : (
				<p className="subagent-usage">{t(path && sessionFile && !loaded?.error && !loaded?.steps ? "Loading tool history…" : child.status === "running" || child.status === "pending" ? "Tool history will appear when this agent finishes." : "Tool history is unavailable for this agent.")}</p>
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
					{/* Code opens the same child detail from both live and finished steps. */}
					{path && stepId && (
						<button type="button" className="btn ghost" onClick={() => showAgentChild(path, stepId, index)}>
							{t("View details")}
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
			title={t("View details")}
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
				<span className="subagent-open">{t("Details")} ›</span>
			</span>
		</button>
	);
}
