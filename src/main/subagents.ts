import type { Step, Subagent, SubagentChild, SubagentLane, SubagentNotice } from "../shared/protocol.ts";
import { basename, dirname, join } from "node:path";
import { commandNotice } from "./long-commands.ts";

/**
 * Reads what pi-subagents reports about its children: the `subagent` tool's details while it runs and
 * when it ends, and the `subagent-notify` message a background child sends when it finishes. Only the
 * fields Trivium shows are read, and each one is checked, since the package may change its details.
 */

interface ToolCallLike {
	tool?: unknown;
	args?: unknown;
	endMs?: unknown;
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
	failedTool?: unknown;
}

interface ResultLike {
	timedOut?: unknown;
	outputPartial?: unknown;
	index?: unknown;
	agent?: unknown;
	task?: unknown;
	workflowKey?: unknown;
	/** A workflow child's own run, whose folder holds its session; the call's run id names the workflow. */
	runId?: unknown;
	sessionFile?: unknown;
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
	workflowChildren?: unknown;
	preflight?: unknown;
	workflowGraph?: unknown;
	workflow?: unknown;
	parallelHandoff?: unknown;
	usageBudget?: unknown;
	terminalOutcome?: unknown;
	results?: unknown;
	progress?: unknown;
	runId?: unknown;
	asyncId?: unknown;
	asyncDir?: unknown;
	background?: unknown;
}

