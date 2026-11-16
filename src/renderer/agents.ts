import type { Run, Subagent } from "../shared/protocol.ts";
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
