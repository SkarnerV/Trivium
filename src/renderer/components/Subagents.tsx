import { createContext, useContext, useState } from "react";
import type { Step, SubagentChild, SubagentNotice } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { BookIcon, BotIcon, Chevron, CodeIcon, ExternalIcon, EyeIcon, PenIcon, SearchIcon } from "../icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

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

export type AgentStatus = SubagentChild["status"] | "stopped";

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
};

export function statusWord(status: AgentStatus): string {
	return t(STATUS_WORDS[status]);
}

/** What a child is doing, or how it ended, in one line. Tool calls read as code. */
function activity(child: SubagentChild): { text: string; code: boolean } {
	if (child.status === "error") return { text: firstLine(child.error) || t("Failed"), code: false };
	if (child.status === "done") return { text: preview(child.output) || t("Done"), code: false };
	if (child.status === "pending") return { text: t("Waiting to start"), code: false };
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
export function SubagentRow({ child: reported, background = false }: { child: SubagentChild; background?: boolean }) {
	const opener = useContext(SubagentOpenerContext);
	// A background child works on after its launch step ends, until its result says otherwise.
	const later = background && reported.sessionFile ? opener?.background?.get(reported.sessionFile) : undefined;
	const child: SubagentChild = background ? (later ?? { ...reported, status: "running" }) : reported;
	const target = targetOf(child);
	const { text, code } =
		background && child.status === "running" ? { text: t("Running in the background. Its result arrives as its own message."), code: false } : activity(child);
	const finished = child.status === "done" || child.status === "error";
	const content = (
		<>
			<AgentAvatar agent={child.agent} status={child.status} />
			<span className="subagent-row-main">
				<span className="subagent-row-name">
					<span className="subagent-agent">{child.agent}</span>
					{child.label ? <span className="subagent-label">{child.label}</span> : <span className="subagent-task ellipsis">{firstLine(child.task)}</span>}
				</span>
				<span className={`subagent-activity ellipsis${code ? " code" : ""}${child.status === "error" ? " error" : ""}`}>{text}</span>
			</span>
			{background && !finished ? (
				<span className="subagent-pill">{t("Runs on its own")}</span>
			) : (
				child.status !== "done" && <span className={`subagent-status is-${child.status}`}>{statusWord(child.status)}</span>
			)}
			<span className="subagent-time">{finished || child.status === "running" ? duration(child.durationMs) : ""}</span>
			{target && opener && <Chevron open={false} />}
		</>
	);
	const usage = usageLine(child);
	if (!target || !opener) {
		return (
			<div className="subagent-row" title={usage || undefined}>
				{content}
			</div>
		);
	}
	return (
		<button
			type="button"
			className={`subagent-row is-button${opener.current === target.file ? " current" : ""}`}
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
	return [
		working && t("{n} working", { n: working }),
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
export function SubagentGroup({ step, now }: { step: Step; now: number }) {
	const [open, setOpen] = useState<boolean | undefined>(undefined);
	const { children, background } = step.subagent!;
	const running = step.status === "running";
	if (!children.length) {
		return (
			<div className="subagent-single">
				<div className="subagent-row">
					<AgentAvatar agent="" status={running ? "running" : step.status === "error" ? "error" : "done"} />
					<span className="subagent-row-main">
						<span className="subagent-row-name">
							<span className="subagent-task ellipsis">{step.target}</span>
						</span>
						<span className="subagent-activity ellipsis">{t(running ? "Starting subagents…" : step.status === "error" ? "Failed" : "Done")}</span>
					</span>
				</div>
			</div>
		);
	}
	if (children.length === 1 || background) {
		return (
			<div className="subagent-single">
				{children.map((child, index) => (
					<SubagentRow key={index} child={child} background={background} />
				))}
			</div>
		);
	}
	const shown = open ?? running;
	const failed = children.some((child) => child.status === "error");
	const time = running && step.startedAt ? duration(now - step.startedAt) : duration(step.durationMs);
	return (
		<div className={`subagent-group${shown ? " open" : ""}${running ? " live" : ""}`}>
			<button type="button" className="subagent-group-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
				<AvatarStack agents={children.map((child) => child.agent)} />
				<span className="subagent-group-title">
					<strong>{t(running ? "Running {n} subagents" : "Ran {n} subagents", { n: children.length })}</strong>
					<span className={`subagent-group-summary ellipsis${running ? " active" : failed ? " error" : ""}`}>{statusSummary(children)}</span>
				</span>
				<span className="subagent-time">{time}</span>
				<Chevron open={shown} down />
			</button>
			{shown && (
				<div className="subagent-rows">
					{children.map((child, index) => (
						<SubagentRow key={index} child={child} />
					))}
				</div>
			)}
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
		<div className={`subagent-notice${open ? " open" : ""}`}>
			<div className="subagent-notice-head">
				<button type="button" className="subagent-row is-button" aria-expanded={open} disabled={!notice.text} onClick={() => setOpen(!open)}>
					{command ? (
						<span className={`agent-avatar is-${status}`} style={{ ["--avatar" as string]: "24px" }} aria-hidden="true">
							<CodeIcon size={12} />
							<span className="agent-avatar-dot" />
						</span>
					) : (
						<AgentAvatar agent={notice.agent} status={status} />
					)}
					<span className="subagent-row-main">
						<span className="subagent-row-name">
							{command ? <code className="subagent-command ellipsis">{notice.command!.split("\n")[0]}</code> : <span className="subagent-agent">{notice.agent}</span>}
						</span>
						<span className={`subagent-activity ellipsis${command ? " code" : ""}${status === "error" ? " error" : ""}`}>{line || t(word)}</span>
					</span>
					<span className={`subagent-status is-${status}`}>{t(word)}</span>
					<span className="subagent-time">{duration(notice.durationMs)}</span>
					{notice.text && <Chevron open={open} />}
				</button>
				{sessionFile && opener && (
					<button
						type="button"
						className="icon-btn subagent-notice-open"
						aria-label={t("Open its session")}
						title={t("Open its session. Shift-click opens it in a new window.")}
						onClick={(event) => opener.open({ file: sessionFile, agent: notice.agent, task: "" }, event.shiftKey)}
					>
						<ExternalIcon size={13} />
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
