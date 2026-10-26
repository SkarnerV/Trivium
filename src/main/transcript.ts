import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Run, Step, TranscriptImage } from "../shared/protocol.ts";
import { explainLimit } from "./limits.ts";
import { describeSubagent, launchesSubagents, noticeOf, subagentOf } from "./subagents.ts";

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
	images?: TranscriptImage[];
}

interface RunState {
	id: string;
	/** The run began with a user message, rather than with output left over after compaction. */
	fromUser: boolean;
	prompt: string;
	attachments?: Run["attachments"];
	notice?: Run["notice"];
	segments: Segment[];
	status: Run["status"];
	startedAt?: number;
	endedAt?: number;
	error?: string;
	/** The provider that reported the error, which tells apart errors that read alike. */
	errorProvider?: string;
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

function imagesOf(content: unknown): ImagePart[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is { type: "image"; data: string; mimeType: string } => part?.type === "image" && typeof part.data === "string",
	);
}

export type ImagePart = { data: string; mimeType: string };
type KeepImage = (image: ImagePart, name: string) => TranscriptImage;

/** A file sent with a prompt, as its <file> tag gave it: a text file's content, or an image and the notes on it. */
export interface MessageFile {
	/** The name in the tag: the absolute path for files from disk. */
	label: string;
	text?: string;
	image?: ImagePart;
	note?: string;
}

/**
 * Splits the <file> tags pi's CLI and Trivium put in front of a prompt from the text the user typed.
 * Text files have their content on the following lines; images have an empty tag or a short note,
 * and their image parts follow in the same order.
 */
export function messageFiles(content: unknown): { prompt: string; files: MessageFile[] } {
	const text = textOf(content);
	const images = imagesOf(content);
	const files: MessageFile[] = [];
	let rest = text;
	for (let match = /^<file name="([^"]*)">([\s\S]*?)<\/file>\n?/.exec(rest); match; match = /^<file name="([^"]*)">([\s\S]*?)<\/file>\n?/.exec(rest)) {
		const body = match[2]!;
		if (body.startsWith("\n")) files.push({ label: match[1]!, text: body.slice(1).replace(/\n$/, "") });
		else files.push({ label: match[1]!, image: images.shift(), note: body });
		rest = rest.slice(match[0].length);
	}
	return files.length ? { prompt: rest, files } : { prompt: text, files };
}

/** A sent message's <file> tags and images, to send again in front of new text. */
export function attachmentsOf(content: unknown): { prefix: string; images: ImageContent[] } {
	const text = textOf(content);
	const { prompt } = messageFiles(content);
	const images = imagesOf(content).map((image): ImageContent => ({ type: "image", data: image.data, mimeType: image.mimeType }));
	return { prefix: text.slice(0, text.length - prompt.length), images };
}

/** The prompt and what was sent with it, for the transcript. `keep` stores images so they can be shown. */
export function splitAttachments(content: unknown, keep?: KeepImage): { prompt: string; attachments?: Run["attachments"] } {
	const { prompt, files } = messageFiles(content);
	if (!files.length) return { prompt };
	const attachments = files.map((file): NonNullable<Run["attachments"]>[number] => {
		const name = file.label.split(/[\\/]/).pop() || file.label;
		if (file.text !== undefined) return { name, kind: "file" };
		return file.image && keep ? { kind: "image", ...keep(file.image, name) } : { name, kind: "image" };
	});
	return { prompt, attachments };
}

function timestampOf(message: AgentMessage): number | undefined {
	const value = (message as { timestamp?: unknown }).timestamp;
	return typeof value === "number" ? value : undefined;
}

function firstLine(text: string, max = 140): string {
	const line = text.trim().split("\n").find((part) => part.trim().length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A command as worth reading: its first line, without a leading `cd <dir> &&` into the project. */
function commandLine(command: string): string {
	return firstLine(command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, ""), 120);
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
	if (launchesSubagents(tool.name, args)) return describeSubagent(subagentOf(args, tool.details, tool.status), args, tool.status);
	if (tool.status === "error") {
		const target = path || str(args.command) || str(args.pattern) || firstLine(JSON.stringify(args), 80);
		const code = /exit(?:ed with)? code (\d+)/i.exec(result ?? "")?.[1];
		return { target: firstLine(target, 120), meta: code ? `exit ${code}` : "error", tone: "error" };
	}
	switch (tool.name) {
		case "read":
			if (tool.images?.length) return { target: path, meta: tool.images.length === 1 ? "image" : `${tool.images.length} images`, tone: "plain" };
			return { target: path, meta: running ? "" : `${result?.split("\n").length ?? 0} lines`, tone: "plain" };
		case "bash":
			return { target: commandLine(str(args.command)), meta: running ? "running" : "exit 0", tone: "add" };
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
			// Arguments still streaming in arrive as {}, which says nothing.
			const rest = Object.keys(args).length ? JSON.stringify(args) : "";
			return { target: firstLine(str(first) || rest, 120), meta: "", tone: "plain" };
		}
	}
}

