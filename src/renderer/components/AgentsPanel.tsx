import { useEffect, useRef, useState } from "react";
import type { ChildPatchFile, SessionView } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { useNow } from "../hooks.ts";
import { OrchestrateIcon } from "../icons.tsx";
import { agentAttentionKey, agentCounts, agentSteps, currentStep, phaseOf } from "../agents.ts";
import { AgentSession } from "../agent-context.ts";
import { attempt, setState, showAgentChild, showPanelView, trivium, useStore } from "../store.ts";
import { activity, ChildDetail, childRole, Fanout } from "./Subagents.tsx";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { t } from "../i18n.tsx";

/** A question is already in the thread; focus it instead of creating another answering surface. */
export function goToQuestion(path: string): void {
	const card = document.querySelector<HTMLElement>(`[data-session-path="${CSS.escape(path)}"] .ask`);
	card?.scrollIntoView({ block: "center", behavior: "smooth" });
	(card?.querySelector<HTMLElement>("input, textarea, button") ?? card)?.focus();
}

export function AgentsButton({ view, needsYou }: { view: SessionView; needsYou: boolean }) {
	const seen = useStore((s) => s.agentsSeen[view.path]) === agentAttentionKey(view.runs);
	const pressed = useStore((s) => s.panelTab[view.path] === "agents" && s.changesHidden[view.path] === false);
	const counts = agentCounts(view.runs);
	const steps = view.runs.slice(view.runs.findLastIndex((run) => !run.notice)).flatMap((run) => run.steps).filter((step) => step.subagent);
	const kept = steps.some((step) => step.subagent?.keptWorktrees?.length);
	const failed = steps.flatMap((step) => step.subagent!.children).filter((child) => child.status === "error").length;
	if (!needsYou && !counts.running && (seen || (!kept && !failed))) return null;
	const label = needsYou ? t("Needs you") : counts.waiting ? t("{n} waiting", { n: counts.waiting }) : counts.running ? t(counts.running === 1 ? "{n} agent" : "{n} agents", { n: counts.running }) : kept ? t("Worktree kept") : t("{n} failed", { n: failed });
	const title = needsYou ? t("The main agent is asking you something.") : counts.waiting ? t("{n} agents are waiting on the main agent.", { n: counts.waiting }) : counts.running ? t("{n} agents working. Show them in the panel.", { n: counts.running }) : label;
	return <button type="button" className={`changes-toggle agents-toggle${needsYou || counts.waiting || kept || failed ? " attn" : ""}`} aria-pressed={pressed} title={title}
		onClick={() => needsYou ? goToQuestion(view.path) : showPanelView(view.path, "agents")}>
		<span className={`live-dot${needsYou || counts.waiting ? " attn" : ""}`} aria-hidden="true" /><OrchestrateIcon size={14} /><span>{label}</span>
	</button>;
}

