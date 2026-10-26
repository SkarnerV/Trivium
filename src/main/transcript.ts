import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Run, Step } from "../shared/protocol.ts";

/**
 * Turns pi's message stream into runs: one user message, the steps the agent
 * took, and the final answer. The same code path rebuilds history and applies
 * live events, so a reopened session looks like it did while it ran.
 */

interface Segment {
	key: string;
	kind: "think" | "text" | "tool";
	text: string;
	toolCallId?: string;
	startedAt?: number;
	durationMs?: number;
}

interface ToolState {
	name: string;
	args: Record<string, unknown>;
	status: Step["status"];
	result?: string;
	details?: unknown;
	durationMs?: number;
	startedAt?: number;
	tail?: string;
}

interface RunState {
	id: string;
	prompt: string;
	attachments?: Run["attachments"];
	segments: Segment[];
	status: Run["status"];
	startedAt?: number;
	endedAt?: number;
	error?: string;
}

type ContentPart = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** Makes a small preview of an image sent with a prompt. The host supplies it, since resizing needs Electron. */
export type Thumbnail = (data: string, mimeType: string) => string | undefined;

function imagesOf(content: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } => part?.type === "image" && typeof part.data === "string",
	);
}

/**
 * Splits the <file> tags pi's CLI and Trivium put in front of a prompt from the text the user typed.
 * Text files have their content on the following lines; images have an empty tag or a short note,
 * and their image parts follow in the same order.
 */
export function splitAttachments(content: unknown, thumbnail?: Thumbnail): { prompt: string; attachments?: Run["attachments"] } {
	const text = textOf(content);
	const images = imagesOf(content);
	const attachments: NonNullable<Run["attachments"]> = [];
	let rest = text;
	for (let match = /^<file name="([^"]*)">([\s\S]*?)<\/file>\n?/.exec(rest); match; match = /^<file name="([^"]*)">([\s\S]*?)<\/file>\n?/.exec(rest)) {
		const name = match[1]!.split(/[\\/]/).pop() || match[1]!;
		if (match[2]!.startsWith("\n")) {
			attachments.push({ name, kind: "file" });
		} else {
			const image = images.shift();
			const thumb = image && thumbnail ? thumbnail(image.data, image.mimeType) : undefined;
			attachments.push(thumb ? { name, kind: "image", thumb } : { name, kind: "image" });
		}
		rest = rest.slice(match[0].length);
	}
	return attachments.length ? { prompt: rest, attachments } : { prompt: text };
}

function timestampOf(message: AgentMessage): number | undefined {
	const value = (message as { timestamp?: unknown }).timestamp;
	return typeof value === "number" ? value : undefined;
}

