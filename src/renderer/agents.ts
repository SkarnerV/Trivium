import type { Run, SubagentNotice } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";

export { agentCounts, agentSteps, supervisorQuestions } from "../shared/agent-counts.ts";

const NOTICE_WORDS: Record<SubagentNotice["status"], string> = { completed: "Reported done", failed: "Failed", paused: "Paused", stopped: "Stopped", waiting: "Waiting" };

/**
 * How a notice says its run ended. A subagent's is its own report, which nothing here has checked; a command's is the
 * exit code the host saw.
 */
export function noticeWord(notice: Pick<SubagentNotice, "status" | "command">): string {
	return t(notice.command !== undefined && notice.status === "completed" ? "Finished" : NOTICE_WORDS[notice.status]);
}

/** The step the thread's live line shows: the latest running one, until the answer starts coming in. */
export function currentStep(run: Run | undefined) {
	if (!run || run.status !== "running" || run.answer) return undefined;
	const steps = run.steps.filter((step) => step.tool !== "note");
	return steps.findLast((step) => step.status === "running") ?? steps.at(-1);
}

/** "a, b" in the reader's language: a list of counts or paths, not a sentence. */
export function listOf(items: string[]): string {
	return items.join(t(", "));
}

/** A lane's claimed files: two of them at most, then how many more. */
export function claimsOf(claims: string[], shown = 2): string {
	const head = claims.slice(0, shown);
	return listOf(claims.length > shown ? [...head, t("+{n} more", { n: claims.length - shown })] : head);
}
