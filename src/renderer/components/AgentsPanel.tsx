import { useEffect } from "react";
import type { Run, SessionView, Step, SubagentChild } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { useNow } from "../hooks.ts";
import { OrchestrateIcon } from "../icons.tsx";
import { agentAttentionKey, agentCounts, agentSteps, currentStep, phaseOf } from "../agents.ts";
import { nowLine } from "../verbs.ts";
import { AgentSession } from "../agent-context.ts";
import { attempt, openSubagent, setState, showPanelView, trivium, useStore } from "../store.ts";
import { Fanout, FanoutLimit, targetOf } from "./Subagents.tsx";
import { Clamp } from "./Clamp.tsx";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

/** A question is already in the thread; focus it instead of creating another answering surface. */
export function goToQuestion(path: string): void {
	const card = document.querySelector<HTMLElement>(`[data-session-path="${CSS.escape(path)}"] .ask`);
	card?.scrollIntoView({ block: "center", behavior: "smooth" });
	(card?.querySelector<HTMLElement>("input, textarea, button") ?? card)?.focus();
}

/**
 * A persistent way to inspect the current task's children, including after they finish.
 * A question card outranks the children; failures and kept worktrees get attention until seen. While agents simply
 * work, the subagents menu beside it counts them and shows the live dot, so this one doesn't repeat them.
 */
export function AgentsButton({ view, needsYou }: { view: SessionView; needsYou: boolean }) {
	const seen = useStore((s) => s.agentsSeen[view.path]) === agentAttentionKey(view.runs);
	const pressed = useStore((s) => s.panelTab[view.path] === "agents" && s.changesHidden[view.path] === false);
	const taskRuns = taskRunsOf(view.runs);
	const counts = agentCounts(taskRuns);
	const steps = agentSteps(taskRuns);
	const kept = steps.some((step) => step.subagent?.keptWorktrees?.length);
	const failed = steps.flatMap((step) => step.subagent!.children).filter((child) => child.status === "error").length;
	if (!needsYou && !steps.some((step) => step.subagent!.children.length)) return null;
	const label = needsYou
		? t("Needs you")
		: counts.waiting
			? t("{n} waiting", { n: counts.waiting })
			: !seen && kept
				? t("Worktree kept")
				: !seen && failed
					? t("{n} failed", { n: failed })
					: t("View agents");
	const title = needsYou
		? t("The main agent is asking you something.")
		: counts.waiting
			? t(counts.waiting === 1 ? "1 agent is waiting on the main agent." : "{n} agents are waiting on the main agent.", { n: counts.waiting })
			: counts.running
				? t(counts.running === 1 ? "1 agent working. Show it in the panel." : "{n} agents working. Show them in the panel.", { n: counts.running })
				: t("Show subagent details");
	const attention = needsYou || counts.waiting || (!seen && (kept || failed));
	return (
		<button
			type="button"
			className={`changes-toggle agents-toggle${attention ? " attn" : ""}`}
			aria-pressed={pressed}
			title={title}
			onClick={() => (needsYou ? goToQuestion(view.path) : showPanelView(view.path, "agents"))}
		>
			{(needsYou || counts.waiting > 0) && <span className="live-dot attn" aria-hidden="true" />}
			<OrchestrateIcon size={14} />
			<span>{label}</span>
		</button>
	);
}

/** The runs of the current task: everything since the user's latest prompt, including notices that answer it. */
function taskRunsOf(runs: Run[]): Run[] {
	return runs.slice(Math.max(0, runs.findLastIndex((run) => !run.notice)));
}

/**
 * The task's agents at a glance: the plan, one card per fan-out, what the main agent is doing now, patches and kept
 * worktrees. An agent opens as its own session in the drawer beside the thread, as it does from the thread's rows.
 */
