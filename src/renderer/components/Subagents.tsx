import { useContext, useState } from "react";
import type { Step, Subagent, SubagentChild, SubagentNotice } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { BranchIcon, PenIcon, ReturnIcon } from "../icons.tsx";
import { AgentSession } from "../agent-context.ts";
import { showAgentChild, useStore } from "../store.ts";
import { phaseOf } from "../agents.ts";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

/** How many of a child's steps an opened subagent step lists before "+ N more". */
const SHOWN_STEPS = 6;

/** The agent's name, tinted, so delegated work stands out when scanning the steps. */
export function AgentTag({ agent, quiet = false }: { agent: string; quiet?: boolean }) {
	return <span className={`agent-tag${quiet ? " quiet" : ""}`}>{agent}</span>;
}

/** The step's target column: who was asked, and what. */
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
				{only
					? firstLine(only.task)
					: subagent.preflight ? t("{phase} · {writers} writers, {readers} readers", { phase: phaseOf(subagent), writers: children.filter((child) => child.role === "mutation").length, readers: children.filter((child) => child.role !== "mutation").length }) : `${t("{n} agents", { n: children.length })}${agents.length > 3 ? ` · ${t("+{n} more", { n: agents.length - 3 })}` : ""}`}
			</span>
		</span>
	);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function usage(child: SubagentChild): string {
	return [child.model, child.context && t("{context} context", { context: child.context }), child.inputTokens !== undefined && t("{n} in", { n: tokens(child.inputTokens) }), child.outputTokens !== undefined && t("{n} out", { n: tokens(child.outputTokens) }), child.tokens && t("{n} tokens", { n: tokens(child.tokens) }), child.tools > 0 && t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }), duration(child.durationMs)]
		.filter(Boolean)
		.join(" · ");
}

export function ChildDetail({ child, heading }: { child: SubagentChild; heading: boolean }) {
	const shown = child.steps.slice(0, SHOWN_STEPS);
	const more = Math.max(child.tools, child.steps.length) - shown.length;
	const meta = usage(child);
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
					<p className="subagent-task">{child.task}</p>
				</>
			)}
			{shown.length > 0 && (
				<>
					<div className="step-detail-label">{t("Steps")}</div>
					<ol className="subagent-steps">
						{shown.map((step, index) => (
							<li key={index}>
								<span className="tool">{step.tool}</span>
								<span className="ellipsis">{step.target}</span>
							</li>
						))}
						{more > 0 && <li className="more">{t("+{n} more", { n: more })}</li>}
					</ol>
				</>
			)}
			{(child.output || child.error) && (
				<>
					<div className="step-detail-label">{t(child.error ? "Error" : "Result")}</div>
					{child.error && <pre className="subagent-error">{child.error}</pre>}
					{child.output && (
						<div className="subagent-result">
							<Markdown text={child.output} diagrams />
						</div>
					)}
				</>
			)}
			{meta && <div className="subagent-usage">{meta}</div>}
			{child.handoff && <div className="subagent-usage">{t("{adds} added · {dels} removed · {files} files · {branch}", { adds: child.handoff.insertions, dels: child.handoff.deletions, files: child.handoff.filesChanged, branch: child.handoff.branch })}</div>}
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
				<div key={index}><ChildDetail child={child} heading={subagent.children.length > 1} />{path && stepId && child.handoff && <button type="button" className="btn ghost" onClick={() => showAgentChild(path, stepId, index)}>{t("Show changes in the panel")}</button>}</div>
			))}
		</div>
	);
}

