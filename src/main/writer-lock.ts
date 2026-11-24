import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PermissionModeId } from "../shared/permissions.ts";
import type { BackgroundRuns } from "./background-runs.ts";
import { answersTo, customAgents, subagentAction, subagentFields } from "./subagent-commands.ts";
import { launchesSubagents } from "./subagents.ts";

/**
 * One writer at a time, in Orchestrator mode. The prompt asks for it; this keeps it. While a child that may write is
 * at work, a second one is refused, and so are the main agent's own edits, writes and shell commands that do more
 * than read: two writers in one folder overwrite each other, and neither's checks mean anything.
 *
 * Reading, read-only commands, scouts and answering a child stay open. Whether a writer lives is not kept here: a call
 * that has not returned holds the lock, and after that the run does, for as long as there is evidence it is going
 * (background-runs.ts). So a run that completes, is stopped or crashes releases it, and a session that is opened again
 * holds it only for a run that still lives.
 */

/** pi-subagents 0.82.1's own agents that only read, by name and alias (its `agents/` folder). Any other may write. */
const READERS = new Set(["scout", "reviewer", "researcher", "oracle", "advisor", "evidence-auditor"]);

/** Actions that start a child, or have one started later, from something this call does not show. */
const STARTS = new Set(["resume", "schedule.create", "schedule.run", "schedule.run-due", "schedule.resume"]);

/** Whether a `subagent` call starts a child of any kind. */
export function startsChild(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "subagent") return false;
	const action = subagentAction(input);
	if (action) return STARTS.has(action);
	return launchesSubagents(toolName, input) || ["agent", "workflow", "tasks", "chain"].some((name) => subagentFields(input, name).length > 0);
}

/**
 * Who would write, when a call may start a writer: the agent's name, or what stands in for one. A workflow picks its
 * own agents and a resumed run is whatever it was, so both may; so may an agent by a reader's name that the project
 * or the user defined anew.
 */
export function writerOf(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (!startsChild(toolName, input)) return undefined;
	const action = subagentAction(input);
	if (action) return `the run that ${action} starts`;
	if (["workflow", "tasks", "chain"].some((name) => subagentFields(input, name).length > 0)) return "a workflow";
	const agent = subagentFields(input, "agent").find((value): value is string => typeof value === "string")?.trim() ?? "";
	if (!READERS.has(agent)) return agent || "an unnamed agent";
	const [folder] = subagentFields(input, "cwd");
	const base = typeof folder === "string" && folder.trim() ? resolve(cwd, folder.trim()) : cwd;
	return customAgents(base).some((each) => answersTo(each, agent)) ? agent : undefined;
}

/** Runs before everything else that hears a tool call: a call it refuses is not asked about, recorded or snapshotted. */
export function writerLock(options: {
	/** Whether the session works in Orchestrator mode now. Any other mode has no lock. */
	orchestrator: () => boolean;
	permission: () => PermissionModeId;
	background: Pick<BackgroundRuns, "liveWriter" | "refresh">;
	/** A shell call that does more than read. */
	changing: (event: { toolName: string; input: unknown }) => boolean;
}) {
	return (pi: ExtensionAPI) => {
		/** Calls that started a writer and have not returned: the run is not known by its own id yet. */
		const starting = new Map<string, string>();
		/** The main agent's own writing calls under way. A reply's calls are all checked before any of them runs. */
		const writing = new Set<string>();
		const held = async (): Promise<string | undefined> => {
			const [call] = starting.values();
			if (call) return call;
			if (!options.background.liveWriter()) return undefined;
			// It may have ended since it was last looked at.
			await options.background.refresh().catch(() => false);
			return options.background.liveWriter();
		};
		pi.on("tool_call", async (event, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
			if (!options.orchestrator()) return undefined;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const writer = writerOf(event.toolName, input, ctx?.cwd ?? "");
			const writes = event.toolName === "edit" || event.toolName === "write" || options.changing(event);
			if (!writer && !writes) return undefined;
			const live = await held();
			if (live) {
				return {
					block: true,
					reason: writer
						? `Blocked: ${live} is already making changes, and only one writer works at a time. Wait for its completion message, or stop it first. Scouts and reviewers may run meanwhile.`
						: `Blocked: ${live} is making changes in this project, and only one writer works at a time. Until its completion message, read, run commands that only read, start scouts or answer its questions; or stop it first.`,
				};
			}
			if (!writer) {
				writing.add(event.toolCallId);
				return undefined;
			}
			if (options.permission() === "ask") {
				return {
					block: true,
					reason: `Blocked: the permission mode is Always ask, and no one can answer for a subagent, so every edit and command of ${writer} would be refused. Make the changes yourself, so the user can approve each one, or ask them to choose another permission mode.`,
				};
			}
			if (writing.size) {
				return { block: true, reason: `Blocked: this reply also edits or runs a command, and only one writer works at a time. Start ${writer} in a reply of its own, once those are done.` };
			}
			starting.set(event.toolCallId, writer);
			return undefined;
		});
		// Sent for every call, also one that was refused or failed. By then a run it left going is known by its id.
		pi.on("tool_execution_end", (event) => {
			starting.delete(event.toolCallId);
			writing.delete(event.toolCallId);
		});
		// No call outlives the run that made it.
		pi.on("agent_end", () => {
			starting.clear();
			writing.clear();
		});
	};
}
