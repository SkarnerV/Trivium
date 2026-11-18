import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppId } from "../shared/protocol.ts";
import type { BackgroundRuns } from "./background-runs.ts";
import type { ChangeTracker } from "./changes.ts";
import type { HandoffCache } from "./handoffs.ts";
import { launchesSubagents } from "./subagents.ts";

/** The ids a completion notice names. pi-subagents 0.82.1 sends `details.runs[]`, each with the launch's `runId`. */
export function noticeRunIds(details: unknown): string[] {
	const value = (details && typeof details === "object" ? details : {}) as { id?: unknown; asyncId?: unknown; runId?: unknown; runs?: unknown };
	const runs = Array.isArray(value.runs) ? value.runs.map((run) => (run && typeof run === "object" ? (run as { runId?: unknown }).runId : undefined)) : [];
	return [...new Set([value.id, value.asyncId, value.runId, ...runs].filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * What the host does around the main agent's tool calls so the Changes panel knows what this session changed,
 * subagents included. It runs after the permission gate, so a project is snapshotted only for a call that runs.
 *
 * - A command that may write: snapshot before it, adopt what changed after it.
 * - A subagent launch (Code only): snapshot before it. A foreground launch adopts when its tool call ends. A background
 *   launch ends its tool call at once, so it opens a window in `background` instead, which adopts and closes when the
 *   run's notice arrives, its status shows it ended, or the window's time runs out (see background-runs.ts).
 */
export function delegationHooks(options: {
	app: AppId;
	changes: Pick<ChangeTracker, "beforeCommand" | "afterCommand" | "beforeSubagents">;
	handoffs: Pick<HandoffCache, "capture">;
	background: Pick<BackgroundRuns, "launched" | "finished">;
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
			if (app === "code" && launchesSubagents(event.toolName, event.input as Record<string, unknown>)) {
				delegated.add(event.toolCallId);
				await changes.beforeSubagents();
				return;
			}
			if (!options.changing(event)) return;
			snapshotted.add(event.toolCallId);
			await changes.beforeCommand();
		});
		pi.on("tool_result", async (event) => {
			if (event.toolName === "subagent") await handoffs.capture(event.details);
			if (delegated.delete(event.toolCallId)) {
				const details = event.details as { asyncId?: unknown; asyncDir?: unknown } | undefined;
				if (typeof details?.asyncId === "string") background.launched(details.asyncId, typeof details.asyncDir === "string" ? details.asyncDir : undefined);
				else await options.afterSubagents();
				await options.onChanges().catch(() => {});
			}
			if (!snapshotted.delete(event.toolCallId)) return;
			if (await changes.afterCommand()) await options.onChanges().catch(() => {});
		});
		pi.on("message_end", async (event) => {
			if (event.message.role !== "custom" || event.message.customType !== "subagent-notify") return;
			const details = event.message.details;
			await handoffs.capture(details);
			await background.finished(noticeRunIds(details));
			await options.onNotice().catch(() => {});
		});
	};
}
