import { useState } from "react";
import type { Run, Step } from "../../shared/protocol.ts";
import { duration } from "../format.ts";
import { useNow } from "../hooks.ts";
import { Chevron } from "../icons.tsx";
import { ImageTile } from "./ImageTile.tsx";
import { Markdown } from "./Markdown.tsx";
import { SubagentDetail, SubagentLive, SubagentTarget } from "./Subagents.tsx";

/** What the agent is doing in a step, said as it happens: "Reading", "Running", "Thinking". A note is its own words. */
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
	const prose = step.tool === "think" || step.tool === "note";
	const time = running && step.startedAt ? duration(now - step.startedAt) : "";
	return (
		<div className={`live-cmd${running ? "" : " idle"}`}>
			<div className="live-cmd-head">
				<span className="live-dot" />
				{step.tool !== "note" && <span className="live-cmd-label">{VERBS[step.tool] ?? `Using ${step.tool}`}</span>}
				{prose ? (
					<span className="live-cmd-prose ellipsis">{step.target}</span>
				) : (
					<code className="ellipsis" title={step.target}>
						{step.target}
					</code>
				)}
				<span className="live-cmd-time">{time}</span>
			</div>
			{/* Only the latest line: enough to see it is moving. The full output is in the step. */}
			{step.tool === "bash" && running && <div className="live-cmd-out ellipsis">{lastLine(step.tail) || "\u00a0"}</div>}
		</div>
	);
}

function lastLine(text: string | undefined): string {
	return text?.split("\n").findLast((line) => line.trim())?.trim() ?? "";
}

export function Steps({ run, live }: { run: Run; live: boolean }) {
	const [open, setOpen] = useState(false);
	const now = useNow(live ? 1000 : 0);
	if (!run.steps.length && !live) return null;
	const end = live ? now : run.endedAt;
	const total = run.startedAt && end ? duration(end - run.startedAt) : "";
	const count = run.steps.length;
	// A failed command or tool would otherwise only show once the steps are open.
	const failed = run.steps.filter((step) => step.status === "error" || step.tone === "error").length;
	// Size the tool column to the longest tool name so targets line up.
	const toolWidth = Math.max(36, ...run.steps.map((step) => step.tool.length * 7.3 + 2));
	// Once the answer is coming in, it shows what is happening on its own.
	const current = live && !run.answer ? (run.steps.findLast((step) => step.status === "running") ?? run.steps.at(-1)) : undefined;
	return (
		<>
			<button type="button" className="steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
				{live && <span className="run-dot" />}
				<span>
					<strong>{live ? "Working" : run.status === "aborted" ? "Stopped" : "Worked"}</strong>
					{total && ` for ${total}`}
				</span>
				{count > 0 && <span>· {count} {count === 1 ? "step" : "steps"}</span>}
				{failed > 0 && <span className="steps-failed">· {failed} failed</span>}
				{count > 0 && <Chevron open={open} />}
			</button>
			{open && count > 0 && (
				<ol className="steps" style={{ ["--tool-w" as string]: `${toolWidth}px` }}>
					{run.steps.map((step) => {
						const time =
							step.durationMs !== undefined
								? duration(step.durationMs)
								: step.status === "running" && step.startedAt
									? duration(now - step.startedAt)
									: "";
						const tone = step.status === "error" ? "error" : step.status === "running" ? "running" : step.tone;
						return (
							<li key={step.id} className={`step ${tone}`}>
								<details>
									<summary className="step-summary" title={step.target}>
										<span className="mark" aria-hidden="true" />
										<span className="tool">{step.tool}</span>
										{step.subagent ? (
											<SubagentTarget subagent={step.subagent} fallback={step.target} />
										) : (
											<span className={`target ellipsis${step.tool === "think" || step.tool === "note" ? " prose" : ""}`}>
												{step.target}
											</span>
										)}
										<span className="meta">{step.meta}</span>
										<span className="time">{time}</span>
										<span className="step-chevron"><Chevron open={false} /></span>
									</summary>
									<div className="step-detail">
										{step.subagent ? (
											<SubagentDetail subagent={step.subagent} />
										) : step.tool === "think" || step.tool === "note" ? (
											<Markdown text={step.content ?? step.target} />
										) : (
											<>
												<div className="step-detail-label">Input</div>
												<pre>{step.input ?? step.target}</pre>
												<div className="step-detail-label">Output</div>
												{step.images?.length ? (
													<div className="step-images">
														{step.images.map((image) => (
															<ImageTile key={image.id} image={image} size="large" />
														))}
													</div>
												) : null}
												{/* Beside an image, a one-line result like "Read image file [image/png]" says nothing new. */}
												{!(step.images?.length && !step.output?.includes("\n")) && (
													<pre>{step.output || step.tail || (step.status === "running" ? "Waiting for output…" : "No text output.")}</pre>
												)}
											</>
										)}
									</div>
								</details>
							</li>
						);
					})}
				</ol>
			)}
			{current && <LiveStep step={current} now={now} />}
		</>
	);
}
