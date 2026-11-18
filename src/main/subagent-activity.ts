import { readFile, stat } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Run, SubagentChild } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { type ExtensionRoots, trustedPath } from "./extension-paths.ts";
import { RunTracker } from "./transcript.ts";

/** Read only a child named by this session, and only from the extension's own folders. */
export async function readSubagentActivity(sessionFile: string, runs: Run[], roots: ExtensionRoots): Promise<SubagentChild["steps"]> {
	if (!runs.some((run) => run.steps.some((step) => step.subagent?.children.some((child) => child.sessionFile === sessionFile)))) {
		throw new Error(t("Unknown subagent session"));
	}
	const path = await trustedPath(sessionFile, roots);
	if (!path) throw new Error(t("Subagent tool history is unavailable."));
	const max = 8 * 1024 * 1024;
	if ((await stat(path)).size > max) throw new Error(t("Subagent tool history exceeds the display limit."));
	const bytes = await readFile(path);
	if (bytes.length > max) throw new Error(t("Subagent tool history exceeds the display limit."));
	const messages: AgentMessage[] = [];
	for (const line of bytes.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		if (entry?.type === "message" && entry.message && typeof entry.message.role === "string") messages.push(entry.message);
	}
	const calls = messages.flatMap((message) => message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall").map((part) => part.id) : []);
	const ended = new Map(messages.flatMap((message) => message.role === "toolResult" ? [[message.toolCallId, message.timestamp] as const] : []));
	// Reuse the parent transcript parser so commands, file names, inputs and outputs have the same meaning.
	return new RunTracker(messages).all().flatMap((run) => run.steps)
		.filter((step) => step.tool !== "think" && step.tool !== "note")
		.map((step, index) => ({
			tool: step.tool, target: step.target, input: step.input, output: step.output, status: step.status,
			endMs: ended.get(calls[index] ?? ""),
		}));
}
