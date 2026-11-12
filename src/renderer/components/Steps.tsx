import { Fragment, useState } from "react";
import type { Run, Step } from "../../shared/protocol.ts";
import { duration } from "../format.ts";
import { useNow } from "../hooks.ts";
import { Chevron, EyeIcon } from "../icons.tsx";
import { usePreviewOpener } from "../preview.ts";
import { ImageTile } from "./ImageTile.tsx";
import { Markdown } from "./Markdown.tsx";
import { SubagentDetail, SubagentLive, SubagentTarget } from "./Subagents.tsx";
import { t } from "../i18n.tsx";
import { blocksOf } from "../timeline.ts";

/** What the agent is doing in a step, said as it happens: "Reading", "Running", "Thinking". */
const VERBS: Record<string, string> = {
	read: "Reading",
	edit: "Editing",
	write: "Writing",
	bash: "Running",
	grep: "Searching for",
	find: "Finding",
	ls: "Listing",
	think: "Thinking",
};

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
				<span className="live-cmd-label">{VERBS[step.tool] ? t(VERBS[step.tool]!) : t("Using {tool}", { tool: step.tool })}</span>
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

function StepRow({ step, now, preview }: { step: Step; now: number; preview: ReturnType<typeof usePreviewOpener> }) {
	const time =
		step.durationMs !== undefined ? duration(step.durationMs) : step.status === "running" && step.startedAt ? duration(now - step.startedAt) : "";
	const tone = step.status === "error" ? "error" : step.status === "running" ? "running" : step.tone;
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
						<SubagentDetail subagent={step.subagent} />
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
		</li>
	);
}

/**
 * A run as it happened: what the agent said along the way, in full, with the steps it took between folded
 * into groups. A run it worked through without a word is one group, opened from the line that times it.
 */
export function Steps({ run, live }: { run: Run; live: boolean }) {
	const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
	const preview = usePreviewOpener();
	const now = useNow(live ? 1000 : 0);
	const blocks = blocksOf(run.steps);
	if (!blocks.length && !live) return null;
	const groups = blocks.filter((block) => block.kind === "steps");
	const steps = groups.flatMap((group) => group.steps);
	const end = live ? now : run.endedAt;
	const total = run.startedAt && end ? duration(end - run.startedAt) : "";
	const count = steps.length;
	// A failed command or tool would otherwise only show once the steps are open.
	const failed = failedIn(steps);
	// Size the tool column to the longest tool name so targets line up, in every group alike.
	const toolWidth = Math.max(36, ...steps.map((step) => step.tool.length * 7.3 + 2));
	// Once the answer is coming in, it shows what is happening on its own.
	const current = live && !run.answer ? (steps.findLast((step) => step.status === "running") ?? steps.at(-1)) : undefined;
	// Among several groups, one step is shown as it is: "1 step" would hide it and take the same room.
	const folds = (group: { steps: Step[] }) => groups.length === 1 || group.steps.length > 1;
	const foldable = groups.filter(folds);
	const allOpen = foldable.length > 0 && foldable.every((group) => opened.has(group.id));
	const toggle = (id: string) =>
		setOpened((before) => {
			const next = new Set(before);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	return (
		<>
			{/* With several groups, each opens on its own and this line opens or closes them all. */}
			<button type="button" className="steps-toggle" aria-expanded={allOpen} onClick={() => setOpened(allOpen ? new Set() : new Set(foldable.map((group) => group.id)))}>
				<span>
					<strong className={live ? "shimmer" : undefined}>{t(live ? "Working" : run.status === "aborted" ? "Stopped" : "Worked")}</strong>
					{total && ` ${t("for {time}", { time: total })}`}
				</span>
				{count > 0 && <span>· {t(count === 1 ? "{n} step" : "{n} steps", { n: count })}</span>}
				{failed > 0 && <span className="steps-failed">· {t("{n} failed", { n: failed })}</span>}
				{foldable.length > 0 && <Chevron open={allOpen} />}
			</button>
			{blocks.map((block) => {
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
									<StepRow key={step.id} step={step} now={now} preview={preview} />
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
