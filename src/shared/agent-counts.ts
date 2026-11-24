import type { BackgroundState, Run, Step, SubagentChild, SubagentNotice } from "./protocol.ts";

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

/** A child's question to the main agent, and what became of it. */
export interface SupervisorQuestion {
	notice: SubagentNotice;
	/** The main agent's answer, once it reached the child. */
	reply?: string;
	/** The child still waits: nothing answered it, it asked nothing since, and its run has not ended. */
	waiting: boolean;
}

/**
 * Every question the session's children asked, by request id. Waiting is read from the request and what followed it:
 * the reply that names it, a reply refused because it had expired, a later question from the same child, or the end
 * of its run.
 */
export function supervisorQuestions(runs: Run[]): Map<string, SupervisorQuestion> {
	const questions = new Map<string, SupervisorQuestion>();
	const close = (match: (request: NonNullable<SubagentNotice["request"]>) => boolean) => {
		for (const question of questions.values()) if (match(question.notice.request!)) question.waiting = false;
	};
	for (const run of runs) {
		const { notice } = run;
		const asked = notice?.request;
		if (asked) {
			close((request) => request.runId === asked.runId && request.childIndex === asked.childIndex);
			questions.set(asked.id, { notice: notice!, waiting: true });
		} else if (notice?.runIds) close((request) => notice.runIds!.includes(request.runId));
		for (const step of run.steps) {
			const question = step.reply && step.status !== "running" ? questions.get(step.reply.request) : undefined;
			if (!question) continue;
			question.waiting = false;
			if (step.status === "done") question.reply = step.reply!.message;
		}
	}
	return questions;
}

const NOTICE_STATUS: Record<string, SubagentChild["status"]> = { completed: "done", stopped: "stopped", paused: "stopped" };
const BACKGROUND_STATUS: Record<string, SubagentChild["status"]> = { done: "done", error: "error", stopped: "stopped", gone: "stopped" };

/** A child as its run ended, from what the host read of it: the run is all there is to go by. */
export function endedAs(child: SubagentChild, state: BackgroundState | undefined): SubagentChild {
	const status = state && BACKGROUND_STATUS[state];
	return status ? { ...child, status, current: undefined, ...(state === "gone" ? { unreported: true } : {}) } : child;
}

/**
 * Every fan-out step, with a background launch's children shown as they ended: from the completion notice whose
 * run ids name the launch, or, with no notice, from what the host read of the run (`backgroundState`). A launch the
 * host found no evidence of life for is not running any more, even though its result never arrived. A notice that a
 * run paused does not end it while the host still sees it live: a child of it may be waiting for an answer. Pairing
 * for display never changes the stored launch.
 */
export function agentSteps(runs: Run[]): Step[] {
	const notices = runs.flatMap((run) => run.notice?.runIds?.map((id) => ({ id, notice: run.notice! })) ?? []);
	const questions = [...supervisorQuestions(runs).values()].filter((question) => question.waiting);
	const told = (id: string | undefined) => (id ? notices.findLast((item) => item.id === id)?.notice : undefined);
	const reported = (child: SubagentChild, notice: SubagentNotice): SubagentChild => ({
		...child,
		status: NOTICE_STATUS[notice.status] ?? "error",
		current: undefined,
		output: notice.text,
		durationMs: notice.durationMs,
	});
	/** A child whose question has no answer yet. The question is what it is doing. */
	const asking = (step: Step): Step => {
		const subagent = step.subagent!;
		let found = false;
		const children = subagent.children.map((child, index) => {
			if (child.status !== "running") return child;
			const question = questions.find(({ notice: { request } }) =>
				child.runId ? request!.runId === child.runId : request!.runId === subagent.asyncId && (subagent.children.length === 1 || request!.childIndex === index),
			);
			if (!question) return child;
			found = true;
			return { ...child, waitingOn: "main" as const, current: { tool: "contact_supervisor", target: question.notice.text } };
		});
		return found ? { ...step, subagent: { ...subagent, children } } : step;
	};
	return runs
		.flatMap((run) => run.steps)
		.filter((step) => step.subagent)
		.map((step) => {
			const subagent = step.subagent!;
			const notice = told(subagent.asyncId);
			if (notice && !(notice.status === "paused" && subagent.backgroundState === "running")) {
				return { ...step, subagent: { ...subagent, children: subagent.children.map((child) => reported(child, notice)) } };
			}
			if (subagent.background && subagent.backgroundState && subagent.backgroundState !== "running") {
				return { ...step, subagent: { ...subagent, children: subagent.children.map((child) => endedAs(child, subagent.backgroundState)) } };
			}
			// Left running by a call that ended: each child has its own notice.
			const own = subagent.children.map((child) => (child.detached ? told(child.runId) : undefined));
			if (!own.some(Boolean)) return asking(step);
			return asking({ ...step, subagent: { ...subagent, children: subagent.children.map((child, index) => (own[index] ? reported(child, own[index]!) : child)) } });
		});
}
