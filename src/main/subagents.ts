import type { Step, Subagent, SubagentChild, SubagentNotice } from "../shared/protocol.ts";

/**
 * Reads what pi-subagents reports about its children: the `subagent` tool's details while it runs and
 * when it ends, and the `subagent-notify` message a background child sends when it finishes. Only the
 * fields Trivium shows are read, and each one is checked, since the package may change its details.
 */

interface ToolCallLike {
	tool?: unknown;
	args?: unknown;
}

interface ProgressLike {
	index?: unknown;
	agent?: unknown;
	task?: unknown;
	status?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	recentTools?: unknown;
	toolCount?: unknown;
	tokens?: unknown;
	durationMs?: unknown;
	model?: unknown;
	error?: unknown;
}

interface ResultLike {
	index?: unknown;
	agent?: unknown;
	task?: unknown;
	workflowKey?: unknown;
	exitCode?: unknown;
	error?: unknown;
	finalOutput?: unknown;
	model?: unknown;
	context?: unknown;
	usage?: { input?: unknown; output?: unknown };
	progress?: ProgressLike;
	progressSummary?: ProgressLike;
	toolCalls?: unknown;
}

interface DetailsLike {
	results?: unknown;
	progress?: unknown;
	asyncId?: unknown;
	background?: unknown;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as T[]) : [];
}

/** A management call such as `{ action: "status" }` reads like any other tool; only launches get the subagent look. */
export function launchesSubagents(name: string, args: Record<string, unknown>): boolean {
	return name === "subagent" && !args.action && (typeof args.agent === "string" || args.workflow !== undefined);
}

/** "read src/auth.ts" as pi-subagents summarizes a finished call, split into tool and target. */
function splitCall(text: string): { tool: string; target: string } {
	const [tool = "", ...rest] = text.trim().split(/\s+/);
	return { tool, target: rest.join(" ") };
}

function childStatus(progress: ProgressLike | undefined, result: ResultLike | undefined, toolStatus: Step["status"]): SubagentChild["status"] {
	const reported = str(progress?.status);
	if (reported === "failed") return "error";
	if (reported === "completed") return "done";
	if (toolStatus === "running") return reported === "pending" ? "pending" : "running";
	// The call has ended, so a child it still calls running was cut short or detached.
	const exitCode = num(result?.exitCode);
	return result?.error || (exitCode !== undefined && exitCode !== 0) || toolStatus === "error" ? "error" : "done";
}

function child(result: ResultLike | undefined, progress: ProgressLike | undefined, toolStatus: Step["status"]): SubagentChild {
	const summary = result?.progressSummary;
	const status = childStatus(progress, result, toolStatus);
	const recent = list<ToolCallLike>(progress?.recentTools ?? summary?.recentTools);
	const steps = recent.length
		? recent.map((call) => ({ tool: str(call.tool), target: str(call.args) }))
		: list<{ text?: unknown }>(result?.toolCalls).map((call) => splitCall(str(call.text)));
	const currentTool = str(progress?.currentTool);
	const usage = result?.usage;
	const usageTokens = (num(usage?.input) ?? 0) + (num(usage?.output) ?? 0);
	const context = str(result?.context);
	return {
		agent: str(result?.agent) || str(progress?.agent) || "agent",
		task: str(result?.task) || str(progress?.task),
		label: str(result?.workflowKey) || undefined,
		status,
		current: status === "running" && currentTool ? { tool: currentTool, target: str(progress?.currentToolArgs) } : undefined,
		steps,
		tools: num(progress?.toolCount) ?? num(summary?.toolCount) ?? steps.length,
		tokens: num(progress?.tokens) ?? num(summary?.tokens) ?? (usageTokens || undefined),
		durationMs: num(progress?.durationMs) ?? num(summary?.durationMs),
		model: str(result?.model) || str(progress?.model) || undefined,
		context: context === "fresh" || context === "fork" ? context : undefined,
		output: status === "running" ? undefined : str(result?.finalOutput) || undefined,
		error: status === "error" ? str(result?.error) || str(progress?.error) || undefined : undefined,
	};
}

