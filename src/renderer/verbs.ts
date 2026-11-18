import type { Run, Step } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
import { agentCounts } from "./agents.ts";

/**
 * What the agent is doing in a step, said as it happens. `live` is the thread's live line ("Running" before the
 * command); `now` is the same verb as the Agents tab's whole sentence ("Now: running npm test"). They share one
 * table so the two places never describe a step differently. Each is a whole sentence key for translation.
 */
export const VERBS: Record<string, { live: string; now: string }> = {
	read: { live: "Reading", now: "Now: reading {target}" },
	edit: { live: "Editing", now: "Now: editing {target}" },
	write: { live: "Writing", now: "Now: writing {target}" },
	bash: { live: "Running", now: "Now: running {target}" },
	// The shell tool on Windows; a command there reads the same as one run through bash.
	powershell: { live: "Running", now: "Now: running {target}" },
	grep: { live: "Searching for", now: "Now: searching for {target}" },
	find: { live: "Finding", now: "Now: finding {target}" },
	ls: { live: "Listing", now: "Now: listing {target}" },
	think: { live: "Thinking", now: "Now: thinking" },
};

/** The thread's live label for a step: "Reading", or "Using {tool}" for a tool without a verb. */
export function liveVerb(step: Step): string {
	const verb = VERBS[step.tool];
	return verb ? t(verb.live) : t("Using {tool}", { tool: step.tool });
}

/**
 * The Agents tab's Now line: what the main agent is doing at this moment, from the same current step the thread's
 * live line shows. It states what is happening, never what comes next.
 */
export function nowLine(run: Run | undefined, current: Step | undefined): string {
	if (current?.subagent) {
		const { running } = agentCounts([run!]);
		if (running) return t(running === 1 ? "Now: waiting for 1 agent" : "Now: waiting for {n} agents", { n: running });
	}
	if (current && current.tool !== "subagent") {
		const verb = VERBS[current.tool];
		return verb ? t(verb.now, { target: current.target }) : t("Now: using {tool}", { tool: current.tool });
	}
	if (run?.answer) return t("Now: writing the answer");
	return t("Now: working on it");
}
