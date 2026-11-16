import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWorkMode, type WorkModeId } from "../shared/work-modes.ts";

/** Compact standing instructions; parameter names follow pi-subagents 0.82.1's execution schema. */
export const ORCHESTRATOR_PROMPT = `The user chose Orchestrator work mode. This is standing authorization to delegate with subagent. If subagent is not active, call subagents_enable first.
Do small tasks directly. For large tasks, scout before deciding a split, then announce the split in one or two sentences. Fan out scouts and reviewers freely. Use ONE writer by default. Parallel writers require disjoint files and no undecided shared interface; each must be a workflow child with worktree: true.
Use one subagent workflow call per phase with async: false and options.globalConcurrencyLimit: 4. Always supply options.preflight: {version: 1, coverage: "complete", lanes: [...]}, one lane per child with its key and mode (mutation for writers, scout or review for readers); writers must list claims naming their files. Use runs.all for the phase's children.
After writers finish, apply each child's patch one at a time using git apply <patch path>, then run the project's checks in the main folder. Fresh worktrees have no installed dependencies. If the working tree has uncommitted changes, use one writer in the project folder or tell the user; never commit or stash the user's work on your own.
Risky commands (rm -r, sudo, git push, writing outside the project) belong to the main agent, not children. If a child cannot continue, report its blocker and partial results; handle any needed user question in the main session.`;

export function workModePrompt(systemPrompt: string, mode: WorkModeId): string {
	return mode === "orchestrator" ? `${systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` : systemPrompt;
}

/** Read at the run boundary so changing modes does not require recreating a pi session. */
export function workModeExtension(mode: () => WorkModeId) {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => mode() === "orchestrator" ? { systemPrompt: workModePrompt(event.systemPrompt, "orchestrator") } : undefined);
	};
}

/** A small independent index beside session-apps.json; old sessions always start in Default. */
export class WorkModeIndex {
	private modes: Record<string, WorkModeId> = {};
	private saving = Promise.resolve();
	private file: string;

	constructor(file: string) {
		this.file = file;
		try {
			const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (saved && typeof saved === "object" && !Array.isArray(saved)) {
				for (const [id, mode] of Object.entries(saved)) if (isWorkMode(mode)) this.modes[id] = mode;
			}
		} catch { /* Missing or damaged preferences never change a session's behavior. */ }
	}

	get(id: string): WorkModeId { return this.modes[id] ?? "default"; }

	set(id: string, mode: WorkModeId): Promise<void> {
		this.modes[id] = mode;
		return this.save();
	}

	delete(id: string): Promise<void> {
		delete this.modes[id];
		return this.save();
	}

	private save(): Promise<void> {
		const text = JSON.stringify(this.modes, null, 2);
		this.saving = this.saving.catch(() => {}).then(async () => {
			await writeFile(`${this.file}.tmp`, text, { mode: 0o600 });
			await rename(`${this.file}.tmp`, this.file);
		});
		return this.saving;
	}
}