/** The children a `subagent` call started, from its arguments until its details say more. */
export function subagentOf(args: Record<string, unknown>, details: unknown, toolStatus: Step["status"]): Subagent {
	const info = (details && typeof details === "object" ? details : {}) as DetailsLike;
	const background = typeof info.asyncId === "string" || info.background === true;
	const results = list<ResultLike>(info.results);
	const progress = list<ProgressLike>(info.progress);
	const count = Math.max(results.length, progress.length);
	const children: SubagentChild[] = [];
	for (let index = 0; index < count; index++) {
		const result = results.find((item) => item.index === index) ?? results[index];
		const live = result?.progress ?? progress.find((item) => item.index === index) ?? progress[index];
		children.push(child(result, live, toolStatus));
	}
	// A single child's progress may leave out what the call already said.
	if (children.length === 1 && typeof args.agent === "string") {
		children[0]!.task ||= str(args.task);
		if (children[0]!.agent === "agent") children[0]!.agent = args.agent;
	}
	if (!children.length && typeof args.agent === "string") {
		children.push({
			agent: args.agent,
			task: str(args.task),
			status: background || toolStatus === "done" ? "done" : toolStatus === "error" ? "error" : "running",
			steps: [],
			tools: 0,
		});
	}
	return { children, background };
}

function firstLine(text: string, max = 140): string {
	const line = text.split("\n").find((part) => part.trim())?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The step's one-line summary: the task, and how many tools the children used. */
export function describeSubagent(subagent: Subagent, args: Record<string, unknown>, status: Step["status"]): Pick<Step, "target" | "meta" | "tone"> {
	const { children } = subagent;
	const only = children.length === 1 ? children[0] : undefined;
	const target = only
		? `${only.agent}: ${firstLine(only.task, 120)}`
		: children.length
			? `${children.length} agents: ${[...new Set(children.map((item) => item.agent))].join(", ")}`
			: typeof args.workflow === "string"
				? `workflow ${args.workflow}`
				: "workflow";
	if (subagent.background) return { target, meta: status === "error" ? "failed" : "background", tone: status === "error" ? "error" : "plain" };
	const failed = children.filter((item) => item.status === "error").length;
	if (status === "error" || failed) {
		return { target, meta: children.length > 1 && failed ? `${failed} failed` : "failed", tone: "error" };
	}
	const tools = children.reduce((sum, item) => sum + item.tools, 0);
	return { target, meta: tools ? `${tools} ${tools === 1 ? "tool" : "tools"}` : "", tone: "plain" };
}

/** Lines pi-subagents adds after the result for the model's sake: where the run lives and what to do next. */
const TRAILER = /^(Parent action|Session|Session file|Session share error|Retention-managed async directory|Workflow run|Workflow receipt|Child runs|Parallel handoff|Reconciled detached child): /;

/** A background child's result, or undefined for any other message. */
export function noticeOf(message: { role?: unknown; customType?: unknown; content?: unknown; details?: unknown }): SubagentNotice | undefined {
	if (message.role !== "custom" || message.customType !== "subagent-notify") return undefined;
	const content = typeof message.content === "string"
		? message.content
		: list<{ type?: unknown; text?: unknown }>(message.content).map((part) => str(part.text)).join("\n");
	const runs = list<{ agent?: unknown; status?: unknown; durationMs?: unknown }>((message.details as { runs?: unknown } | undefined)?.runs);
	// The first line reads "Background task completed: **scout**", which also covers notices without details.
	const header = /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*/.exec(content);
	const agents = [...new Set(runs.map((run) => str(run.agent)).filter(Boolean))];
	const statuses = runs.map((run) => str(run.status));
	const status = (statuses.find((item) => item !== "completed") || header?.[1] || "completed") as SubagentNotice["status"];
	const lines = content.split("\n").slice(header ? 1 : 0);
	// A workflow's receipt sits right under the header, before the result.
	while (lines.length && (!lines[0]!.trim() || lines[0]!.startsWith("Workflow receipt: "))) lines.shift();
	const end = lines.findIndex((line) => TRAILER.test(line));
	const durations = runs.map((run) => num(run.durationMs)).filter((value) => value !== undefined);
	return {
		agent: agents.join(", ") || header?.[2] || "subagent",
		status: ["completed", "failed", "paused", "stopped"].includes(status) ? status : "completed",
		durationMs: durations.length ? Math.max(...durations) : undefined,
		text: (end < 0 ? lines : lines.slice(0, end)).join("\n").trim(),
	};
}
