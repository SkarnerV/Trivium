import type { Run, Step, SubagentChild } from "./protocol.ts";

/**
 * How many children are running or waiting now. The main process counts with it for the sidebar of a session that
 * is not on screen, and the renderer for the pane header and an open session's sidebar row, so both agree.
 */
export function agentCounts(runs: Run[] = []): { running: number; waiting: number } {
	const children = agentSteps(runs)
		.filter((step) => step.status !== "error")
		.flatMap((step) => step.subagent?.children ?? []);
	return {
		running: children.filter((child) => child.status === "running" || child.status === "pending").length,
		waiting: children.filter((child) => child.waitingOn === "main").length,
	};
}

const NOTICE_STATUS: Record<string, SubagentChild["status"]> = { completed: "done", stopped: "stopped", paused: "stopped" };
const BACKGROUND_STATUS: Record<string, SubagentChild["status"]> = { done: "done", error: "error", stopped: "stopped", gone: "stopped" };

/**
 * Every fan-out step, with a background launch's children shown as they ended: from the completion notice whose
 * run ids name the launch, or, with no notice, from what the host read of the run (`backgroundState`). A launch the
 * host found no evidence of life for is not running any more, even though its result never arrived. Pairing for
 * display never changes the stored launch.
 */
export function agentSteps(runs: Run[]): Step[] {
	const notices = runs.flatMap((run) => run.notice?.runIds?.map((id) => ({ id, notice: run.notice! })) ?? []);
	return runs
		.flatMap((run) => run.steps)
		.filter((step) => step.subagent)
		.map((step) => {
			const subagent = step.subagent!;
			const notice = notices.find((item) => item.id === subagent.asyncId)?.notice;
			if (notice) {
				const status = NOTICE_STATUS[notice.status] ?? "error";
				return {
					...step,
					subagent: {
						...subagent,
						children: subagent.children.map((child) => ({ ...child, status, output: notice.text, durationMs: notice.durationMs })),
					},
				};
			}
			const ended = subagent.background && subagent.backgroundState ? BACKGROUND_STATUS[subagent.backgroundState] : undefined;
			if (!ended) return step;
			const unreported = subagent.backgroundState === "gone";
			return {
				...step,
				subagent: {
					...subagent,
					children: subagent.children.map((child) => ({
						...child,
						status: ended,
						current: undefined,
						...(unreported ? { unreported: true } : {}),
					})),
				},
			};
		});
}
