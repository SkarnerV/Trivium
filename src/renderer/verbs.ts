import type { Step } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";

/** What the agent is doing in a step, said as it happens, before its target: "Running" npm test. Each is a key for translation. */
export const VERBS: Record<string, string> = {
	read: "Reading",
	edit: "Editing",
	write: "Writing",
	bash: "Running",
	// The shell tool on Windows; a command there reads the same as one run through bash.
	powershell: "Running",
	grep: "Searching for",
	find: "Finding",
	ls: "Listing",
	think: "Thinking",
};

/** The thread's live label for a step: "Reading", or "Using {tool}" for a tool without a verb. */
export function liveVerb(step: Step): string {
	const verb = VERBS[step.tool];
	return verb ? t(verb) : t("Using {tool}", { tool: step.tool });
}
