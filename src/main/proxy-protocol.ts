import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	clampThinkingLevel,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type TextContent,
	type ThinkingContent,
	type ThinkingLevel,
	type Tool,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";

// What the API proxy's two wire formats, OpenAI's Chat Completions and Anthropic's Messages, have in common
// with pi: requests become a pi context, and pi's stream of events becomes the format's reply.

type Json = Record<string, unknown>;

/** A request the proxy refuses or can't finish, with the HTTP status to answer with. */
export class ProxyError extends Error {
	readonly status: number;
	readonly kind: string;

	constructor(status: number, message: string, kind = "invalid_request_error") {
		super(message);
		this.status = status;
		this.kind = kind;
	}
}

/** A client's request, as pi takes it. */
export interface ProxyRequest {
	context: Context;
	stream: boolean;
	/** The client asked for token counts at the end of an OpenAI stream. */
	includeUsage: boolean;
	maxTokens?: number;
	temperature?: number;
	/** The thinking the client asked for, as the model offers it. Unset leaves thinking off. */
	reasoning?: ThinkingLevel;
	toolChoice?: "auto" | "none";
}

const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const bad = (message: string) => new ProxyError(400, message);

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Which model wrote an assistant message. pi replays thinking only to the model it came from. */
interface Origin {
	api: string;
	provider: string;
	model: string;
}

/**
 * The origin of assistant messages that come back without one, which matches no model: pi then treats them as
 * another model's, drops what only the author could read and fits tool call IDs to the provider it sends to.
 */
const UNKNOWN: Origin = { api: "trivium-proxy", provider: "trivium-proxy", model: "unknown" };

const SEAL = "tv1.";

/**
 * A thinking block's signature as the client gets it: pi's own, with the model that wrote it. Clients send
 * signatures back untouched, which tells the proxy whose thinking it is when the conversation continues.
 */
export function seal(model: Pick<Model<Api>, "api" | "provider" | "id">, signature: string | undefined): string {
	return SEAL + Buffer.from(JSON.stringify([model.api, model.provider, model.id, signature ?? ""])).toString("base64url");
}

/** Undefined for a signature the proxy didn't write, such as one from a conversation that began elsewhere. */
export function unseal(value: unknown): (Origin & { signature: string }) | undefined {
	if (typeof value !== "string" || !value.startsWith(SEAL)) return undefined;
	try {
		const parts: unknown = JSON.parse(Buffer.from(value.slice(SEAL.length), "base64url").toString("utf8"));
		if (!Array.isArray(parts) || parts.length !== 4 || parts.some((part) => typeof part !== "string")) return undefined;
		const [api, provider, model, signature] = parts as [string, string, string, string];
		return { api, provider, model, signature };
	} catch {
		return undefined;
	}
}

function assistant(content: AssistantMessage["content"], origin: Origin): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: origin.api,
		provider: origin.provider,
		model: origin.model,
		usage: NO_USAGE,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function parseArguments(text: unknown): ToolCall["arguments"] {
	if (text && typeof text === "object" && !Array.isArray(text)) return text as ToolCall["arguments"];
	try {
		const parsed: unknown = JSON.parse(str(text) || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ToolCall["arguments"]) : {};
	} catch {
		return {};
	}
}

/** An image sent as a data: URL. The proxy fetches nothing on a client's behalf. */
function dataUrlImage(url: string): ImageContent {
	const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(url);
	if (!match) throw bad("Images must be sent as base64 data URLs.");
	return { type: "image", mimeType: match[1]!, data: match[2]! };
}

function tool(name: unknown, description: unknown, parameters: unknown): Tool {
	if (!str(name)) throw bad("Every tool needs a name.");
	const schema = Object.keys(obj(parameters)).length ? obj(parameters) : { type: "object", properties: {} };
	return { name: str(name), description: str(description), parameters: schema as Tool["parameters"] };
}