export class RunTracker {
	private runs: RunState[] = [];
	private tools = new Map<string, ToolState>();
	private messageSeq = 0;
	private currentAssistantKey: string | undefined;
	private readonly thumbnail: Thumbnail | undefined;
	/** Full images by id, for preview and download. These are the strings already in the session's messages. */
	private images = new Map<string, ImagePart>();

	constructor(messages: AgentMessage[], thumbnail?: Thumbnail) {
		this.thumbnail = thumbnail;
		for (const message of messages) this.applyMessage(message, false);
	}

	get length(): number {
		return this.runs.length;
	}

	image(id: string): ImagePart | undefined {
		return this.images.get(id);
	}

	/** Keeps an image's data and makes its thumbnail, once per image. */
	private keepImage = (image: ImagePart, name: string): TranscriptImage => {
		const id = `i${this.images.size}`;
		this.images.set(id, image);
		const thumb = this.thumbnail?.(image.data, image.mimeType);
		return thumb ? { id, name, mimeType: image.mimeType, thumb } : { id, name, mimeType: image.mimeType };
	};

	/** Images a tool returned, named after the file it read when there is one. */
	private keepToolImages(tool: ToolState, content: unknown): void {
		if (tool.images) return;
		const images = imagesOf(content);
		if (!images.length) return;
		const path = tool.args.path ?? tool.args.file_path;
		const base = typeof path === "string" ? path.split(/[\\/]/).pop() : undefined;
		tool.images = images.map((image, index) => {
			const extension = image.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
			const name = base && images.length === 1 ? base : `image-${index + 1}.${extension}`;
			return this.keepImage(image, name);
		});
	}

	all(): Run[] {
		return this.runs.map((run) => this.view(run));
	}

	/**
	 * The prompt a run began with, and how many later runs also began with a user message, which
	 * finds the message among the session's entries. Undefined when the run did not begin with one.
	 */
	userMessage(index: number): { prompt: string; later: number } | undefined {
		const run = this.runs[index];
		if (!run?.fromUser) return undefined;
		return { prompt: run.prompt, later: this.runs.slice(index + 1).filter((other) => other.fromUser).length };
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
				if (event.message.role === "user" || noticeOf(event.message)) {
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
					const { errorMessage: error, provider } = event.message as { errorMessage?: string; provider?: string };
					const run = this.runs.at(-1);
					if (run && error) {
						run.error = error;
						run.errorProvider = provider;
					}
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
				const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
				const text = textOf(partial?.content);
				tool.result = text;
				// A subagent reports its children's progress here.
				if (partial?.details !== undefined) tool.details = partial.details;
				tool.tail = text.split("\n").slice(-8).join("\n");
				return true;
			}
			case "tool_execution_end": {
				const tool = this.ensureTool(event.toolCallId, event.toolName, undefined);
				const result = event.result as { content?: unknown; details?: unknown } | undefined;
				tool.status = event.isError ? "error" : "done";
				tool.result = textOf(result?.content);
				tool.details = result?.details;
				this.keepToolImages(tool, result?.content);
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
		// A background subagent's result starts a run of its own, as a user message would.
		const notice = noticeOf(message);
		if (!live && current && timestamp && message.role !== "user" && !notice) current.endedAt = timestamp;
		if (notice) {
			if (live && current?.status === "running") {
				current.status = "done";
				current.endedAt = Date.now();
			}
			this.runs.push({
				id: `r${this.runs.length}`,
				fromUser: false,
				prompt: "",
				notice,
				segments: [],
				status: live ? "running" : "done",
				startedAt: live ? Date.now() : timestamp,
			});
			return;
		}
		if (message.role === "user") {
			// A steering message arrives as a user message while the previous run is still going.
			if (live && current?.status === "running") {
				current.status = "done";
				current.endedAt = Date.now();
			}
			this.runs.push({
				id: `r${this.runs.length}`,
				fromUser: true,
				...splitAttachments(message.content, this.keepImage),
				segments: [],
				status: live ? "running" : "done",
				startedAt: live ? Date.now() : timestamp,
			});
			return;
		}
		if (message.role === "assistant") {
			this.applyAssistant(message, `m${this.messageSeq++}`, false);
			const { errorMessage: error, provider } = message as { errorMessage?: string; provider?: string };
			const run = this.runs.at(-1);
			if (run && error) {
				run.error = error;
				run.errorProvider = provider;
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
			this.keepToolImages(tool, message.content);
		}
	}

	private applyAssistant(message: AgentMessage, key: string, live: boolean, eventType?: string): void {
		if (message.role !== "assistant") return;
		let run = this.runs.at(-1);
		if (!run) {
			run = { id: "r0", fromUser: false, prompt: "", segments: [], status: live ? "running" : "done" };
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
				images: tool.images,
				tail: tool.tail,
				subagent: launchesSubagents(tool.name, tool.args) ? subagentOf(tool.args, tool.details, status) : undefined,
			});
		});
		return {
			id: run.id,
			prompt: run.prompt,
			attachments: run.attachments,
			notice: run.notice,
			steps,
			answer,
			status: run.status,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			error: run.error,
			limit: run.error ? explainLimit(run.error, run.errorProvider) : undefined,
		};
	}
}
