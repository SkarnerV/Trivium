/** Work modes change Code's guidance through a pi extension; permissions remain a separate preference. */
export type WorkModeId = "default" | "orchestrator";

export const WORK_MODES: { id: WorkModeId; label: string; hint: string }[] = [
	{ id: "default", label: "Default", hint: "Works on the task itself, and uses subagents when it decides to." },
	{ id: "orchestrator", label: "Orchestrator", hint: "Splits large tasks across subagents: scouts first, one writer unless parts touch separate files, then applies and tests here." },
];

export const isWorkMode = (value: unknown): value is WorkModeId => value === "default" || value === "orchestrator";
