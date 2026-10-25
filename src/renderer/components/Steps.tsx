import { useState } from "react";
import type { Run } from "../../shared/protocol.ts";
import { duration } from "../format.ts";
import { useNow } from "../hooks.ts";
import { Chevron } from "../icons.tsx";

export function Steps({ run, live }: { run: Run; live: boolean }) {
	const [open, setOpen] = useState(false);
	const now = useNow(live ? 1000 : 0);
	if (!run.steps.length && !live) return null;
	const end = live ? now : run.endedAt;
	const total = run.startedAt && end ? duration(end - run.startedAt) : "";
	const count = run.steps.length;
	// Size the tool column to the longest tool name so targets line up.
	const toolWidth = Math.max(36, ...run.steps.map((step) => step.tool.length * 7.3 + 2));
	const runningBash = live ? run.steps.find((step) => step.status === "running" && step.tool === "bash") : undefined;
	return (
		<>
			<button type="button" className="steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
				{live && <span className="run-dot" />}
				<span>
					<strong>{live ? "Working" : run.status === "aborted" ? "Stopped" : "Worked"}</strong>
					{total && ` for ${total}`}
				</span>
				{count > 0 && <span>· {count} {count === 1 ? "step" : "steps"}</span>}
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
							<li key={step.id} className={`step ${tone}`} title={step.target}>
								<span className="mark" aria-hidden="true" />
								<span className="tool">{step.tool}</span>
								<span className={`target ellipsis${step.tool === "think" || step.tool === "note" ? " prose" : ""}`}>
									{step.target}
								</span>
								<span className="meta">{step.meta}</span>
								<span className="time">{time}</span>
							</li>
						);
					})}
				</ol>
			)}
			{runningBash && (
				<div className="terminal">
					<div className="terminal-head">
						<span className="live-dot" />
						<span className="cmd ellipsis">{runningBash.target}</span>
						<span className="mono" style={{ marginLeft: "auto" }}>
							{runningBash.startedAt ? duration(now - runningBash.startedAt) : ""}
						</span>
					</div>
					{runningBash.tail && <pre>{runningBash.tail}</pre>}
				</div>
			)}
		</>
	);
}
