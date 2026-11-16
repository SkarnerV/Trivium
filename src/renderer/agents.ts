import type { Run, Subagent, SubagentChild } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { agentSteps } from "../shared/agent-counts.ts";

export { agentCounts, agentSteps } from "../shared/agent-counts.ts";

/** Opening the panel acknowledges the state seen, not failures that may arrive in a later phase. */
export function agentAttentionKey(runs: Run[]): string {
	const current = runs.slice(Math.max(0, runs.findLastIndex((run) => !run.notice)));
	return agentSteps(current).map((step) => `${step.id}:${step.status}:${step.subagent!.children.map((child) => child.status).join(",")}:${step.subagent!.keptWorktrees?.length ?? 0}`).join("|");
}

export function phaseOf(subagent: Subagent): string {
	const roles = subagent.children.map((child) => child.role);
	if (roles.includes("mutation")) return t("Implementing");
	if (roles.length && roles.every((role) => role === "review")) return t("Reviewing");
	if (roles.length && roles.every((role) => role === "scout")) return t("Scouting");
	if (roles.includes("gate")) return t("Checking");
	if (subagent.children.every((child) => child.agent === "researcher")) return t("Researching");
	if (subagent.children.every((child) => child.agent === "oracle")) return t("Consulting");
	return t("Delegating");
}

/** The same current step is used by the thread and the Agents tab's factual Now line. */
export function currentStep(run: Run | undefined) {
	if (!run || run.status !== "running" || run.answer) return undefined;
	const steps = run.steps.filter((step) => step.tool !== "note");
	return steps.findLast((step) => step.status === "running") ?? steps.at(-1);
}

/** What kind of agent a child is, for counting: a writer by its lane's mode, a reader by its lane or its name. */
function kindOf(child: SubagentChild): "worktree" | "writer" | "reviewer" | "scout" | "researcher" | "checker" | "agent" {
	if (child.role === "mutation") return child.worktree ? "worktree" : "writer";
	if (child.role === "review" || child.agent === "reviewer") return "reviewer";
	if (child.role === "scout" || child.agent === "scout") return "scout";
	if (child.role === "gate") return "checker";
	if (child.agent === "researcher") return "researcher";
	return "agent";
}

/** Each kind as its own singular and plural keys, so a translation never has to agree a count with a noun it can't see. */
export const KINDS: Record<ReturnType<typeof kindOf>, [string, string]> = {
	worktree: ["{n} writer in its own worktree", "{n} writers in their own worktrees"],
	writer: ["{n} writer", "{n} writers"],
	reviewer: ["{n} reviewer", "{n} reviewers"],
	scout: ["{n} scout", "{n} scouts"],
	researcher: ["{n} researcher", "{n} researchers"],
	checker: ["{n} checker", "{n} checkers"],
	agent: ["{n} agent", "{n} agents"],
};

/** "a, b" in the reader's language: a list of counts or paths, not a sentence. */
export function listOf(items: string[]): string {
	return items.join(t(", "));
}

/**
 * Who a fan-out sent, by kind: "2 writers in their own worktrees, 1 reviewer", or "1 writer" for the default single
 * writer in the project folder. `places: false` leaves where writers work out, for the finished step's one line.
 */
export function teamOf(children: SubagentChild[], places = true): string {
	const counts = new Map<string, number>();
	for (const child of children) {
		let kind = kindOf(child);
		if (!places && kind === "worktree") kind = "writer";
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const order = Object.keys(KINDS) as (keyof typeof KINDS)[];
	return listOf(order.filter((kind) => counts.has(kind)).map((kind) => {
		const n = counts.get(kind)!;
		return t(KINDS[kind][n === 1 ? 0 : 1], { n });
	}));
}

/** A lane's claimed files: two of them at most, then how many more. */
export function claimsOf(claims: string[], shown = 2): string {
	const head = claims.slice(0, shown);
	return listOf(claims.length > shown ? [...head, t("+{n} more", { n: claims.length - shown })] : head);
}

/** The one word a row's mark stands for, for screen readers and titles. */
export function stateWord(child: SubagentChild): string {
	if (child.timedOut) return t("Timed out");
	if (child.waitingOn === "main") return t("Waiting");
	switch (child.status) {
		case "pending":
			return t(child.queued ? "Queued" : "Starting");
		case "running":
			return t("Running");
		case "done":
			return t("Done");
		case "error":
			return t("Failed");
		case "stopped":
			return t("Stopped");
	}
}

/** Keeps both ends of a long name, such as a branch, whose end tells it apart from its siblings. */
export function middle(text: string, max = 40): string {
	if (text.length <= max) return text;
	const tail = Math.ceil((max - 1) / 2);
	return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}
