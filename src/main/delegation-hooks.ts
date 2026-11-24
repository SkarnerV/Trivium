import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppId } from "../shared/protocol.ts";
import type { BackgroundRuns } from "./background-runs.ts";
import type { ChangeTracker } from "./changes.ts";
import type { HandoffCache } from "./handoffs.ts";
import { detachedRuns, launchesSubagents, SUPERVISOR_REQUEST } from "./subagents.ts";
import { startsChild, writerOf } from "./writer-lock.ts";

/** The ids a completion notice names. pi-subagents 0.82.1 sends `details.runs[]`, each with the launch's `runId`. */
export function noticeRunIds(details: unknown): string[] {
	const value = (details && typeof details === "object" ? details : {}) as { id?: unknown; asyncId?: unknown; runId?: unknown; runs?: unknown };
	const runs = Array.isArray(value.runs) ? value.runs.map((run) => (run && typeof run === "object" ? (run as { runId?: unknown }).runId : undefined)) : [];
	return [...new Set([value.id, value.asyncId, value.runId, ...runs].filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** How each run a completion notice names ended, as the notice says. */
export function noticeStatuses(details: unknown): Map<string, string> {
	const { runs } = (details && typeof details === "object" ? details : {}) as { runs?: unknown };
	return new Map(
		(Array.isArray(runs) ? runs : []).flatMap((run: { runId?: unknown; status?: unknown } | null) =>
			run && typeof run.runId === "string" && typeof run.status === "string" ? [[run.runId, run.status] as const] : [],
		),
	);
}

/**
 * What the host does around the main agent's tool calls so the Changes panel knows what this session changed,
 * subagents included. It runs after the permission gate, so a project is snapshotted only for a call that runs.
 *
 * - A command that may write: snapshot before it, adopt what changed after it.
 * - A subagent result: capture the patches its children handed back, and tell the main agent which it may take in.
 *   A shell command naming the run of a writer whose patch could not be matched to it does not run.
 * - A subagent launch (Code only): snapshot before it. A foreground launch adopts when its tool call ends. A background
 *   launch ends its tool call at once, so it opens a window in `background` instead, which adopts and closes when the
 *   run's notice arrives, its status shows it ended, or the window's time runs out (see background-runs.ts). A
 *   foreground child that asks its supervisor something is left running when its call ends: it opens one too.
 */
export function delegationHooks(options: {
	app: AppId;
	changes: Pick<ChangeTracker, "beforeCommand" | "afterCommand" | "beforeSubagents">;
	handoffs: Pick<HandoffCache, "capture"> & Partial<Pick<HandoffCache, "report" | "refusal">>;
	background: Pick<BackgroundRuns, "launched" | "finished"> & Partial<Pick<BackgroundRuns, "detached">>;
	changing: (event: { toolName: string; input: unknown }) => boolean;
	/** The foreground launch ended; adopt and show what its children changed. */
	afterSubagents: () => Promise<unknown>;
	onChanges: () => Promise<unknown>;
	onNotice: () => Promise<unknown>;
}) {
	const { app, changes, handoffs, background } = options;
	return (pi: ExtensionAPI) => {
		const snapshotted = new Set<string>();
		const delegated = new Set<string>();
		pi.on("tool_call", async (event) => {
			const input = event.input as Record<string, unknown>;
			// A resumed run edits as a new one does, though it shows as a management call.
			if (app === "code" && (launchesSubagents(event.toolName, input) || (startsChild(event.toolName, input) && input.action === "resume"))) {
				delegated.add(event.toolCallId);
				await changes.beforeSubagents();
				return;
			}
			if (!options.changing(event)) return;
			const refusal = handoffs.refusal?.(String((event.input as { command?: unknown }).command ?? ""));
			if (refusal) return { block: true, reason: refusal };
			snapshotted.add(event.toolCallId);
			await changes.beforeCommand();
		});
		pi.on("tool_result", async (event, ctx) => {
			let report: string | undefined;
			if (event.toolName === "subagent") {
				await handoffs.capture(event.details, { input: (event.input ?? {}) as Record<string, unknown>, cwd: ctx?.cwd ?? "" });
				report = handoffs.report?.(event.details);
			}
			if (delegated.delete(event.toolCallId)) {
				const details = event.details as { asyncId?: unknown; asyncDir?: unknown } | undefined;
				const left = background.detached ? detachedRuns(details) : [];
				const writer = writerOf(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx?.cwd ?? "");
				if (typeof details?.asyncId === "string") background.launched(details.asyncId, typeof details.asyncDir === "string" ? details.asyncDir : undefined, writer);
				else if (left.length) {
					for (const [index, run] of left.entries()) {
						// One window is open already, from the launch; each further child holds one of its own.
						if (index) await changes.beforeSubagents();
						background.detached!(run.runId, run.timeoutMs, writer);
					}
				} else await options.afterSubagents();
				await options.onChanges().catch(() => {});
			}
			if (snapshotted.delete(event.toolCallId) && (await changes.afterCommand())) await options.onChanges().catch(() => {});
			return report ? { content: [...(event.content ?? []), { type: "text" as const, text: report }] } : undefined;
		});
		pi.on("message_end", async (event) => {
			if (event.message.role !== "custom") return;
			// A child began waiting for an answer, which shows on its row and in the session's counts.
			if (event.message.customType === SUPERVISOR_REQUEST) await options.onNotice().catch(() => {});
			if (event.message.customType !== "subagent-notify") return;
			const details = event.message.details;
			await handoffs.capture(details, { input: {}, cwd: "" });
			await background.finished(noticeRunIds(details), noticeStatuses(details));
			await options.onNotice().catch(() => {});
		});
	};
}