export function AgentsBody({ view }: { view: SessionView }) {
	const needsYou = useStore((s) => s.dialogs.some((dialog) => dialog.sessionPath === view.path));
	const now = useNow(view.running ? 1000 : 0);
	const taskRuns = taskRunsOf(view.runs);
	const run = taskRuns[0];
	const phases = agentSteps(taskRuns);
	const children = phases.flatMap((step) => step.subagent!.children);
	const used = children.reduce((sum, child) => sum + (child.tokens ?? 0), 0);
	const time = run?.startedAt ? duration((view.running ? now : (taskRuns.at(-1)?.endedAt ?? now)) - run.startedAt) : "";
	const attention = agentAttentionKey(view.runs);
	useEffect(() => {
		setState((s) => ({ agentsSeen: { ...s.agentsSeen, [view.path]: attention } }));
	}, [view.path, attention]);
	const draft = (text: string) =>
		setState((s) => ({ drafts: { ...s.drafts, [view.path]: { text, attachments: [], append: true } } }));
	return (
		<AgentSession.Provider value={view.path}>
			<div className="agents">
				<Overview
						view={view}
						taskRuns={taskRuns}
						phases={phases}
						children={children}
						now={now}
						time={time}
						used={used}
						needsYou={needsYou}
						onChild={(step, index) => {
							const child = step.subagent?.children[index];
							const target = child && targetOf(child, { step: step.id, index });
							if (target) openSubagent(view.path, target, false);
						}}
					/>
				{phases
					.flatMap((step) => step.subagent?.keptWorktrees ?? [])
					.map((tree) => (
						<KeptWorktree key={tree.path} tree={tree} onDraft={draft} />
					))}
				{taskRuns
					.filter((run) => run.limit)
					.map((run) => (
						<FanoutLimit key={run.id} limit={run.limit!} agents={agentSteps([run]).flatMap((step) => step.subagent!.children)} />
					))}
				<footer className="agents-foot" title={t("Agents work at the same time, so their time adds up to more than the task took.")}>
					{t(children.length === 1 ? "1 agent · {tokens} tokens · {time} · agent time {agentTime}" : "{n} agents · {tokens} tokens · {time} · agent time {agentTime}", {
						n: children.length,
						tokens: tokens(used),
						time,
						agentTime: duration(children.reduce((sum, child) => sum + (child.durationMs ?? 0), 0)),
					})}
				</footer>
			</div>
		</AgentSession.Provider>
	);
}

/** The task's overview: what was asked, the plan, one card per fan-out, and what the main agent is doing now. */
function Overview({
	view,
	taskRuns,
	phases,
	children,
	now,
	time,
	used,
	needsYou,
	onChild,
}: {
	view: SessionView;
	taskRuns: Run[];
	phases: Step[];
	children: SubagentChild[];
	now: number;
	time: string;
	used: number;
	needsYou: boolean;
	onChild: (step: Step, index: number) => void;
}) {
	const run = taskRuns[0];
	const steps = taskRuns.flatMap((run) => run.steps);
	const note = steps.findLast((step) => step.tool === "note");
	// The plan is what the main agent said just before its first fan-out; a task with none has no plan to show.
	const firstFanout = steps.findIndex((step) => (step.subagent?.children.length ?? 0) > 1);
	const plan = firstFanout < 0 ? undefined : steps.slice(0, firstFanout).findLast((step) => step.tool === "note");
	const last = taskRuns.at(-1);
	const current = currentStep(last);
	// Every writer that finished, for the Patches list once the agents are done (§6.5). Applied state is v1.1.
	const writers = phases
		.flatMap((step) => step.subagent!.children.map((child, index) => ({ child, step: step.id, index })))
		.filter(({ child }) => child.role === "mutation" && child.handoff && child.status !== "running" && child.status !== "pending");
	const state = t(
		view.running ? "Working" : taskRuns.at(-1)?.status === "aborted" ? "Stopped" : taskRuns.at(-1)?.status === "error" ? "Failed" : "Done",
	);
	return (
		<>
			<div className="agents-head">
				{/* Announced when the task's state changes. The line below also holds the elapsed time and the tokens, which change every second while it runs, so it is not the live region. */}
				<span className="sr-only" role="status">
					{state}
				</span>
				<h3>{run?.prompt.split("\n")[0] || view.title}</h3>
				<p>
					{t(children.length === 1 ? "{state} · {time} · 1 agent · {tokens} tokens" : "{state} · {time} · {n} agents · {tokens} tokens", {
						state,
						time,
						n: children.length,
						tokens: tokens(used),
					})}
				</p>
			</div>
			{needsYou && (
				<div className="agents-attn">
					<p>{t("The main agent is asking you something.")}</p>
					<button type="button" className="btn ghost" onClick={() => goToQuestion(view.path)}>
						{t("Go to question")}
					</button>
				</div>
			)}
			{plan && (
				<section className="agents-plan">
					<div className="step-detail-label">{t("Plan")}</div>
					<Clamp lines={3}>
						<Markdown text={plan.content ?? plan.target} />
					</Clamp>
				</section>
			)}
			{phases.map((step, index) => (
				<PhaseCard key={step.id} step={step} number={index + 1} now={now} onChild={(child) => onChild(step, child)} />
			))}
			{!phases.length && <p>{t("Subagents appear here when the main agent delegates work.")}</p>}
			{writers.length > 0 && !phases.some((step) => step.status === "running") && <Patches writers={writers} />}
			{view.running && (
				<div className="agents-now">
					<p>{nowLine(last, current)}</p>
					{note && (
						<p className="ellipsis" title={note.content}>
							{note.content ?? note.target}
						</p>
					)}
				</div>
			)}
		</>
	);
}