/** What a running child is doing, in a few words: its tool now, or how it ended. */
export function activity(child: SubagentChild): { text: string; tone: "" | "done" | "error" | "warn" } {
	if (child.timedOut) return { text: t("Timed out after {time}", { time: duration(child.durationMs) }), tone: "error" };
	if (child.waitingOn === "main") return { text: child.current?.target ? t("Waiting on the main agent · {question}", { question: firstLine(child.current.target) }) : t("Waiting on the main agent"), tone: "warn" };
	if (child.status === "stopped") return { text: t("Stopped"), tone: "warn" };
	if (child.status === "done" && child.handoff?.error) return { text: t("Done · changes not captured"), tone: "warn" };
	if (child.status === "done" && child.handoff?.changed === false) return { text: t("Done · no changes"), tone: "done" };
	if (child.status === "error") return { text: child.error ? `${t("Failed")} · ${firstLine(child.error)}` : t("Failed"), tone: "error" };
	if (child.status === "done") return { text: child.output ? `${t("Done")} · ${firstLine(child.output)}` : t("Done"), tone: "done" };
	if (child.status === "pending") return { text: t("Starting"), tone: "" };
	if (child.current) return { text: `${child.current.tool} ${child.current.target}`.trim(), tone: "" };
	return { text: t(child.tools ? "Thinking" : "Starting"), tone: "" };
}

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
	if (children.length > 1 || subagent.preflight) return <><Fanout step={step} now={now} onChild={(index) => path ? showAgentChild(path, step.id, index) : setDetail(detail === index ? undefined : index)} />{detail !== undefined && children[detail] && <ChildDetail child={children[detail]!} heading />}</>;
	if (subagent.background || children.length <= 1) {
		const child = children[0];
		const counts =
			child &&
			[child.tools && t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }), child.tokens && t("{n} tok", { n: tokens(child.tokens) })]
				.filter(Boolean)
				.join(" · ");
		return (
			<div className={`live-cmd subagent-live${running ? "" : " idle"}`}>
				<div className="live-cmd-head">
					<span className="live-dot" />
					<span className="live-cmd-label">{t(subagent.background ? "Started" : running ? "Delegating to" : "Delegated to")}</span>
					{child && <><AgentTag agent={child.agent} /><ChildRole child={child} /></>}
					<span className="live-cmd-prose ellipsis">
						{child ? firstLine(child.task) : step.target}
						{subagent.background && <span className="subagent-bg"> · {t("in the background")}</span>}
					</span>
					<span className="live-cmd-time">{time}</span>
				</div>
				{child && running && !subagent.background && (
						<button type="button" className="subagent-now subagent-single-open" onClick={() => path ? showAgentChild(path, step.id, 0) : setDetail(detail === 0 ? undefined : 0)} title={t("Show in the panel")}>
						<span className="ellipsis">↳ {activity(child).text}</span>
						{counts && <span className="subagent-now-count">{counts}</span>}
						</button>
				)}
				{detail === 0 && child && <ChildDetail child={child} heading />}
			</div>
		);
	}
	return null;
}

export function childRole(child: SubagentChild): string {
	return child.role === "mutation" ? t(child.worktree ? "Writes in its own worktree" : "Writes in the project folder") : t("Reads only");
}

export function ChildRole({ child }: { child: SubagentChild }) {
	return <span className="subagent-role" title={childRole(child)} aria-label={childRole(child)}>{child.role === "mutation" && (child.worktree ? <BranchIcon size={11} /> : <PenIcon size={11} />)}</span>;
}