const LEVELS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The level the model has for what the client asked, or none when it doesn't think. */
function reasoningFor(model: Model<Api>, level: string | undefined): ThinkingLevel | undefined {
	if (!level || !LEVELS.includes(level) || !model.reasoning) return undefined;
	const clamped = clampThinkingLevel(model, level as ThinkingLevel);
	return clamped === "off" ? undefined : clamped;
}

function maxTokensFor(model: Model<Api>, asked: unknown): number | undefined {
	const tokens = positive(asked);
	if (!tokens) return undefined;
	return model.maxTokens > 0 ? Math.min(Math.floor(tokens), model.maxTokens) : Math.floor(tokens);
}

function finish(model: Model<Api>, body: Json, context: Context, extra: Pick<ProxyRequest, "includeUsage" | "maxTokens" | "reasoning" | "toolChoice">): ProxyRequest {
	if (!context.messages.length) throw bad("messages must hold at least one user message.");
	if (context.messages.some((message) => message.role === "user" && typeof message.content !== "string" && message.content.some((part) => part.type === "image")) && !model.input.includes("image")) {
		throw bad(`${model.provider}/${model.id} doesn't accept images.`);
	}
	return {
		context,
		stream: body.stream === true,
		temperature: typeof body.temperature === "number" ? body.temperature : undefined,
		...extra,
	};
}

/* OpenAI Chat Completions */

function openAIText(content: unknown): string {
	if (typeof content === "string") return content;
	return list(content)
		.map(obj)
		.map((part) => (part.type === "text" || part.type === "refusal" ? str(part.text ?? part.refusal) : ""))
		.join("");
}

function openAIUserContent(content: unknown): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return content;
	return list(content)
		.map(obj)
		.map((part): TextContent | ImageContent => {
			if (part.type === "text") return { type: "text", text: str(part.text) };
			if (part.type === "image_url") return dataUrlImage(str(obj(part.image_url).url));
			throw bad(`Content of type "${str(part.type)}" isn't supported. Send text and images.`);
		});
}

/** A Chat Completions request body as a pi request for `model`. */
export function fromOpenAI(body: Json, model: Model<Api>): ProxyRequest {
	if (!Array.isArray(body.messages)) throw bad("messages must be a list.");
	const system: string[] = [];
	const messages: Message[] = [];
	/** Tool names by call ID, which a tool's result doesn't repeat. */
	const names = new Map<string, string>();
	for (const message of body.messages.map(obj)) {
		switch (message.role) {
			case "system":
			case "developer":
				system.push(openAIText(message.content));
				break;
			case "user":
				messages.push({ role: "user", content: openAIUserContent(message.content), timestamp: Date.now() });
				break;
			case "assistant": {
				const text = openAIText(message.content);
				const calls = list(message.tool_calls)
					.map(obj)
					.map((call): ToolCall => {
						const fn = obj(call.function);
						names.set(str(call.id), str(fn.name));
						return { type: "toolCall", id: str(call.id), name: str(fn.name), arguments: parseArguments(fn.arguments) };
					});
				const content: AssistantMessage["content"] = [...(text ? [{ type: "text" as const, text }] : []), ...calls];
				if (content.length) messages.push(assistant(content, UNKNOWN));
				break;
			}
			case "tool": {
				const id = str(message.tool_call_id);
				messages.push({
					role: "toolResult",
					toolCallId: id,
					toolName: names.get(id) ?? "tool",
					content: [{ type: "text", text: openAIText(message.content) }],
					isError: false,
					timestamp: Date.now(),
				});
				break;
			}
			default:
				throw bad(`Messages can't have the role "${str(message.role)}".`);
		}
	}
	const tools = list(body.tools)
		.map(obj)
		.filter((entry) => entry.type === "function" || entry.function)
		.map((entry) => obj(entry.function))
		.map((fn) => tool(fn.name, fn.description, fn.parameters));
	const context: Context = { messages, ...(system.some(Boolean) ? { systemPrompt: system.filter(Boolean).join("\n\n") } : {}), ...(tools.length ? { tools } : {}) };
	return finish(model, body, context, {
		includeUsage: obj(body.stream_options).include_usage === true,
		maxTokens: maxTokensFor(model, body.max_completion_tokens ?? body.max_tokens),
		reasoning: reasoningFor(model, str(body.reasoning_effort)),
		toolChoice: body.tool_choice === "none" ? "none" : undefined,
	});
}

