import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { splitAttachments } from "./transcript.ts";

export interface ExportInfo {
	title: string;
	id: string;
	cwd: string;
	messages: AgentMessage[];
}

const pad = (value: number) => String(value).padStart(2, "0");
const stamp = (time: Date) =>
	`${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;

/** What a tool call acted on, in a few words: a path, a command, a query, or its arguments. */
function toolTarget(args: Record<string, unknown>): string {
	for (const key of ["path", "file_path", "command", "pattern", "query", "url", "agent", "phrase"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]!.slice(0, 160);
	}
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json.slice(0, 160);
}

type Part = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

/**
 * A session's conversation as Markdown: each prompt, the tools the agent called and what it answered. Thinking
 * and tool output are left out; the session file keeps them.
 */
export function sessionMarkdown(info: ExportInfo, exported = new Date()): string {
	const lines = [`# ${info.title}`, "", `Session \`${info.id}\` · ${info.cwd} · exported ${stamp(exported)}`];
	let speaker: "user" | "assistant" | undefined;
	for (const message of info.messages) {
		const time = typeof (message as { timestamp?: unknown }).timestamp === "number" ? ` · ${stamp(new Date((message as { timestamp: number }).timestamp))}` : "";
		if (message.role === "user") {
			const { prompt, attachments } = splitAttachments(message.content);
			lines.push("", `## You${time}`, "", prompt.trim());
			if (attachments?.length) lines.push("", `Attached: ${attachments.map((item) => item.name).join(", ")}`);
			speaker = "user";
		} else if (message.role === "assistant") {
			const parts = ((Array.isArray(message.content) ? message.content : []) as Part[]).filter(
				(part) => (part.type === "text" && part.text?.trim()) || part.type === "toolCall",
			);
			if (!parts.length) continue;
			// One heading for the agent's whole turn, however many messages it took.
			if (speaker !== "assistant") lines.push("", `## Assistant${time}`);
			for (const part of parts) {
				if (part.type === "text") {
					lines.push("", part.text!.trim());
					continue;
				}
				const target = toolTarget(part.arguments ?? {});
				lines.push("", `- \`${part.name}\`${target ? ` ${target}` : ""}`);
			}
			speaker = "assistant";
		}
	}
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/** A file name from a session title: no characters Windows or macOS refuse, and not too long. */
export function exportFileName(title: string): string {
	const name = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
	return name || "Session";
}
