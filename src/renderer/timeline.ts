import type { Step } from "../shared/protocol.ts";

/**
 * A stretch of a run, in the order it happened: something the agent said between tool calls, or the steps
 * it took between two of those.
 */
export type Block = { kind: "note"; id: string; text: string } | { kind: "steps"; id: string; steps: Step[] };

/**
 * Splits a run's steps where the agent spoke. Some models save what they have to say for the answer and
 * others say it as they go, so a note is shown like the answer rather than folded in with the tool calls.
 */
export function blocksOf(steps: Step[]): Block[] {
	const blocks: Block[] = [];
	for (const step of steps) {
		if (step.tool === "note") {
			const text = (step.content ?? step.target).trim();
			if (text) blocks.push({ kind: "note", id: step.id, text });
			continue;
		}
		const last = blocks.at(-1);
		if (last?.kind === "steps") last.steps.push(step);
		else blocks.push({ kind: "steps", id: step.id, steps: [step] });
	}
	return blocks;
}