/** Details are extension-owned JSON, including nested objects that may be missing or malformed. */
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function lanesOf(value: unknown): SubagentLane[] {
	return list<Record<string, unknown>>(record(value).lanes).filter((lane) => typeof lane.key === "string").map((lane) => ({
		key: str(lane.key),
		mode: ["mutation", "review", "scout", "gate"].includes(str(lane.mode)) ? lane.mode as SubagentLane["mode"] : undefined,
		claims: Array.isArray(lane.claims) ? lane.claims.filter((item): item is string => typeof item === "string") : undefined,
		decision: str(lane.decision) || undefined,
		expectedOutput: str(lane.expectedOutput) || undefined,
		independence: str(lane.independence) || undefined,
	}));
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

/**
 * Where pi-subagents writes a child's session while it runs: beside the parent's session file, in a folder
 * named after it, then the run and the child's place in it. The finished result names the file itself.
 */
export function childSessionFile(parentSessionFile: string | undefined, runId: string, index: number): string | undefined {
	if (!parentSessionFile || !/^[\w.-]+$/.test(runId)) return undefined;
	return join(dirname(parentSessionFile), basename(parentSessionFile, ".jsonl"), runId, `run-${index}`, "session.jsonl");
}

function child(result: ResultLike | undefined, progress: ProgressLike | undefined, toolStatus: Step["status"], sessionFile?: string): SubagentChild {
	const summary = result?.progressSummary;
	const status = childStatus(progress, result, toolStatus);
	const recent = list<ToolCallLike>(progress?.recentTools ?? summary?.recentTools);
	const steps = recent.length
		? recent.map((call) => ({ tool: str(call.tool), target: str(call.args), ...(num(call.endMs) !== undefined ? { endMs: num(call.endMs) } : {}) }))
		: list<{ text?: unknown }>(result?.toolCalls).map((call) => splitCall(str(call.text)));
	const currentTool = str(progress?.currentTool);
	const usage = result?.usage;
	const usageTokens = (num(usage?.input) ?? 0) + (num(usage?.output) ?? 0);
	const context = str(result?.context);
	return {
		timedOut: result?.timedOut === true || undefined,
		outputPartial: result?.outputPartial === true || undefined,
		failedTool: status === "error" ? str(progress?.failedTool) || str(summary?.failedTool) || undefined : undefined,
		inputTokens: num(usage?.input), outputTokens: num(usage?.output),
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
		sessionFile: str(result?.sessionFile) || sessionFile,
	};
}

/** The children a `subagent` call started, from its arguments until its details say more. */
export function subagentOf(args: Record<string, unknown>, details: unknown, toolStatus: Step["status"], parentSessionFile?: string): Subagent {
	const info = (details && typeof details === "object" ? details : {}) as DetailsLike;
	const background = typeof info.asyncId === "string" || info.background === true;
	const results = list<ResultLike>(info.results);
	const progress = list<ProgressLike>(info.progress);
	const count = Math.max(results.length, progress.length);
	const runId = str(info.runId) || str(info.asyncId);
	const children: SubagentChild[] = [];
	for (let index = 0; index < count; index++) {
		const result = results.find((item) => item.index === index) ?? results[index];
		const live = result?.progress ?? progress.find((item) => item.index === index) ?? progress[index];
		const position = num(result?.index) ?? num(live?.index) ?? index;
		const own = str(result?.runId);
		children.push(child(result, live, toolStatus, own ? childSessionFile(parentSessionFile, own, 0) : childSessionFile(parentSessionFile, runId, position)));
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
			status: background ? "running" : toolStatus === "done" ? "done" : toolStatus === "error" ? "error" : "running",
			steps: [],
			tools: 0,
			sessionFile: childSessionFile(parentSessionFile, runId, 0),
		});
	}
	const lanes = lanesOf(info.preflight ?? record(args.options).preflight);
	const workflow = list<Record<string, unknown>>(record(info.workflowChildren).children).filter((item) => typeof item.childId === "string");
	if (workflow.length || lanes.length) {
		const ordered = [...lanes.map((lane) => lane.key), ...workflow.map((item) => str(item.childId)), ...children.map((item) => item.label).filter((key): key is string => Boolean(key))];
		const merged: SubagentChild[] = [];
		for (const key of new Set(ordered)) {
			const live = workflow.find((item) => item.childId === key);
			const lane = lanes.find((item) => item.key === key);
			const position = lanes.length ? lanes.findIndex((lane) => lane.key === key) : workflow.findIndex((item) => item.childId === key);
			const existing = children.find((item) => item.label === key) ?? (position >= 0 && !children[position]?.label ? children[position] : undefined);
			const activity = record(live?.activity);
			const state = str(live?.state);
			const status = state === "completed" ? "done" : state === "failed" || state === "rejected" ? "error" : state === "stopped" ? "stopped" : state === "pending" ? "pending" : ["running", "paused", "detached"].includes(state) ? "running" : undefined;
			merged.push({
				...(existing ?? { agent: str(live?.agent) || "agent", task: "", status: "pending", steps: [], tools: 0 }),
				childId: key, label: key, role: lane?.mode,
				agent: str(live?.agent) || existing?.agent || "agent",
				status: status ?? existing?.status ?? "pending",
				waitingOn: state === "paused" || activity.currentTool === "contact_supervisor" ? "main" : undefined,
				current: typeof activity.currentTool === "string" ? { tool: activity.currentTool, target: "" } : existing?.current,
				tools: num(activity.toolCount) ?? existing?.tools ?? 0,
				tokens: num(activity.tokens) ?? existing?.tokens,
				inputTokens: num(activity.inputTokens) ?? existing?.inputTokens, outputTokens: num(activity.outputTokens) ?? existing?.outputTokens,
				durationMs: num(activity.durationMs) ?? existing?.durationMs,
				model: str(live?.model) || existing?.model,
				// A workflow child runs as a run of its own, so its session sits in that run's first folder.
				sessionFile: existing?.sessionFile ?? childSessionFile(parentSessionFile, str(live?.runId), 0),
			});
		}
		for (const existing of children) {
			if (!existing.label && !merged.some((item) => item.steps === existing.steps)) merged.push(existing);
		}
		children.splice(0, children.length, ...merged);
	}
	// pi-subagents reports no per-child wait for a concurrency slot; it reports a whole workflow that waits as queued.
	const queued = record(info.workflowChildren).workflowState === "queued";
	const trace = list<Record<string, unknown>>(record(info.workflow).trace);
	for (const item of children) {
		const completed = trace.findLast((entry) => entry.operation === "run" && entry.key === item.label && num(entry.durationMs) !== undefined);
		item.durationMs ??= num(completed?.durationMs);
		if (queued && item.status === "pending") item.queued = true;
		if (args.worktree === true) item.worktree = true;
		if (toolStatus === "error" && item.status === "running" && !background) item.status = "stopped";
		if (item.current?.tool === "contact_supervisor") item.waitingOn = "main";
		item.role ??= /^(worker|delegate)$|writer$/.test(item.agent) ? "mutation" : item.agent === "reviewer" ? "review" : item.agent === "scout" ? "scout" : undefined;
	}
	const phases = list<Record<string, unknown>>(record(info.workflowGraph).phases).map((phase) => str(phase.title)).filter(Boolean);
	return {
		children, background,
		...(typeof info.asyncId === "string" ? { asyncId: info.asyncId } : {}),
		...(typeof info.asyncDir === "string" ? { asyncDir: info.asyncDir } : {}),
		...(lanes.length ? { preflight: { lanes } } : {}),
		...(phases.length ? { phases } : {}),
		...(typeof record(info.parallelHandoff).path === "string" ? { handoffPath: str(record(info.parallelHandoff).path) } : {}),
		...(record(info.usageBudget).exhausted === true || record(info.terminalOutcome).reason === "budget_exhausted" ? { budgetExhausted: true } : {}),
	};
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
	if (message.role !== "custom" || message.customType !== "subagent-notify") return commandNotice(message);
	const content = typeof message.content === "string"
		? message.content
		: list<{ type?: unknown; text?: unknown }>(message.content).map((part) => str(part.text)).join("\n");
	const runs = list<{ agent?: unknown; status?: unknown; durationMs?: unknown; runId?: unknown }>((message.details as { runs?: unknown } | undefined)?.runs);
	// The first line reads "Background task completed: **scout**", which also covers notices without details.
	const header = /^(?:Background task|Detached foreground task) (completed|failed|paused|stopped): \*\*(.+?)\*\*/.exec(content);
	const agents = [...new Set(runs.map((run) => str(run.agent)).filter(Boolean))];
	const statuses = runs.map((run) => str(run.status));
	const status = (statuses.find((item) => item !== "completed") || header?.[1] || "completed") as SubagentNotice["status"];
	const lines = content.split("\n").slice(header ? 1 : 0);
	// A workflow's receipt sits right under the header, before the result.
	while (lines.length && (!lines[0]!.trim() || lines[0]!.startsWith("Workflow receipt: "))) lines.shift();
	const end = lines.findIndex((line) => TRAILER.test(line));
	const sessionFile = /^Session(?: file)?: (.+\.jsonl)\s*$/m.exec(content)?.[1];
	const durations = runs.map((run) => num(run.durationMs)).filter((value) => value !== undefined);
	return {
		...(runs.some((run) => typeof run.runId === "string") ? { runId: str(runs[0]?.runId) || undefined, runIds: runs.map((run) => str(run.runId)).filter(Boolean) } : {}),
		agent: agents.join(", ") || header?.[2] || "subagent",
		status: ["completed", "failed", "paused", "stopped"].includes(status) ? status : "completed",
		durationMs: durations.length ? Math.max(...durations) : undefined,
		text: (end < 0 ? lines : lines.slice(0, end)).join("\n").trim(),
		sessionFile,
	};
}

/**
 * A subagent session's thinking level, as it last set it, and how full its model's context was at its latest response,
 * as a whole percent. `contextWindow` looks a model up; one it doesn't know leaves the percent out.
 */
export function sessionUsage(
	entries: readonly unknown[],
	contextWindow: (provider: string, model: string) => number | undefined,
): { thinking?: string; context?: number } {
	let thinking: string | undefined;
	let context: number | undefined;
	for (const item of entries) {
		const entry = item as { type?: string; thinkingLevel?: unknown; message?: unknown };
		if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinking = entry.thinkingLevel;
		const message = entry.type === "message" ? (entry.message as { role?: string; provider?: string; model?: string; usage?: Record<string, unknown> }) : undefined;
		if (message?.role !== "assistant" || !message.usage || !message.provider || !message.model) continue;
		const num = (value: unknown) => (typeof value === "number" ? value : 0);
		const usage = message.usage;
		const used = num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
		const window = contextWindow(message.provider, message.model);
		if (used && window) context = Math.min(100, Math.round((used / window) * 100));
	}
	return { thinking: thinking && thinking !== "off" ? thinking : undefined, context };
}
