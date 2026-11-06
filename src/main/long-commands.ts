import type { SubagentNotice } from "../shared/protocol.ts";

/**
 * How Trivium handles agent commands that run long. A tool call waits for BACKGROUND_AFTER_MS at most, then it returns
 * and the command carries on as a service, so the session isn't held up and the work isn't lost. When it ends, the
 * session gets a message saying how. Models pass a timeout out of habit, sometimes a huge one, so it only shortens the
 * wait: nothing ends a command early but Stop, or BACKGROUND_LIMIT_MS.
 *
 * It is an extension, so a mode can turn it off in Settings. That leaves Trivium's plain bash, as pi's own: no limit
 * on a command but its timeout, which kills it. The extension provides a bash tool rather than wrapping one, so
 * another extension's bash replaces it, the way one replaces a shipped package.
 */

/** The extension's name. */
export const LONG_COMMANDS_NAME = "long-commands";
/** Its path, as pi names a built-in extension. Turning it off in Settings stores this. */
export const LONG_COMMANDS_PATH = `builtin:${LONG_COMMANDS_NAME}`;

/** How long a command holds up its tool call. */
export const BACKGROUND_AFTER_MS = 10 * 60_000;
/** How long a command runs in all before it is ended, so a hung one can't run forever. */
export const BACKGROUND_LIMIT_MS = 4 * 60 * 60_000;
/** The most a command's log keeps. */
export const LOG_LIMIT_BYTES = 64 * 1024 * 1024;
/** How long logs stay on disk. */
export const LOG_KEEP_MS = 7 * 24 * 60 * 60_000;

/** A command in the background ended by itself or at the limit: the model is told and goes on. */
export const COMMAND_ENDED = "trivium-command-ended";
/** The user stopped a command in the background: the model hears at its next turn. */
export const COMMAND_STOPPED = "trivium-command-stopped";

/** Opens the line a command's result ends with once it has moved to the background. */
const BACKGROUND_NOTE = "[Still running after";

/** How much of a command's output its message carries; the log has the rest. */
const MESSAGE_OUTPUT_CHARS = 4000;

/** How a command in the background ended. */
export interface BackgroundEnd {
	command: string;
	/** The shell's exit code, or null if it was killed. */
	exitCode: number | null;
	durationMs: number;
	logPath: string;
	/** The last part of what it printed. */
	output: string;
	/** The user stopped it. */
	stopped: boolean;
	/** It ran for BACKGROUND_LIMIT_MS and was ended. */
	hitLimit: boolean;
}

/** "14m 3s", for the model. */
function elapsed(ms: number): string {
	const seconds = Math.round(ms / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours) return `${hours}h ${minutes}m`;
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** What the tool result says once the command has moved to the background. */
export function backgroundNote(ms: number, logPath: string): string {
	return `\n\n${BACKGROUND_NOTE} ${elapsed(ms)}, so this command moved to the background and this call returned. It has not finished: do not run it again. Its output goes on in ${logPath}, and a message will say when it ends.]`;
}

/** Whether a tool result is from a command that moved to the background. */
export function movedToBackground(result: string | undefined): boolean {
	return result?.includes(`\n\n${BACKGROUND_NOTE}`) || result?.startsWith(BACKGROUND_NOTE) || false;
}

/** The message for the session, and how to deliver it. */
export function endedMessage(end: BackgroundEnd): {
	message: { customType: string; content: string; display: boolean; details: { command: string; status: SubagentNotice["status"]; durationMs: number; text: string } };
	options: { triggerTurn?: boolean; deliverAs: "followUp" | "nextTurn" };
} {
	const status: SubagentNotice["status"] = end.stopped || end.hitLimit ? "stopped" : end.exitCode === 0 ? "completed" : "failed";
	const how = end.stopped
		? "was stopped by the user"
		: end.hitLimit
			? "was ended for running too long"
			: end.exitCode === null
				? "was killed"
				: `exited with code ${end.exitCode}`;
	const text = end.output.trim().slice(-MESSAGE_OUTPUT_CHARS);
	const content = `Background command ${how} after ${elapsed(end.durationMs)}: ${end.command}\nFull output: ${end.logPath}${text ? `\n\nLast output:\n${text}` : ""}`;
	return {
		message: { customType: end.stopped ? COMMAND_STOPPED : COMMAND_ENDED, content, display: !end.stopped, details: { command: end.command, status, durationMs: end.durationMs, text } },
		// Nothing for the model to do about a command the user stopped, so it doesn't start a run.
		options: end.stopped ? { deliverAs: "nextTurn" } : { triggerTurn: true, deliverAs: "followUp" },
	};
}

/** The line that opens the run a command's end starts, or undefined for any other message. */
export function commandNotice(message: { role?: unknown; customType?: unknown; details?: unknown }): SubagentNotice | undefined {
	if (message.role !== "custom" || message.customType !== COMMAND_ENDED) return undefined;
	const details = (message.details ?? {}) as { command?: string; status?: SubagentNotice["status"]; durationMs?: number; text?: string };
	return { agent: "", command: details.command ?? "", status: details.status ?? "completed", durationMs: details.durationMs, text: details.text ?? "" };
}

interface BashDefinition {
	parameters: object;
	promptGuidelines?: readonly string[];
}

/** pi's bash tool, telling the model how long commands go here rather than that they have no default timeout. */
export function withLongCommands<T extends BashDefinition>(tool: T): T {
	const parameters = tool.parameters as { properties: { timeout: object } };
	return {
		...tool,
		parameters: {
			...parameters,
			properties: {
				...parameters.properties,
				timeout: {
					...parameters.properties.timeout,
					description: `Seconds to wait for the command (optional, at most ${elapsed(BACKGROUND_AFTER_MS)}, which is also the default). It does not kill the command: one still running then moves to the background and keeps going.`,
				},
			},
		},
		promptGuidelines: [
			...(tool.promptGuidelines ?? []),
			"When a command moves to the background it is still running, so do not run it again. Carry on with other work, or end your turn; a message arrives when it ends.",
		],
	};
}
