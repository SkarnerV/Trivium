import { Fragment, useContext, useEffect, useState } from "react";
import { AgentSession } from "../agent-context.ts";
import type { LimitNotice, Run, Step } from "../../shared/protocol.ts";
import { duration } from "../format.ts";
import { useNow } from "../hooks.ts";
import { Chevron, EyeIcon } from "../icons.tsx";
import { usePreviewOpener } from "../preview.ts";
import { ImageTile } from "./ImageTile.tsx";
import { Markdown } from "./Markdown.tsx";
import { FanoutLimit, SubagentDetail, SubagentLive, SubagentTarget } from "./Subagents.tsx";
import { t } from "../i18n.tsx";
import { blocksOf } from "../timeline.ts";
import { currentStep } from "../agents.ts";
import { liveVerb } from "../verbs.ts";


/**
 * The step under way, or the last one while the agent decides what to do next. It stays until the next
 * step starts, so quick reads and edits do not flash by. Commands also show their latest line of output.
 */
function LiveStep({ step, now }: { step: Step; now: number }) {
	if (step.subagent) return <SubagentLive step={step} now={now} />;
	const running = step.status === "running";
	const prose = step.tool === "think";
	const time = running && step.startedAt ? duration(now - step.startedAt) : "";
	return (
		<div className={`live-cmd${running ? "" : " idle"}`}>
			<div className="live-cmd-head">
				<span className="live-dot" />
				<span className="live-cmd-label">{liveVerb(step)}</span>
				{prose ? (
					<span className="live-cmd-prose ellipsis">{step.target}</span>
				) : (
					<code className="ellipsis" title={step.target}>
						{step.target}
					</code>
				)}
				<span className="live-cmd-time">{time}</span>
			</div>
			{/* Only the latest line: enough to see it is moving. The full output is in the step. Until the
			    command prints something, the line says so rather than sitting empty. */}
			{step.tool === "bash" && running && <div className="live-cmd-out ellipsis">{lastLine(step.tail) || t("Waiting for output…")}</div>}
		</div>
	);
}

function lastLine(text: string | undefined): string {
	return text?.split("\n").findLast((line) => line.trim())?.trim() ?? "";
}

/** Steps whose target is a file the agent read or wrote. */
const FILE_TOOLS = new Set(["read", "edit", "write"]);


const failedIn = (steps: Step[]) => steps.filter((step) => step.status === "error" || step.tone === "error").length;

function StepRow({ step, now, preview, limit }: { step: Step; now: number; preview: ReturnType<typeof usePreviewOpener>; limit?: LimitNotice }) {
	const time =
		step.durationMs !== undefined ? duration(step.durationMs) : step.status === "running" && step.startedAt ? duration(now - step.startedAt) : "";
	const tone = step.status === "error" ? "error" : step.status === "running" ? "running" : step.tone;
	// Worktrees, the Agents tab and the project folder are Code's; Research and Write show the steps alone.
	const code = Boolean(useContext(AgentSession));
	return (
		<li className={`step ${tone}`}>
			<details>
				<summary className="step-summary" title={step.target}>
					<span className="mark" aria-hidden="true" />
					<span className="tool">{step.tool}</span>
					{step.subagent ? (
						<SubagentTarget subagent={step.subagent} fallback={step.target} />
					) : (
						<span className={`target ellipsis${step.tool === "think" ? " prose" : ""}`}>{step.target}</span>
					)}
					<span className="meta">
						{preview && FILE_TOOLS.has(step.tool) && step.target && step.status !== "error" && (
							<button
								type="button"
								className="step-preview"
								aria-label={t("Preview {file}", { file: step.target })}
								title={t("Preview")}
								onClick={(event) => {
									// Inside the step's summary: open the file, not the step.
									event.preventDefault();
									preview(step.target);
								}}
							>
								<EyeIcon size={13} />
							</button>
						)}
						{step.meta}
					</span>
					<span className="time">{time}</span>
					<span className="step-chevron"><Chevron open={false} /></span>
				</summary>
				<div className="step-detail">
					{step.subagent ? (
						<SubagentDetail subagent={step.subagent} stepId={step.id} />
					) : step.tool === "think" ? (
						<Markdown text={step.content ?? step.target} />
					) : (
						<>
							<div className="step-detail-label">{t("Input")}</div>
							<pre>{step.input ?? step.target}</pre>
							<div className="step-detail-label">{t("Output")}</div>
							{step.images?.length ? (
								<div className="step-images">
									{step.images.map((image) => (
										<ImageTile key={image.id} image={image} size="large" />
									))}
								</div>
							) : null}
							{/* Beside an image, a one-line result like "Read image file [image/png]" says nothing new. */}
							{!(step.images?.length && !step.output?.includes("\n")) && (
								<pre>{step.output || step.tail || t(step.status === "running" ? "Waiting for output…" : "No text output.")}</pre>
							)}
						</>
					)}
				</div>
			</details>
			{code && step.subagent && Boolean(step.subagent.keptWorktrees?.length) && (
				<p className="fanout-note warn">
					{t(step.subagent.keptWorktrees!.length === 1 ? "1 worktree was kept. See the Agents tab for its path and reason." : "{n} worktrees were kept. See the Agents tab for their paths and reasons.", {
						n: step.subagent.keptWorktrees!.length,
					})}
				</p>
			)}
			{/* The run hit a usage limit during this fan-out: what that meant for its agents (§8.8, run level). */}
			{limit && step.subagent && <FanoutLimit limit={limit} agents={step.subagent.children} />}
			{code &&
				step.subagent?.preflight &&
				step.status === "error" &&
				step.subagent.children.every((child) => child.status === "pending") &&
				/uncommitted|clean git working tree/i.test(step.output ?? "") && (
					<p className="fanout-note warn">
						{t(
							"Not started: the project folder has uncommitted changes, and separate worktrees need a clean folder. The main agent will use one writer or ask you.",
						)}
					</p>
				)}
		</li>
	);
}

