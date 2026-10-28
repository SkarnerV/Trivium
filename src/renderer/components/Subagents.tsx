import { useState } from "react";
import type { Step, Subagent, SubagentChild, SubagentNotice } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { ReturnIcon } from "../icons.tsx";
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
					: `${t("{n} agents", { n: children.length })}${agents.length > 3 ? ` · ${t("+{n} more", { n: agents.length - 3 })}` : ""}`}
			</span>
		</span>
	);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function usage(child: SubagentChild): string {
	return [child.model, child.context && t("{context} context", { context: child.context }), child.tokens && t("{n} tokens", { n: tokens(child.tokens) })]
		.filter(Boolean)
		.join(" · ");
}

function ChildDetail({ child, heading }: { child: SubagentChild; heading: boolean }) {
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
							<Markdown text={child.output} />
						</div>
					)}
				</>
			)}
			{meta && <div className="subagent-usage">{meta}</div>}
		</div>
	);
}

/** An opened subagent step: each child's task, its own steps and its answer. */
export function SubagentDetail({ subagent }: { subagent: Subagent }) {
	return (
		<div className="subagent-detail">
			{subagent.background && <p className="subagent-note">{t("Running in the background. Its result arrives as its own message.")}</p>}
			{subagent.children.map((child, index) => (
				<ChildDetail key={index} child={child} heading={subagent.children.length > 1} />
			))}
		</div>
	);
}

/** What a running child is doing, in a few words: its tool now, or how it ended. */
function activity(child: SubagentChild): { text: string; tone: "" | "done" | "error" } {
	if (child.status === "error") return { text: child.error ? `${t("Failed")} · ${firstLine(child.error)}` : t("Failed"), tone: "error" };
	if (child.status === "done") return { text: child.output ? `${t("Done")} · ${firstLine(child.output)}` : t("Done"), tone: "done" };
	if (child.status === "pending") return { text: t("Waiting to start"), tone: "" };
	if (child.current) return { text: `${child.current.tool} ${child.current.target}`.trim(), tone: "" };
	return { text: t(child.tools ? "Thinking" : "Starting"), tone: "" };
}

/**
 * The live line while subagents run. One child gets a second line for what it is doing now; several get
 * a row each, and finished rows rest so the ones still working stand out.
 */
export function SubagentLive({ step, now }: { step: Step; now: number }) {
	const subagent = step.subagent!;
	const running = step.status === "running";
	const time = running && step.startedAt ? duration(now - step.startedAt) : "";
	const { children } = subagent;
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
					{child && <AgentTag agent={child.agent} />}
					<span className="live-cmd-prose ellipsis">
						{child ? firstLine(child.task) : step.target}
						{subagent.background && <span className="subagent-bg"> · {t("in the background")}</span>}
					</span>
					<span className="live-cmd-time">{time}</span>
				</div>
				{child && running && !subagent.background && (
					<div className="subagent-now">
						<span className="ellipsis">↳ {activity(child).text}</span>
						{counts && <span className="subagent-now-count">{counts}</span>}
					</div>
				)}
			</div>
		);
	}
	const working = children.filter((child) => child.status === "running" || child.status === "pending").length;
	return (
		<div className={`live-cmd subagent-live${running ? "" : " idle"}`}>
			<div className="live-cmd-head">
				<span className="live-dot" />
				<span className="live-cmd-prose">
					{t(running ? "Running {n} subagents" : "Ran {n} subagents", { n: children.length })}
					{running && working < children.length && <span className="subagent-bg"> · {t("{n} done", { n: children.length - working })}</span>}
				</span>
				<span className="live-cmd-time">{time}</span>
			</div>
			{children.map((child, index) => {
				const { text, tone } = activity(child);
				const finished = child.status === "done" || child.status === "error";
				return (
					<div key={index} className={`subagent-row${finished ? " finished" : ""}`}>
						<AgentTag agent={child.agent} quiet={finished} />
						{child.label && <span className="subagent-label ellipsis">{child.label}</span>}
						<span className={`subagent-activity ellipsis ${tone}`}>{text}</span>
						<span className="subagent-now-count">
							{finished ? duration(child.durationMs) : child.tools ? t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }) : ""}
						</span>
					</div>
				);
			})}
		</div>
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
	const preview = firstLine(notice.text.replace(/^[#>*\-\s]+/gm, ""));
	return (
		<div className={`subagent-notice${notice.status === "completed" ? "" : " problem"}`}>
			<div className="subagent-notice-head">
				<span className="subagent-notice-icon">
					<ReturnIcon />
				</span>
				{notice.agent.split(", ").map((agent) => (
					<AgentTag key={agent} agent={agent} />
				))}
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
