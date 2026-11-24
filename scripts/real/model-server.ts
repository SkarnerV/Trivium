import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted model behind an OpenAI-compatible endpoint. pi-subagents runs children in this process, in its own
 * runner process and in worktrees, and all of them read the same models.json, so a local server reaches every one
 * without a provider extension, a key or the network.
 *
 * A prompt names its script with a marker such as `@@writer@@`. The marker in the latest user message that has one
 * picks the script, and the assistant messages after it pick the step, so a forked child, whose history carries the
 * parent's marker too, still follows its own.
 */
export interface ModelMessage {
	role: string;
	content?: unknown;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

export interface Reply {
	text?: string;
	tools?: { name: string; input: Record<string, unknown> }[];
	/** Wait before answering, so a child is still alive while the test looks. */
	delayMs?: number;
}

export type Step = (messages: ModelMessage[]) => Reply | Promise<Reply>;

export function messageText(message: ModelMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("\n");
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

export class ModelServer {
	readonly scripts = new Map<string, Step[]>();
	/** Every request's messages and tools, by script, for checking what an agent was told. */
	readonly seen: { script: string; step: number; messages: ModelMessage[]; tools: string[] }[] = [];
	private server: Server | undefined;

	async start(): Promise<string> {
		this.server = createServer((request, response) => {
			void this.answer(request)
				.then(({ reply, id }) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					const write = (value: unknown) => response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "scripted", ...(value as object) })}\n\n`);
					const send = (delta: unknown, finish: string | null = null) => write({ choices: [{ index: 0, delta, finish_reason: finish }] });
					send({ role: "assistant", content: reply.text ?? "" });
					for (const [index, tool] of (reply.tools ?? []).entries()) {
						send({ tool_calls: [{ index, id: `call_${id}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] });
					}
					send({}, reply.tools?.length ? "tool_calls" : "stop");
					write({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
					response.end("data: [DONE]\n\n");
				})
				.catch((error: unknown) => {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: String(error) } }));
				});
		});
		await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
		return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections();
		await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
	}

	private async answer(request: IncomingMessage): Promise<{ reply: Reply; id: string }> {
		const body = JSON.parse(await readBody(request)) as { messages: ModelMessage[]; tools?: { function: { name: string } }[] };
		const { messages } = body;
		let script = "";
		let from = -1;
		for (let index = messages.length - 1; index >= 0 && from < 0; index--) {
			if (messages[index]!.role !== "user") continue;
			const marks = [...messageText(messages[index]!).matchAll(/@@([\w-]+)@@/g)];
			if (!marks.length) continue;
			script = marks.at(-1)![1]!;
			from = index;
		}
		const steps = this.scripts.get(script);
		const step = messages.slice(from + 1).filter((message) => message.role === "assistant").length;
		this.seen.push({ script, step, messages, tools: (body.tools ?? []).map((tool) => tool.function.name) });
		const id = `r${this.seen.length}`;
		if (!steps?.length) return { reply: { text: "No script for this prompt." }, id };
		const reply = await steps[Math.min(step, steps.length - 1)]!(messages);
		if (reply.delayMs) await new Promise((done) => setTimeout(done, reply.delayMs));
		return { reply, id };
	}
}