/**
 * A run as it happened, with tool calls grouped between progress notes. Once the answer is finished,
 * the whole history folds into the line that times it.
 */
export function Steps({ run, live }: { run: Run; live: boolean }) {
	const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
	const [expanded, setExpanded] = useState(false);
	useEffect(() => setExpanded(false), [live]);
	const preview = usePreviewOpener();
	const now = useNow(live ? 1000 : 0);
	const blocks = blocksOf(run.steps);
	if (!blocks.length && !live) return null;
	const groups = blocks.filter((block) => block.kind === "steps");
	const steps = groups.flatMap((group) => group.steps);
	const end = live ? now : run.endedAt;
	const total = run.startedAt && end ? duration(end - run.startedAt) : "";
	const count = steps.length;
	const agents = steps.reduce((sum, step) => sum + (step.subagent?.children.length ?? 0), 0);
	// A failed command or tool would otherwise only show once the steps are open.
	const failed = failedIn(steps);
	// Size the tool column to the longest tool name so targets line up, in every group alike.
	const toolWidth = Math.max(36, ...steps.map((step) => step.tool.length * 7.3 + 2));
	// Once the answer is coming in, it shows what is happening on its own.
	const current = live ? currentStep(run) : undefined;
	// Among several groups, one step is shown as it is: "1 step" would hide it and take the same room.
	const folds = (group: { steps: Step[] }) => groups.length === 1 || group.steps.length > 1;
	const foldable = groups.filter(folds);
	const allOpen = foldable.length > 0 && foldable.every((group) => opened.has(group.id));
	const finished = !live && Boolean(run.answer);
	// A usage limit that ended the run is told against the fan-out it cut short, its last one.
	const limitedFanout = run.limit ? steps.findLast((step) => (step.subagent?.children.length ?? 0) > 1)?.id : undefined;
	const toggle = (id: string) =>
		setOpened((before) => {
			const next = new Set(before);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	return (
		<>
			{/* After the answer, this line also folds the progress notes away. */}
			<button
				type="button"
				className="steps-toggle"
				aria-expanded={finished ? expanded : allOpen}
				onClick={() => {
					if (finished) setExpanded(!expanded);
					setOpened(!finished && allOpen ? new Set() : new Set(foldable.map((group) => group.id)));
				}}
			>
				<span>
					<strong className={live ? "shimmer" : undefined}>{t(live ? "Working" : run.status === "aborted" ? "Stopped" : "Worked")}</strong>
					{total && ` ${t("for {time}", { time: total })}`}
				</span>
				{count > 0 && <span>· {t(count === 1 ? "{n} step" : "{n} steps", { n: count })}</span>}
				{agents > 0 && <span>· {t(agents === 1 ? "{n} agent" : "{n} agents", { n: agents })}</span>}
				{failed > 0 && <span className="steps-failed">· {t("{n} failed", { n: failed })}</span>}
				{(finished || foldable.length > 0) && <Chevron open={finished ? expanded : allOpen} />}
			</button>
			{(!finished || expanded) && blocks.map((block) => {
				if (block.kind === "note") {
					return (
						<div key={block.id} className="answer">
							<Markdown text={block.text} diagrams />
						</div>
					);
				}
				const open = !folds(block) || opened.has(block.id);
				const groupFailed = failedIn(block.steps);
				return (
					<Fragment key={block.id}>
						{groups.length > 1 && folds(block) && (
							<button type="button" className="steps-toggle steps-group" aria-expanded={open} onClick={() => toggle(block.id)}>
								<span>{t(block.steps.length === 1 ? "{n} step" : "{n} steps", { n: block.steps.length })}</span>
								{groupFailed > 0 && <span className="steps-failed">· {t("{n} failed", { n: groupFailed })}</span>}
								<Chevron open={open} />
							</button>
						)}
						{open && (
							<ol className="steps" style={{ ["--tool-w" as string]: `${toolWidth}px` }}>
								{block.steps.map((step) => (
									<StepRow key={step.id} step={step} now={now} preview={preview} limit={step.id === limitedFanout ? run.limit : undefined} />
								))}
							</ol>
						)}
					</Fragment>
				);
			})}
			{current && <LiveStep step={current} now={now} />}
		</>
	);
}