/** All lanes stay in order; shape and words carry state independently of the segment colors. */
export function Fanout({ step, now, onChild }: { step: Step; now: number; onChild: (index: number) => void }) {
	const path = useContext(AgentSession);
	const dirty = useStore((s) => Boolean(path && s.git[path]?.files.length));
	const subagent = step.subagent!;
	const { children } = subagent;
	const finished = children.filter((child) => child.status === "done" || child.status === "error" || child.status === "stopped").length;
	const failed = children.filter((child) => child.status === "error").length;
	const waiting = children.filter((child) => child.waitingOn === "main").length;
	const stopped = children.filter((child) => child.status === "stopped").length;
	const plan = children.length > 0 && children.every((child) => child.status === "pending");
	const writers = children.filter((child) => child.role === "mutation");
	const rejected = step.status === "error" && plan;
	const dirtyRejected = rejected && /dirty|uncommitted|clean (?:working|work|source|folder|tree)/i.test(step.output ?? "");
	const phase = phaseOf(subagent);
	const summary = plan ? t("{phase} · {writers} writers, {readers} readers", { phase, writers: writers.length, readers: children.length - writers.length }) : t("{phase} · {finished} of {total} finished", { phase, finished, total: children.length });
	return <div className={`live-cmd subagent-live fanout${plan ? " is-plan" : ""}${rejected ? " not-started" : ""}`} role="group" aria-label={summary}>
		<div className="live-cmd-head">
			<span className="live-dot" aria-hidden="true" />
			{/* Announced when a count changes. The timer beside it stays out, or it would be read out every second. */}
			<span className="live-cmd-prose" role="status" aria-live="polite">{summary}
				{failed > 0 && <span className="steps-failed"> · {t("{n} failed", { n: failed })}</span>}
				{waiting > 0 && <span className="warn"> · {t("{n} waiting on the main agent", { n: waiting })}</span>}
				{stopped > 0 && <span className="warn"> · {t("{n} stopped", { n: stopped })}</span>}
			</span>
			<span className="live-cmd-time">{duration(step.durationMs ?? (step.startedAt ? now - step.startedAt : undefined))}</span>
		</div>
		<div className="fanout-bar" aria-hidden="true">{children.map((child, index) => <i key={index} className={child.waitingOn ? "waiting" : child.status} />)}</div>
		<div className="fanout-rows">{children.map((child, index) => {
			const lane = subagent.preflight?.lanes.find((lane) => lane.key === child.label);
			const state = child.waitingOn ? "waiting" : child.status;
			const { text, tone } = activity(child);
			const display = rejected ? t("Not started") : plan ? lane?.claims?.join(", ") || child.task || t("Starting") : text;
			const done = child.status === "done" || child.status === "error" || child.status === "stopped";
			return <button type="button" key={child.childId ?? index} data-agent-step={step.id} data-agent-child={index} className={`subagent-row${done ? " finished" : ""}`} title={t("Show in the panel")}
				aria-label={t("{label}, {agent}, {role}, {activity}", { label: child.label || child.agent, agent: child.agent, role: childRole(child), activity: display })} onClick={() => onChild(index)}>
				<span className={`subagent-mark ${state}`} aria-hidden="true">{child.waitingOn ? "Ⅱ" : child.status === "done" ? "✓" : child.status === "error" ? "×" : child.status === "stopped" ? "■" : ""}</span>
				<AgentTag agent={child.agent} quiet={done} />
				<span className="subagent-label ellipsis" title={child.label}>{child.label}</span>
				<ChildRole child={child} />
				<span className={`subagent-activity ellipsis ${tone}`} title={display}>{display}</span>
				<span className="subagent-now-count">{child.handoff?.changed && done ? <><span className="plus">+{child.handoff.insertions}</span> <span className="minus">−{child.handoff.deletions}</span></> : <>{!done && child.tools > 0 && <span className="fanout-tools">{t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools })} · </span>}{duration(child.durationMs)}</>}</span>
			</button>;
		})}</div>
		{writers.length === 1 && !writers[0]!.worktree && dirty && !dirtyRejected && <p className="fanout-note">{t("One writer, in the project folder: there are uncommitted changes, and separate worktrees need a clean folder.")}</p>}
		{dirtyRejected && <p className="fanout-note warn">{t("Not started: the project folder has uncommitted changes, and separate worktrees need a clean folder. The main agent will use one writer or ask you.")}</p>}
		{subagent.budgetExhausted && <p className="fanout-note warn">{t("The subagent budget ran out. Completed work is kept.")}</p>}
		{Boolean(subagent.keptWorktrees?.length) && <p className="fanout-note warn">{t("{n} worktrees were kept. See the Agents tab for their paths and reasons.", { n: subagent.keptWorktrees!.length })}</p>}
	</div>;
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