/**
 * One fan-out in the task. The current one is open; a finished one folds to its summary, which still says how many
 * finished and how long it took. Background children are marked as such in their rows.
 */
function PhaseCard({ step, number, now, onChild }: { step: Step; number: number; now: number; onChild: (index: number) => void }) {
	const children = step.subagent!.children;
	const finished = children.filter((child) => child.status === "done" || child.status === "error" || child.status === "stopped").length;
	const time = duration(step.durationMs ?? (step.startedAt ? now - step.startedAt : undefined));
	return (
		<details className={`agents-phase${step.status === "running" ? "" : " done"}`} open={step.status === "running" || undefined}>
			<summary>
				{t("{n}. {phase} · {finished} of {total} finished · {time}", {
					n: number,
					phase: phaseOf(step.subagent!),
					finished,
					total: children.length,
					time,
				})}
			</summary>
			<Fanout step={step} now={now} onChild={onChild} list />
		</details>
	);
}

/** One line per writer: what its patch holds, or why there is none to look at. Whether it was applied is v1.1. */
function Patches({ writers }: { writers: { child: SubagentChild; step: string; index: number }[] }) {
	return (
		<section className="agents-after">
			<div className="step-detail-label">{t("Patches")}</div>
			<ul className="agents-patches">
				{writers.map(({ child, step, index }) => {
					const patch = child.handoff!;
					return (
						<li key={child.childId ?? `${step}:${index}`}>
							<span className="agents-patch-key ellipsis" title={patch.branch}>
								{child.label || child.agent}
							</span>
							{patch.error ? (
								<span className="warn">{t("Patch couldn't be captured: {error}", { error: patch.error })}</span>
							) : patch.changed ? (
								<span className="mono">
									<span className="plus">+{patch.insertions}</span> <span className="minus">−{patch.deletions}</span>{" "}
									{t(patch.filesChanged === 1 ? "· 1 file" : "· {n} files", { n: patch.filesChanged })}
								</span>
							) : (
								<span>{t("No changes")}</span>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** A worktree the extension could not remove. The host never deletes it; the user can ask the agent to. */
function KeptWorktree({ tree, onDraft }: { tree: { path: string; reason: string }; onDraft: (text: string) => void }) {
	return (
		<div className="fanout-note warn">
			<p>{t("A worktree was kept: {reason}", { reason: tree.reason })}</p>
			<code>{tree.path}</code>
			<div className="agents-actions">
				<button type="button" className="btn ghost" onClick={() => void attempt(() => trivium.copyText(tree.path))}>
					{t("Copy path")}
				</button>
				<button
					type="button"
					className="btn ghost"
					onClick={() => onDraft(t("Clean up the kept worktree at {path} if it's no longer needed.", { path: tree.path }))}
				>
					{t("Ask the agent to clean it up")}
				</button>
			</div>
		</div>
	);
}
