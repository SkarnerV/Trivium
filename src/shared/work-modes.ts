/** Work modes change Code's guidance through a pi extension; permissions remain a separate preference. */
export type WorkModeId = "default" | "orchestrator";

export const WORK_MODES: { id: WorkModeId; label: string; hint: string }[] = [
	{ id: "default", label: "Default", hint: "Works on the task itself, and uses subagents when it decides to." },
	{ id: "orchestrator", label: "Orchestrator", hint: "Hands large tasks to subagents in the background: scouts that read, and one writer at a time that has your own words. Then checks the result here." },
];

export const isWorkMode = (value: unknown): value is WorkModeId => value === "default" || value === "orchestrator";
