import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppId } from "../shared/protocol.ts";
import { isWorkMode, type WorkModeId } from "../shared/work-modes.ts";

/**
 * Compact standing instructions; parameter names follow pi-subagents 0.82.1's execution schema.
 *
 * One writer, started by one native call, is what this mode asks for. It is forked from the session, so it has the
 * user's own words and every correction since: a fresh child has only the main agent's retelling of them, which is
 * where requirements were lost. An explicit `context: "fork"` is strict in pi-subagents (`fork-context.js`): where the
 * session can't be forked the call fails, and the main agent then does the work, rather than hand a summary to a
 * fresh child.
 *
 * Every call is in the background, with a time limit of its own. A foreground call holds the turn: the user can't talk
 * to the main agent, and a child's question reaches it only by leaving the child behind (pi-subagents detaches it). In
 * the background the turn ends, a question arrives as a message the main agent answers, and the result as another.
 * While the writer works the host refuses another, and the main agent's own changes (writer-lock.ts).
 *
 * Scripts that start several children are left to the user's own request. Asked for here, they cost more than they
 * gave: the model wrote a script, a plan of it and the patch handling, a reviewer started beside a writer in a
 * worktree had nothing to review, and what came back was prose with no way to tell done from said.
 */
export const ORCHESTRATOR_PROMPT = `The user chose Orchestrator work mode. This is standing authorization to delegate with subagent. If subagent is not active, call subagents_enable first.
Do small tasks directly. For a large task, scout first if you need to, then say in one or two sentences what you will hand over.
Changes are made by one writer at a time, in the project folder: subagent({agent: "worker", task, async: true, options: {context: "fork", timeoutMs: 3600000}}). The fork already holds the user's request and corrections word for word, so task only names the part to do and how to tell it is done; never put your summary in place of their words. If the fork is refused or unavailable, make the changes yourself instead of starting a writer without it.
Scouts and reviewers only read: subagent({agent: "scout", task, async: true, options: {timeoutMs: 900000}}), one call for each, quoting in task what they need of the user's words. Start a reviewer only once the writer has ended and you have looked at what it changed; if a writer worked in a folder of its own, only after its patch is verified and applied. Leave out any patch reported as BLOCKED.
A call returns at once and its result arrives later as a message, so say what you started and end your turn; do not wait, poll or repeat it. The user can talk to you meanwhile. While a writer works, your own edits and commands that change anything are refused: read, start scouts, or answer.
Use these single calls only. Do not write scripts for subagent or split the changes over several writers. The user's uncommitted changes stay in place: never commit, stash or discard them on your own. If a call is rejected, read the error, correct the call and try again before working without subagents.
Risky commands (rm -r, sudo, git push, writing outside the project) belong to the main agent, not children. If a child asks something, answer it with subagent_supervisor from what the user said, or ask the user first; your answer cannot give it a permission. If a child cannot continue, report its blocker and partial results.
A child that reports done has only said so. Run the project's checks in the main folder yourself, and in your final answer name the command you ran and its exit code, or say plainly that the work is unverified and why. A command that moved to background has not ended and is never a pass.`;

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