/* Anthropic Messages */

function anthropicText(content: unknown): string {
	if (typeof content === "string") return content;
	return list(content)
		.map(obj)
		.map((block) => (block.type === "text" ? str(block.text) : ""))
		.join("\n");
}

function anthropicImage(block: Json): ImageContent {
	const source = obj(block.source);
	if (source.type !== "base64" || !str(source.data)) throw bad("Images must be sent as base64 data.");
	return { type: "image", mimeType: str(source.media_type) || "image/png", data: str(source.data) };
}

/** Thinking the client asks for: a budget in tokens on older models, an effort on newer ones. */
function anthropicLevel(body: Json): string | undefined {
	const thinking = obj(body.thinking);
	if (thinking.type === "adaptive") return str(obj(body.output_config).effort) || "high";
	if (thinking.type !== "enabled") return undefined;
	const budget = positive(thinking.budget_tokens) ?? 0;
	if (budget <= 1024) return "minimal";
	if (budget <= 4096) return "low";
	if (budget <= 12000) return "medium";
	return budget <= 32000 ? "high" : "xhigh";
}

/** A Messages request body as a pi request for `model`. */
export function fromAnthropic(body: Json, model: Model<Api>): ProxyRequest {
	if (!Array.isArray(body.messages)) throw bad("messages must be a list.");
	const messages: Message[] = [];
	const names = new Map<string, string>();
	for (const message of body.messages.map(obj)) {
		const blocks: Json[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : list(message.content).map(obj);
		if (message.role === "assistant") {
			let origin: Origin | undefined;
			const content: AssistantMessage["content"] = [];
			for (const block of blocks) {
				if (block.type === "text") {
					if (str(block.text)) content.push({ type: "text", text: str(block.text) });
				} else if (block.type === "tool_use") {
					names.set(str(block.id), str(block.name));
					content.push({ type: "toolCall", id: str(block.id), name: str(block.name), arguments: parseArguments(block.input) });
				} else if (block.type === "thinking" || block.type === "redacted_thinking") {
					// Thinking the proxy didn't sign came from somewhere else, and no model here can take it back.
					const opened = unseal(block.type === "thinking" ? block.signature : block.data);
					if (!opened) continue;
					origin ??= opened;
					const thinking: ThinkingContent = { type: "thinking", thinking: str(block.thinking) };
					if (opened.signature) thinking.thinkingSignature = opened.signature;
					if (block.type === "redacted_thinking") thinking.redacted = true;
					content.push(thinking);
				}
				// Anything else, such as a server tool's own blocks, was the upstream's to keep.
			}
			if (content.length) messages.push(assistant(content, origin ?? UNKNOWN));
		} else if (message.role === "user") {
			const content: (TextContent | ImageContent)[] = [];
			for (const block of blocks) {
				if (block.type === "text") content.push({ type: "text", text: str(block.text) });
				else if (block.type === "image") content.push(anthropicImage(block));
				else if (block.type === "tool_result") {
					const id = str(block.tool_use_id);
					const parts =
						typeof block.content === "string"
							? [{ type: "text" as const, text: block.content }]
							: list(block.content)
									.map(obj)
									.map((part): TextContent | ImageContent => (part.type === "image" ? anthropicImage(part) : { type: "text", text: str(part.text) }));
					messages.push({
						role: "toolResult",
						toolCallId: id,
						toolName: names.get(id) ?? "tool",
						content: parts.length ? parts : [{ type: "text", text: "" }],
						isError: block.is_error === true,
						timestamp: Date.now(),
					});
				} else throw bad(`Content of type "${str(block.type)}" isn't supported. Send text, images and tool results.`);
			}
			// Tool results come first: they answer the assistant message before them.
			if (typeof message.content === "string") messages.push({ role: "user", content: message.content, timestamp: Date.now() });
			else if (content.length) messages.push({ role: "user", content, timestamp: Date.now() });
		} else throw bad(`Messages can't have the role "${str(message.role)}".`);
	}
	const system = anthropicText(body.system);
	// Tools without a schema are the provider's own, such as web search, which only Anthropic can run.
	const tools = list(body.tools)
		.map(obj)
		.filter((entry) => entry.input_schema)
		.map((entry) => tool(entry.name, entry.description, entry.input_schema));
	const context: Context = { messages, ...(system ? { systemPrompt: system } : {}), ...(tools.length ? { tools } : {}) };
	return finish(model, body, context, {
		includeUsage: false,
		maxTokens: maxTokensFor(model, body.max_tokens),
		reasoning: reasoningFor(model, anthropicLevel(body)),
		toolChoice: obj(body.tool_choice).type === "none" ? "none" : undefined,
	});
}

/** A rough size for Anthropic's count_tokens, which clients use to decide when to shorten a conversation. */
export function estimateTokens(body: Json): number {
	const { model: _model, ...rest } = body;
	return Math.ceil(JSON.stringify(rest).length / 4);
}

/* Replies */

/**
 * The status for a reply the provider refused. Its complaints about the request and its rate limits pass on as
 * they are; a rejected login is the proxy's trouble, not the client's key, so it reads as a bad gateway.
 */
export function upstreamError(message: AssistantMessage): ProxyError {
	const text = message.errorMessage?.trim() || "The provider returned an error.";
	const status = Number(/^(?:[^\n(]{0,40}\()?(\d{3})\)?[:\s]/.exec(text)?.[1]);
	if (status === 429) return new ProxyError(429, text, "rate_limit_error");
	if (status === 400 || status === 404 || status === 413 || status === 422) return new ProxyError(400, text);
	return new ProxyError(502, text, "api_error");
}

const openAIUsage = (usage: Usage) => ({
	prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
	completion_tokens: usage.output,
	total_tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
	prompt_tokens_details: { cached_tokens: usage.cacheRead },
	...(usage.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
});

const anthropicUsage = (usage: Usage) => ({
	input_tokens: usage.input,
	output_tokens: usage.output,
	cache_creation_input_tokens: usage.cacheWrite,
	cache_read_input_tokens: usage.cacheRead,
});

const OPENAI_STOP: Record<string, string> = { stop: "stop", length: "length", toolUse: "tool_calls" };
const ANTHROPIC_STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", toolUse: "tool_use" };

const textOf = (message: AssistantMessage, type: "text" | "thinking") =>
	message.content.map((block) => (block.type === "text" && type === "text" ? block.text : block.type === "thinking" && type === "thinking" ? block.thinking : "")).join("");

const callId = (id: string) => id || `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

/** A whole reply as a Chat Completions response. `name` is the model as the client asked for it. */
export function openAIResponse(message: AssistantMessage, name: string): Json {
	const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
	const thinking = textOf(message, "thinking");
	return {
		id: `chatcmpl-${randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: name,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: textOf(message, "text") || null,
					...(thinking ? { reasoning_content: thinking } : {}),
					...(calls.length
						? { tool_calls: calls.map((call) => ({ id: callId(call.id), type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
						: {}),
				},
				finish_reason: OPENAI_STOP[message.stopReason] ?? "stop",
			},
		],
		usage: openAIUsage(message.usage),
	};
}

/** A whole reply as a Messages response. */
export function anthropicResponse(message: AssistantMessage, name: string, model: Model<Api>): Json {
	return {
		id: `msg_${randomUUID().replaceAll("-", "")}`,
		type: "message",
		role: "assistant",
		model: name,
		content: message.content.map((block) => {
			if (block.type === "text") return { type: "text", text: block.text };
			if (block.type === "toolCall") return { type: "tool_use", id: callId(block.id), name: block.name, input: block.arguments };
			return block.redacted
				? { type: "redacted_thinking", data: seal(model, block.thinkingSignature) }
				: { type: "thinking", thinking: block.thinking, signature: seal(model, block.thinkingSignature) };
		}),
		stop_reason: ANTHROPIC_STOP[message.stopReason] ?? "end_turn",
		stop_sequence: null,
		usage: anthropicUsage(message.usage),
	};
}

/** Turns pi's events for one reply into the text of a server-sent event stream. */
export interface StreamEncoder {
	/** What to send for an event; empty when the format has nothing to say about it. */
	push(event: AssistantMessageEvent): string;
	/** What to send when the reply fails after the stream began. */
	fail(message: string): string;
}

/** A tool call's place in a stream. Its opening waits for the name and ID, which some providers send late. */
interface CallSlot {
	open: boolean;
	/** Arguments that arrived before the call could open. */
	pending: string;
	/** Some of the arguments went out as they streamed. */
	streamed: boolean;
}

function blockAt(event: { partial: AssistantMessage; contentIndex: number }): AssistantMessage["content"][number] | undefined {
	return event.partial.content[event.contentIndex];
}

/** Server-sent events of a Chat Completions stream. */
export function openAIStream(name: string, includeUsage: boolean): StreamEncoder {
	const base = { id: `chatcmpl-${randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: name };
	const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
	const chunk = (delta: Json, finishReason: string | null = null) => frame({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] });
	/** Tool calls by pi's content index, numbered from 0 as the stream counts them. */
	const slots = new Map<number, CallSlot & { index: number }>();

	const call = (contentIndex: number, block: ToolCall | undefined, delta: string, end: boolean): string => {
		let slot = slots.get(contentIndex);
		if (!slot) slots.set(contentIndex, (slot = { index: slots.size, open: false, pending: "", streamed: false }));
		const { index } = slot;
		const args = (text: string) => chunk({ tool_calls: [{ index, function: { arguments: text } }] });
		let out = "";
		if (!slot.open && block && ((block.name && block.id) || end)) {
			slot.open = true;
			out += chunk({ tool_calls: [{ index, id: callId(block.id), type: "function", function: { name: block.name, arguments: "" } }] });
			if (slot.pending) {
				out += args(slot.pending);
				slot.streamed = true;
			}
		}
		if (delta) {
			if (slot.open) {
				out += args(delta);
				slot.streamed = true;
			} else slot.pending += delta;
		}
		// A provider that sends a call whole has no deltas to pass on.
		if (end && block && !slot.streamed) out += args(JSON.stringify(block.arguments));
		return out;
	};

	const fail = (message: string) => frame({ error: { message, type: "api_error" } });
	return {
		fail,
		push(event) {
			switch (event.type) {
				case "start":
					return chunk({ role: "assistant", content: "" });
				case "text_delta":
					return event.delta ? chunk({ content: event.delta }) : "";
				case "thinking_delta":
					return event.delta ? chunk({ reasoning_content: event.delta }) : "";
				case "toolcall_start":
				case "toolcall_delta": {
					const block = blockAt(event);
					return call(event.contentIndex, block?.type === "toolCall" ? block : undefined, event.type === "toolcall_delta" ? event.delta : "", false);
				}
				case "toolcall_end":
					return call(event.contentIndex, event.toolCall, "", true);
				case "done":
					return (
						chunk({}, OPENAI_STOP[event.reason] ?? "stop") +
						(includeUsage ? frame({ ...base, choices: [], usage: openAIUsage(event.message.usage) }) : "") +
						"data: [DONE]\n\n"
					);
				case "error":
					return fail(upstreamError(event.error).message);
				default:
					return "";
			}
		},
	};
}

/** Server-sent events of a Messages stream. */
export function anthropicStream(name: string, model: Model<Api>): StreamEncoder {
	const frame = (type: string, value: Json = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
	/** Blocks open in the stream, by pi's content index, as the stream numbers them. */
	const open = new Map<number, number>();
	const slots = new Map<number, CallSlot>();
	let next = 0;

	const start = (contentIndex: number, block: Json): string => {
		open.set(contentIndex, next);
		return frame("content_block_start", { index: next++, content_block: block });
	};
	const delta = (contentIndex: number, value: Json): string => {
		const index = open.get(contentIndex);
		return index === undefined ? "" : frame("content_block_delta", { index, delta: value });
	};
	const stop = (contentIndex: number): string => {
		const index = open.get(contentIndex);
		if (index === undefined) return "";
		open.delete(contentIndex);
		return frame("content_block_stop", { index });
	};

	const call = (contentIndex: number, block: ToolCall | undefined, text: string, end: boolean): string => {
		let slot = slots.get(contentIndex);
		if (!slot) slots.set(contentIndex, (slot = { open: false, pending: "", streamed: false }));
		const args = (json: string) => delta(contentIndex, { type: "input_json_delta", partial_json: json });
		let out = "";
		if (!slot.open && block && ((block.name && block.id) || end)) {
			slot.open = true;
			out += start(contentIndex, { type: "tool_use", id: callId(block.id), name: block.name, input: {} });
			if (slot.pending) {
				out += args(slot.pending);
				slot.streamed = true;
			}
		}
		if (text) {
			if (slot.open) {
				out += args(text);
				slot.streamed = true;
			} else slot.pending += text;
		}
		if (end) {
			if (block && !slot.streamed) out += args(JSON.stringify(block.arguments));
			out += stop(contentIndex);
		}
		return out;
	};

	const fail = (message: string) => frame("error", { error: { type: "api_error", message } });
	return {
		fail,
		push(event) {
			switch (event.type) {
				case "start":
					return frame("message_start", {
						message: {
							id: `msg_${randomUUID().replaceAll("-", "")}`,
							type: "message",
							role: "assistant",
							model: name,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: anthropicUsage(event.partial.usage),
						},
					});
				case "text_start":
					return start(event.contentIndex, { type: "text", text: "" });
				case "text_delta":
					return event.delta ? delta(event.contentIndex, { type: "text_delta", text: event.delta }) : "";
				case "thinking_start": {
					const block = blockAt(event);
					return block?.type === "thinking" && block.redacted
						? start(event.contentIndex, { type: "redacted_thinking", data: seal(model, block.thinkingSignature) })
						: start(event.contentIndex, { type: "thinking", thinking: "", signature: "" });
				}
				case "thinking_delta":
					return event.delta ? delta(event.contentIndex, { type: "thinking_delta", thinking: event.delta }) : "";
				case "thinking_end": {
					const block = blockAt(event);
					const signed = block?.type === "thinking" && !block.redacted ? delta(event.contentIndex, { type: "signature_delta", signature: seal(model, block.thinkingSignature) }) : "";
					return signed + stop(event.contentIndex);
				}
				case "text_end":
					return stop(event.contentIndex);
				case "toolcall_start":
				case "toolcall_delta": {
					const block = blockAt(event);
					return call(event.contentIndex, block?.type === "toolCall" ? block : undefined, event.type === "toolcall_delta" ? event.delta : "", false);
				}
				case "toolcall_end":
					return call(event.contentIndex, event.toolCall, "", true);
				case "done":
					return (
						[...open.keys()].map(stop).join("") +
						frame("message_delta", {
							delta: { stop_reason: ANTHROPIC_STOP[event.reason] ?? "end_turn", stop_sequence: null },
							usage: anthropicUsage(event.message.usage),
						}) +
						frame("message_stop")
					);
				case "error":
					return fail(upstreamError(event.error).message);
				default:
					return "";
			}
		},
	};
}
