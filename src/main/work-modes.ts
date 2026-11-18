import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppId } from "../shared/protocol.ts";
import { isWorkMode, type WorkModeId } from "../shared/work-modes.ts";

/**
 * Compact standing instructions; parameter names follow pi-subagents 0.82.1's execution schema.
 *
 * The two call shapes are spelled out with an example because naming the parts was not enough: told only to "use
 * runs.all" and "supply options.preflight", a model put `runs` inside `options` and a preflight on a single child,
 * the extension rejected both, and the model gave up delegating. A workflow's children are named in a script, not
 * in the tool call, and a preflight is accepted only with such a script.
 *
 * The script goes in a file, not in a fenced block of the reply, which the extension also accepts: a model that
 * writes prose before its tool call leaves the block out, and the call is rejected. The file goes under
 * .pi/subagents/ because anywhere else in the project it is an uncommitted change, and the extension refuses to
 * start worktree writers from a folder that has any; that folder is the one it leaves out of the check.
 */
export const ORCHESTRATOR_PROMPT = `The user chose Orchestrator work mode. This is standing authorization to delegate with subagent. If subagent is not active, call subagents_enable first.
Do small tasks directly. For large tasks, scout before deciding a split, then announce the split in one or two sentences. Fan out scouts and reviewers freely. Use ONE writer by default. Parallel writers require disjoint files and no undecided shared interface; each must be a workflow child with worktree: true.
One child: call subagent({agent, task, async: false}) with no options.
Several children: first write a workflow script with the write tool to a file under .pi/subagents/ in the project, such as .pi/subagents/implement.js (only that folder is not counted as an uncommitted change), then call subagent({workflow: "./.pi/subagents/implement.js", async: false, options: {globalConcurrencyLimit: 4, preflight}}). The script names the children, for example:
const results = await runs.all([
  { key: "api", label: "Implement the API", agent: "worker", task: "...", worktree: true },
  { key: "tests", label: "Review the tests", agent: "reviewer", task: "..." }
]);
return results.map((result) => result.output);
runs.all, the children and worktree belong in that script, never in options. preflight is {version: 1, coverage: "complete", lanes: [{key, mode, claims}]}: one lane per child with the same key, mode "mutation" for writers and "scout" or "review" for readers, and for writers claims naming the files they will change. Use one workflow call per phase. If a call is rejected, read the error, correct the call and try again before working without subagents.
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

	/**
	 * A new session takes Settings → Code's default. Only Code sessions in a project have a mode: a chat has no
	 * repository to split work over, and Research and Write never change behavior.
	 */
	async created(id: string, app: AppId, inProject: boolean, setting: unknown): Promise<void> {
		if (app === "code" && inProject && isWorkMode(setting)) await this.set(id, setting);
	}

	/** A fork works as the session it came from. */
	forked(from: string, to: string): Promise<void> {
		return this.set(to, this.get(from));
	}

	/**
	 * A session unloaded before its first message has no file yet, and opening it again makes a new session id. The
	 * host keeps its mode with the rest of what it needs to start it again, and hands it back to reopened().
	 */
	unsaved(id: string, app: AppId): WorkModeId | undefined {
		return app === "code" ? this.get(id) : undefined;
	}

	async reopened(id: string, mode: WorkModeId | undefined): Promise<void> {
		if (mode) await this.set(id, mode);
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