function firstLine(text: string, max = 140): string {
	const line = text.trim().split("\n").find((part) => part.trim().length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function countLines(text: string | undefined): number {
	if (!text) return 0;
	return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function describeTool(tool: ToolState): Pick<Step, "target" | "meta" | "tone"> {
	const { args, result } = tool;
	const path = str(args.path) || str(args.file_path);
	const running = tool.status === "running";
	if (tool.status === "error") {
		const target = path || str(args.command) || str(args.pattern) || firstLine(JSON.stringify(args), 80);
		const code = /exit(?:ed with)? code (\d+)/i.exec(result ?? "")?.[1];
		return { target: firstLine(target, 120), meta: code ? `exit ${code}` : "error", tone: "error" };
	}
	switch (tool.name) {
		case "read":
			return { target: path, meta: running ? "" : `${result?.split("\n").length ?? 0} lines`, tone: "plain" };
		case "bash":
			return { target: firstLine(str(args.command), 120), meta: running ? "running" : "exit 0", tone: "add" };
		case "edit": {
			const diff = str((tool.details as { diff?: unknown } | undefined)?.diff);
			const lines = diff.split("\n");
			const adds = lines.filter((line) => /^\+(?!\+\+)/.test(line.trimStart())).length;
			const dels = lines.filter((line) => /^-(?!--)/.test(line.trimStart())).length;
			return { target: path, meta: running || !diff ? "" : `+${adds} −${dels}`, tone: "plain" };
		}
		case "write": {
			const content = str(args.content);
			const lines = content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
			return { target: path, meta: `+${lines}`, tone: "add" };
		}
		case "grep": {
			const matches = /no matches/i.test(result ?? "") ? 0 : countLines(result);
			const where = str(args.path);
			return {
				target: `"${str(args.pattern)}"${where ? ` ${where}` : ""}`,
				meta: running ? "" : `${matches} ${matches === 1 ? "match" : "matches"}`,
				tone: "plain",
			};
		}
		case "find":
		case "ls": {
			const count = countLines(result);
			return {
				target: str(args.pattern) || path || ".",
				meta: running ? "" : `${count} ${count === 1 ? "entry" : "entries"}`,
				tone: "plain",
			};
		}
		default: {
			const first = Object.values(args).find((value) => typeof value === "string");
			return { target: firstLine(str(first) || JSON.stringify(args), 120), meta: "", tone: "plain" };
		}
	}
}

export class RunTracker {
	private runs: RunState[] = [];
	private tools = new Map<string, ToolState>();
	private messageSeq = 0;
	private currentAssistantKey: string | undefined;
	private readonly thumbnail: Thumbnail | undefined;

	constructor(messages: AgentMessage[], thumbnail?: Thumbnail) {
		this.thumbnail = thumbnail;
		for (const message of messages) this.applyMessage(message, false);
	}

	get length(): number {
		return this.runs.length;
	}

	all(): Run[] {
		return this.runs.map((run) => this.view(run));
	}

	current(): { index: number; run: Run } | undefined {
		const run = this.runs.at(-1);
		return run ? { index: this.runs.length - 1, run: this.view(run) } : undefined;
	}

	/** Applies one session event. Returns true when the current run changed. */
	apply(event: AgentSessionEvent): boolean {
		const now = Date.now();
		switch (event.type) {
			case "message_start":
				if (event.message.role === "user") {
					this.applyMessage(event.message, true);
					return true;
				}
				if (event.message.role === "assistant") {
					this.currentAssistantKey = `m${this.messageSeq++}`;
					this.applyAssistant(event.message, this.currentAssistantKey, true);
					return true;
				}
				return false;
			case "message_update":
				if (event.message.role !== "assistant" || !this.currentAssistantKey) return false;
				this.applyAssistant(event.message, this.currentAssistantKey, true, event.assistantMessageEvent.type);
				return true;
			case "message_end":
				if (event.message.role === "assistant" && this.currentAssistantKey) {
					this.applyAssistant(event.message, this.currentAssistantKey, true, "done");
					const error = (event.message as { errorMessage?: string; stopReason?: string }).errorMessage;
					const run = this.runs.at(-1);
					if (run && error) run.error = error;
					this.currentAssistantKey = undefined;
					return true;
				}
				return false;
			case "tool_execution_start": {
				const tool = this.ensureTool(event.toolCallId, event.toolName, event.args);
				tool.status = "running";
				tool.startedAt = now;
				return true;
			}
			case "tool_execution_update": {
				const tool = this.ensureTool(event.toolCallId, event.toolName, event.args);
				const text = textOf((event.partialResult as { content?: unknown } | undefined)?.content);
				tool.result = text;
				tool.tail = text.split("\n").slice(-8).join("\n");
				return true;
			}
			case "tool_execution_end": {
				const tool = this.ensureTool(event.toolCallId, event.toolName, undefined);
				const result = event.result as { content?: unknown; details?: unknown } | undefined;
				tool.status = event.isError ? "error" : "done";
				tool.result = textOf(result?.content);
				tool.details = result?.details;
				tool.durationMs = event.durationMs ?? (tool.startedAt ? now - tool.startedAt : undefined);
				tool.tail = undefined;
				return true;
			}
			case "agent_settled": {
				const run = this.runs.at(-1);
				if (!run) return false;
				run.status = event.aborted ? "aborted" : run.error ? "error" : "done";
				run.endedAt = now;
				for (const tool of this.tools.values()) if (tool.status === "running") tool.status = "error";
				return true;
			}
			default:
				return false;
		}
	}

	private ensureTool(id: string, name: string, args: unknown): ToolState {
		let tool = this.tools.get(id);
		if (!tool) {
			tool = { name, args: (args as Record<string, unknown>) ?? {}, status: "running" };
			this.tools.set(id, tool);
		} else if (args && typeof args === "object") {
			tool.args = args as Record<string, unknown>;
		}
		return tool;
	}

	private applyMessage(message: AgentMessage, live: boolean): void {
		const timestamp = timestampOf(message);
		const current = this.runs.at(-1);
		if (!live && current && timestamp && message.role !== "user") current.endedAt = timestamp;
		if (message.role === "user") {
			// A steering message arrives as a user message while the previous run is still going.
			if (live && current?.status === "running") {
				current.status = "done";
				current.endedAt = Date.now();
			}
			this.runs.push({
				id: `r${this.runs.length}`,
				...splitAttachments(message.content, this.thumbnail),
				segments: [],
				status: live ? "running" : "done",
				startedAt: live ? Date.now() : timestamp,
			});
			return;
		}
		if (message.role === "assistant") {
			this.applyAssistant(message, `m${this.messageSeq++}`, false);
			const error = (message as { errorMessage?: string }).errorMessage;
			const run = this.runs.at(-1);
			if (run && error) {
				run.error = error;
				run.status = "error";
			}
			return;
		}
		if (message.role === "toolResult") {
			const tool = this.tools.get(message.toolCallId);
			if (!tool) return;
			tool.status = message.isError ? "error" : "done";
			tool.result = textOf(message.content);
			tool.details = message.details;
		}
	}

	private applyAssistant(message: AgentMessage, key: string, live: boolean, eventType?: string): void {
		if (message.role !== "assistant") return;
		let run = this.runs.at(-1);
		if (!run) {
			run = { id: "r0", prompt: "", segments: [], status: live ? "running" : "done" };
			this.runs.push(run);
		}
		const previous = new Map(run.segments.filter((s) => s.key.startsWith(`${key}:`)).map((s) => [s.key, s]));
		run.segments = run.segments.filter((s) => !s.key.startsWith(`${key}:`));
		const now = Date.now();
		(message.content as ContentPart[]).forEach((part, index) => {
			const segKey = `${key}:${index}`;
			const old = previous.get(segKey);
			if (part.type === "thinking") {
				const text = part.thinking ?? "";
				if (!text.trim()) return;
				const startedAt = old?.startedAt ?? (live ? now : undefined);
				const finished = old?.durationMs !== undefined || eventType === "thinking_end" || eventType === "done";
				run.segments.push({
					key: segKey,
					kind: "think",
					text,
					startedAt,
					durationMs: old?.durationMs ?? (finished && startedAt ? now - startedAt : undefined),
				});
			} else if (part.type === "text") {
				if (!part.text) return;
				run.segments.push({ key: segKey, kind: "text", text: part.text });
			} else if (part.type === "toolCall" && part.id) {
				this.ensureTool(part.id, part.name ?? "tool", part.arguments);
				if (!live) this.tools.get(part.id)!.status = "done";
				run.segments.push({ key: segKey, kind: "tool", text: "", toolCallId: part.id });
			}
		});
	}

	private view(run: RunState): Run {
		const lastTool = run.segments.findLastIndex((s) => s.kind === "tool");
		const steps: Step[] = [];
		let answer = "";
		run.segments.forEach((segment, index) => {
			if (segment.kind === "text" && index > lastTool) {
				answer += (answer ? "\n\n" : "") + segment.text;
				return;
			}
			if (segment.kind === "think" || segment.kind === "text") {
				steps.push({
					id: segment.key,
					tool: segment.kind === "think" ? "think" : "note",
					target: firstLine(segment.text),
					content: segment.text,
					meta: "",
					tone: "plain",
					status: segment.kind === "think" && segment.durationMs === undefined && run.status === "running" ? "running" : "done",
					durationMs: segment.durationMs,
				});
				return;
			}
			const tool = segment.toolCallId ? this.tools.get(segment.toolCallId) : undefined;
			if (!tool) return;
			const status = tool.status === "running" && run.status !== "running" ? "error" : tool.status;
			steps.push({
				id: segment.key,
				tool: tool.name,
				...describeTool({ ...tool, status }),
				status,
				startedAt: tool.startedAt,
				durationMs: tool.durationMs,
				input: JSON.stringify(tool.args, null, 2),
				output: tool.result,
				tail: tool.tail,
			});
		});
		return {
			id: run.id,
			prompt: run.prompt,
			attachments: run.attachments,
			steps,
			answer,
			status: run.status,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			error: run.error,
		};
	}
}