/** Overview and drill-in reuse the thread's child data and the existing diff renderer. All actions compose drafts. */
export function AgentsBody({ view }: { view: SessionView }) {
	const selected = useStore((s) => s.agentDetail[view.path]);
	const needsYou = useStore((s) => s.dialogs.some((dialog) => dialog.sessionPath === view.path));
	const now = useNow(view.running ? 1000 : 0);
	const body = useRef<HTMLDivElement>(null);
	const scroll = useRef(0);
	const returnTo = useRef<{ step: string; child: number } | undefined>(undefined);
	const start = Math.max(0, view.runs.findLastIndex((run) => !run.notice));
	const taskRuns = view.runs.slice(start);
	const run = taskRuns[0];
	const steps = taskRuns.flatMap((run) => run.steps);
	const phases = agentSteps(taskRuns);
	const selectedStep = phases.find((step) => step.id === selected?.step);
	const child = selectedStep?.subagent?.children[selected?.child ?? -1];
	const children = phases.flatMap((step) => step.subagent!.children);
	const used = children.reduce((sum, child) => sum + (child.tokens ?? 0), 0);
	const time = run?.startedAt ? duration((view.running ? now : taskRuns.at(-1)?.endedAt ?? now) - run.startedAt) : "";
	const [patch, setPatch] = useState<{ id: string; files: ChildPatchFile[]; error?: string }>();
	const [file, setFile] = useState<string>();
	const patchId = child?.handoff?.id;
	const attention = agentAttentionKey(view.runs);
	const back = () => setState((s) => ({ agentDetail: { ...s.agentDetail, [view.path]: undefined } }));
	useEffect(() => {
		setState((s) => ({ agentsSeen: { ...s.agentsSeen, [view.path]: attention } }));
	}, [view.path, attention]);
	useEffect(() => {
		if (!child) {
			if (body.current) body.current.scrollTop = scroll.current;
			const target = returnTo.current;
			const row = target && body.current?.querySelector<HTMLButtonElement>(`[data-agent-step="${CSS.escape(target.step)}"][data-agent-child="${target.child}"]`);
			const disclosure = row?.closest("details");
			if (disclosure) disclosure.open = true;
			row?.focus({ preventScroll: true });
			return;
		}
		returnTo.current = selected;
		body.current?.scrollTo(0, 0);
		body.current?.querySelector<HTMLButtonElement>(".agents-back")?.focus();
		const key = (event: KeyboardEvent) => {
			if ((event.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
			if (event.key === "Escape" || event.key === "Backspace" || (event.altKey && event.key === "ArrowLeft")) { event.preventDefault(); back(); }
		};
		// On the tab itself, not the document: these keys belong to whatever else has the focus, such as the thread.
		const tab = body.current;
		tab?.addEventListener("keydown", key);
		return () => tab?.removeEventListener("keydown", key);
	}, [Boolean(child), view.path]);
	useEffect(() => {
		let active = true;
		setFile(undefined);
		if (patchId) trivium.subagentPatch(view.path, patchId).then(
			(files) => active && setPatch({ id: patchId, files }),
			(error: unknown) => active && setPatch({ id: patchId, files: [], error: String(error) }),
		);
		return () => { active = false; };
	}, [view.path, patchId]);
	const draft = (text: string) => setState((s) => ({ drafts: { ...s.drafts, [view.path]: { text, attachments: [], append: true } } }));
	const files = patch && patch.id === patchId ? patch.files : [];
	const shown = files.find((item) => item.file === file) ?? files[0];
	const note = steps.findLast((step) => step.tool === "note");
	// The plan is what the main agent said just before its first fan-out; a task with none has no plan to show.
	const firstFanout = steps.findIndex((step) => (step.subagent?.children.length ?? 0) > 1);
	const plan = firstFanout < 0 ? undefined : steps.slice(0, firstFanout).findLast((step) => step.tool === "note");
	const current = currentStep(taskRuns.at(-1));
	const counts = agentCounts(taskRuns);
	const doing = current?.subagent && counts.running ? t("Waiting for {n} agents", { n: counts.running }) : current ? `${current.tool} ${current.target}` : t(taskRuns.at(-1)?.answer ? "Writing the answer" : "Working");
	const state = t(view.running ? "Working" : taskRuns.at(-1)?.status === "aborted" ? "Stopped" : taskRuns.at(-1)?.status === "error" ? "Failed" : "Done");
	return <AgentSession.Provider value={view.path}><div className="agents" ref={body}>
		{child ? <>
			<button type="button" className="btn ghost agents-back" onClick={back}>{t("‹ All agents")}</button>
			<h3>{child.label || child.agent}</h3>
			<p className={`subagent-activity ${activity(child).tone}`}>{activity(child).text}</p>
			<p className="subagent-usage">{childRole(child)} {child.handoff?.branch && <><code>{child.handoff.branch}</code> <button type="button" className="btn ghost" onClick={() => void attempt(() => trivium.copyText(child.handoff!.branch))}>{t("Copy branch")}</button></>}</p>
			<ChildDetail child={child} heading />
			{child.handoff && <section className="agents-changes">
				<div className="step-detail-label">{t("Changes")}</div>
				{child.handoff.error && <p className="fanout-note warn">{t("Patch couldn't be captured: {error}", { error: child.handoff.error })}</p>}
				<div className="agents-files">{files.map((item) => <button type="button" key={item.file} aria-pressed={shown?.file === item.file} onClick={() => setFile(item.file)}><span className="mono ellipsis">{item.file}</span><span><span className="plus">+{item.adds}</span> <span className="minus">−{item.dels}</span></span></button>)}</div>
				{patch && patch.id === patchId && patch.error && <p className="subagent-error">{patch.error}</p>}
				{shown && <div className="diff-scroll"><DiffView lines={shown.lines} tooLarge={shown.tooLarge} empty={t(shown.binary ? "Binary file" : "No changes")} /></div>}
			</section>}
			<div className="agents-actions">
				<button type="button" className="btn ghost" onClick={() => draft(t("About {label} ({agent}): ", { label: child.label || child.agent, agent: child.agent }))}>{t("Ask about this")}</button>
				{child.role === "mutation" && <button type="button" className="btn ghost" onClick={() => draft(t("Don't apply the {label} patch: ", { label: child.label || child.agent }))}>{t("Don't apply this")}</button>}
				{child.handoff && <button type="button" className="btn ghost" onClick={() => void attempt(() => trivium.copyText(child.handoff!.path))}>{t("Copy patch path")}</button>}
			</div>
		</> : <>
			<div className="agents-head" role="status"><h3>{run?.prompt.split("\n")[0] || view.title}</h3><p>{t("{state} · {time} · {n} agents · {tokens} tokens", { state, time, n: children.length, tokens: tokens(used) })}</p></div>
			{needsYou && <div className="agents-attn"><p>{t("The main agent is asking you something.")}</p><button type="button" className="btn ghost" onClick={() => goToQuestion(view.path)}>{t("Go to question")}</button></div>}
			{plan && <section className="agents-plan"><div className="step-detail-label">{t("Plan")}</div><Markdown text={plan.content ?? plan.target} /></section>}
			{phases.map((step, index) => <details className="agents-phase" key={step.id} open={step.status === "running" || undefined}>
				<summary>{t("{n}. {phase} · {agents} agents · {state}", { n: index + 1, phase: phaseOf(step.subagent!), agents: step.subagent!.children.length, state: t(step.status === "running" ? "Working" : step.status === "error" ? "Failed" : "Done") })}</summary>
				<Fanout step={step} now={now} onChild={(index) => { scroll.current = body.current?.scrollTop ?? 0; showAgentChild(view.path, step.id, index); }} />
			</details>)}
			{!phases.length && <p>{t("Subagents appear here when the main agent delegates work.")}</p>}
			{view.running && <div className="agents-now"><p>{t("Now: {activity}", { activity: doing })}</p>{note && <p className="ellipsis" title={note.content}>{note.content ?? note.target}</p>}</div>}
		</>}
		{phases.flatMap((step) => step.subagent?.keptWorktrees ?? []).map((tree) => <div className="fanout-note warn" key={tree.path}><p>{t("A worktree was kept: {reason}", { reason: tree.reason })}</p><code>{tree.path}</code><div className="agents-actions"><button type="button" className="btn ghost" onClick={() => void attempt(() => trivium.copyText(tree.path))}>{t("Copy path")}</button><button type="button" className="btn ghost" onClick={() => draft(t("Clean up the kept worktree at {path} if it's no longer needed.", { path: tree.path }))}>{t("Ask the agent to clean it up")}</button></div></div>)}
		{taskRuns.filter((run) => run.limit).map((run) => <div className="run-error limit" key={run.id}><p>{run.limit!.message}</p>{run.limit!.link && <a href={run.limit!.link.url} target="_blank" rel="noreferrer">{run.limit!.link.label}</a>}</div>)}
		<footer className="agents-foot" title={t("Agents work at the same time, so their time adds up to more than the task took.")}>{t("{n} agents · {tokens} tokens · {time} · agent time {agentTime}", { n: children.length, tokens: tokens(used), time, agentTime: duration(children.reduce((sum, child) => sum + (child.durationMs ?? 0), 0)) })}</footer>
	</div></AgentSession.Provider>;
}
