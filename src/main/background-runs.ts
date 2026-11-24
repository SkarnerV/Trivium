import { readFile, stat } from "node:fs/promises";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BackgroundState, Run, Step } from "../shared/protocol.ts";
import { agentCounts, endedAs } from "../shared/agent-counts.ts";
import { asyncRunRoots, type ExtensionRoots, trustedPath } from "./extension-paths.ts";

/**
 * Whether a background subagent is still running, from evidence rather than from the absence of its completion
 * notice. The notice can fail to arrive here: the app restarted, the run was killed, or its ids do not match.
 *
 * The evidence is the run's own `status.json`, which pi-subagents 0.82.1 keeps in the launch's `asyncDir`
 * (`<temp root>/async-subagent-runs/<id>/status.json`; `src/runs/background/async-execution.js` returns `asyncId`
 * and `asyncDir` in the launch details, and `subagent-runner.js` writes `state`, `pid` and `lastUpdate`). The host
 * only reads it. A run counts as running when:
 *
 * - its status says `running` or `queued`, and
 * - the runner's recorded pid is alive (`process.kill(pid, 0)`), and
 * - the status was written during this boot and updated within the last {@link STALE_STATUS_MS}, as the extension's
 *   own stale-run reconciler bounds a status whose pid cannot be trusted; or
 * - it was launched by this process less than {@link LAUNCH_GRACE_MS} ago and its status is not written yet.
 *
 * A `paused` run is still running while its process lives and it has not ended: its runner is winding down after an
 * interrupt, or a workflow's script ended with a child waiting for an answer (a step `paused` with
 * `needs_attention`), which goes on in this process.
 *
 * Anything else is not running: a finished state maps to how it ended, and a missing, unreadable or out-of-place
 * status file, a dead runner or a stale status is `gone`, shown as "no result arrived here". So no child can show
 * running forever, and a session whose only child has no evidence of life can be unloaded. `gone` is looked at again
 * for {@link GONE_RECHECK_MS}: a status can be late, or between two writes, and then says the run lives.
 *
 * A single foreground child that asks its supervisor something is detached: its call ends with exit code -2 and no
 * run folder, and it goes on inside this process. It is tracked by its run id from then until its completion notice,
 * or until the time its call was given has passed. After a restart there is nothing left of one to be running.
 */
export const LAUNCH_GRACE_MS = 15_000;
export const STALE_STATUS_MS = 6 * 60 * 60_000;
export const GONE_RECHECK_MS = 10 * 60_000;
/**
 * How long a run that ended may take to deliver its result. Its session stays loaded for it: the extension delivers to
 * the session that started the run, and throws when that one was unloaded in between.
 */
export const RESULT_GRACE_MS = 60_000;
/** What a detached child may take past its own time limit to end and say so. */
export const DETACHED_GRACE_MS = 2 * 60_000;

/**
 * How long the Changes tracker may attribute project edits to a background launch. A background child edits the
 * project with no tool call of the main agent around it, so the tracker keeps the snapshot from before the launch
 * open, and adopts what changed when the window closes. Any edit made in the window counts as the session's, the
 * user's included, so it must be short and certain to end. It closes at the first of:
 *
 * - the completion notice whose run ids include the launch's `asyncId`;
 * - the run's status showing it is not running (see above), checked every {@link POLL_MS};
 * - {@link CHANGES_WINDOW_MS} after the launch, whatever the run is doing;
 * - the session being unloaded, or the app quitting: the window lives in memory only, and a session reopened from
 *   its file, after a restart or not, never opens one for an earlier launch.
 *
 * After it closes, the next command takes a fresh snapshot, so later edits, by the user or a child still running,
 * are not adopted as the session's and Revert does not undo them.
 */
export const CHANGES_WINDOW_MS = 30 * 60_000;
export const POLL_MS = 5_000;

const ACTIVE = new Set(["running", "queued"]);
const ENDED: Record<string, BackgroundState> = { complete: "done", failed: "error", partial: "error", rejected: "error", stopped: "stopped" };
/** How a completion notice says a run ended. */
const NOTICED: Record<string, BackgroundState> = { completed: "done", failed: "error", stopped: "stopped", paused: "stopped" };

export interface Evidence {
	now: number;
	/** When this process launched the run; undefined for one read back from the session's history. */
	launchedAt?: number;
	/** When the machine started, so a status written before it cannot vouch for a pid. */
	bootedAt: number;
	alive: (pid: number) => boolean;
}

/** The run's state from its status file's contents (null when there is no readable file). */
export function stateFromStatus(status: unknown, evidence: Evidence): BackgroundState {
	const record = status && typeof status === "object" && !Array.isArray(status) ? (status as Record<string, unknown>) : undefined;
	if (!record) return evidence.launchedAt !== undefined && evidence.now - evidence.launchedAt < LAUNCH_GRACE_MS ? "running" : "gone";
	const state = typeof record.state === "string" ? record.state : "";
	if (ENDED[state]) return ENDED[state]!;
	const paused = state === "paused";
	if (!paused && !ACTIVE.has(state)) return "gone";
	const updated = [record.lastUpdate, record.startedAt].find((value): value is number => typeof value === "number" && Number.isFinite(value));
	const fresh = updated !== undefined && updated >= evidence.bootedAt && evidence.now - updated <= STALE_STATUS_MS;
	const pid = typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
	if (paused) {
		// Its process must be known to live: a pause is also how an interrupted run ends.
		const waiting = Array.isArray(record.steps) && record.steps.some((step) => step?.status === "paused" && step?.activityState === "needs_attention");
		return fresh && pid !== undefined && evidence.alive(pid) && (record.endedAt === undefined || waiting) ? "running" : "stopped";
	}
	if (!fresh || (pid !== undefined && !evidence.alive(pid))) return "gone";
	return "running";
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// It exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The run's status.json, or null. Only a folder named for the run, directly in the extension's async-run folder,
 * is read, and only a small file: the path comes from extension-owned JSON in the session file.
 */
export async function readRunStatus(asyncDir: string, id: string, roots: ExtensionRoots = asyncRunRoots()): Promise<unknown> {
	const dir = await trustedPath(asyncDir, roots);
	if (!dir || basename(dir) !== id || basename(dirname(dir)) !== "async-subagent-runs") return null;
	try {
		const file = join(dir, "status.json");
		if ((await stat(file)).size > 1024 * 1024) return null;
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

interface Tracked {
	asyncDir?: string;
	launchedAt?: number;
	state: BackgroundState;
	/** Open while this process may still adopt the run's edits into the session's changes. */
	window?: number;
	/** A detached foreground child, alive in this process: when it must have ended. It has no status to read. */
	until?: number;
	/** When it was found gone, to look again for a while. */
	goneAt?: number;
	/** When its status said it ended, until its notice arrives. */
	unreportedSince?: number;
	/** Who it is, when it may change files: what the writer lock names (writer-lock.ts). */
	writer?: string;
}

/** One session's background runs: what each is doing now, and the Changes window each launch opened. */
export class BackgroundRuns {
	private runs = new Map<string, Tracked>();
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private readonly read: (asyncDir: string, id: string) => Promise<unknown>;
	private readonly now: () => number;
	private readonly alive: (pid: number) => boolean;
	private readonly bootedAt: number;
	private readonly closeWindow: () => Promise<unknown>;
	private readonly openWindow?: () => Promise<unknown>;
	private readonly onChange: () => void;
	private readonly poll: boolean;
	private readonly writerOf?: (input: Record<string, unknown>) => string | undefined;

	constructor(options: {
		closeWindow: () => Promise<unknown>;
		/** Opens a window again for a run that turned out to live after its first was closed. */
		openWindow?: () => Promise<unknown>;
		onChange: () => void;
		read?: (asyncDir: string, id: string) => Promise<unknown>;
		now?: () => number;
		alive?: (pid: number) => boolean;
		bootedAt?: number;
		/** False in tests, which call refresh() themselves. */
		poll?: boolean;
		/** Who a launch read back from the history would have write, from its call's input. */
		writerOf?: (input: Record<string, unknown>) => string | undefined;
	}) {
		this.closeWindow = options.closeWindow;
		this.openWindow = options.openWindow;
		this.onChange = options.onChange;
		this.read = options.read ?? ((asyncDir, id) => readRunStatus(asyncDir, id));
		this.now = options.now ?? Date.now;
		this.alive = options.alive ?? pidAlive;
		this.bootedAt = options.bootedAt ?? Date.now() - uptime() * 1000;
		this.poll = options.poll ?? true;
		this.writerOf = options.writerOf;
	}

	/** A launch this process made: it runs until its status says otherwise, and its edits may be adopted for now. */
	launched(id: string, asyncDir: string | undefined, writer?: string): void {
		const now = this.now();
		this.runs.set(id, { asyncDir, launchedAt: now, state: "running", window: now, writer });
		this.schedule();
	}

	/** A foreground child left running by its call, in this process: it runs until its notice arrives or its time is up. */
	detached(id: string, timeoutMs?: number, writer?: string): void {
		const now = this.now();
		this.runs.set(id, { launchedAt: now, state: "running", window: now, writer, until: now + (timeoutMs === undefined ? STALE_STATUS_MS : timeoutMs + DETACHED_GRACE_MS) });
		this.schedule();
	}

	/** Launches read back from the session's history, minus those a notice in it already answered. */
	async restore(runs: Run[]): Promise<void> {
		// A pause does not end a run on its own; its status says whether it did.
		const answered = new Set(runs.flatMap((run) => (run.notice?.status === "paused" ? [] : (run.notice?.runIds ?? []))));
		for (const step of runs.flatMap((run) => run.steps)) {
			for (const child of step.subagent?.children ?? []) {
				// It lived in the process that started it, which is gone with the session that was open then.
				if (child.detached && child.runId && !this.runs.has(child.runId)) this.runs.set(child.runId, { state: "gone" });
			}
			const id = step.subagent?.background ? step.subagent.asyncId : undefined;
			if (id && !answered.has(id) && !this.runs.has(id)) this.runs.set(id, { asyncDir: step.subagent!.asyncDir, state: "running", writer: this.writerIn(step) });
		}
		await this.refresh();
		this.schedule();
	}

	/**
	 * A completion notice arrived: its runs ended, as it says, however their own status files read. One that says a
	 * background run paused ends it only if its status agrees.
	 */
	async finished(ids: unknown[], statuses: ReadonlyMap<string, string> = new Map()): Promise<void> {
		for (const id of ids) {
			const run = typeof id === "string" ? this.runs.get(id) : undefined;
			if (!run) continue;
			const status = statuses.get(id as string);
			if (status === "paused" && run.asyncDir && (await this.readState(id as string, run)) === "running") continue;
			if (run.state === "running" || run.goneAt !== undefined) run.state = NOTICED[status ?? "completed"] ?? "done";
			run.goneAt = undefined;
			run.unreportedSince = undefined;
			await this.close(run);
		}
	}

	/**
	 * How many runs are still going, whether or not the launch's details list the children that are, or ended so lately
	 * that their result may still be on its way.
	 */
	liveRuns(): number {
		const now = this.now();
		return [...this.runs.values()].filter((run) => run.state === "running" || (run.unreportedSince !== undefined && now - run.unreportedSince < RESULT_GRACE_MS)).length;
	}

	/** A run still going that may change files, as the writer lock names it. */
	liveWriter(): string | undefined {
		for (const [id, run] of this.runs) if (run.state === "running" && run.writer) return `${run.writer} (run ${id})`;
		return undefined;
	}

	private writerIn(step: Step): string | undefined {
		if (!this.writerOf) return undefined;
		let input: unknown;
		try {
			input = JSON.parse(step.input ?? "");
		} catch {
			// What it was can't be read, so it may write.
		}
		return input && typeof input === "object" ? this.writerOf(input as Record<string, unknown>) : "a subagent";
	}

	private async readState(id: string, run: Tracked): Promise<BackgroundState> {
		const now = this.now();
		if (run.until !== undefined) return now < run.until ? "running" : "gone";
		const status = run.asyncDir ? await this.read(run.asyncDir, id) : null;
		return stateFromStatus(status, { now, launchedAt: run.launchedAt, bootedAt: this.bootedAt, alive: this.alive });
	}

	/** Found gone not long ago: its status may only have been late. */
	private rechecked(run: Tracked): boolean {
		return run.state === "gone" && run.goneAt !== undefined && run.asyncDir !== undefined && this.now() - run.goneAt < GONE_RECHECK_MS;
	}

	state(id: string | undefined): BackgroundState | undefined {
		return id ? this.runs.get(id)?.state : undefined;
	}

	/** Re-reads every run counted as running or only just gone, and closes windows that are due. Says whether anything changed. */
	async refresh(): Promise<boolean> {
		let changed = false;
		const now = this.now();
		for (const [id, run] of this.runs) {
			if (run.state === "running" || this.rechecked(run)) {
				const state = await this.readState(id, run);
				if (state !== run.state) {
					if (state === "gone") run.goneAt = now;
					// Its window closed when it seemed gone; what it edits from here on is its own again.
					const revived = run.state === "gone" && state === "running";
					run.state = state;
					run.unreportedSince = state === "running" || run.launchedAt === undefined ? undefined : now;
					changed = true;
					if (revived && this.openWindow && run.launchedAt !== undefined && now - run.launchedAt < CHANGES_WINDOW_MS) {
						await this.openWindow().catch(() => {});
						run.window = run.launchedAt;
					}
				}
			}
			if (run.window !== undefined && (run.state !== "running" || now - run.window >= CHANGES_WINDOW_MS)) {
				await this.close(run);
				changed = true;
			}
		}
		return changed;
	}

	/** True while a window is open, which is what keeps the Changes tracker's pre-launch snapshot. */
	windowsOpen(): number {
		return [...this.runs.values()].filter((run) => run.window !== undefined).length;
	}

	/** The session is going: windows close without adopting, and nothing polls any more. */
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		for (const run of this.runs.values()) run.window = undefined;
	}

	private async close(run: Tracked): Promise<void> {
		if (run.window === undefined) return;
		run.window = undefined;
		await this.closeWindow().catch(() => {});
	}

	private schedule(): void {
		if (!this.poll || this.disposed || this.timer) return;
		if (![...this.runs.values()].some((run) => run.state === "running" || run.window !== undefined || this.rechecked(run))) return;
		this.timer = setTimeout(async () => {
			this.timer = undefined;
			if (this.disposed) return;
			if (await this.refresh().catch(() => false)) this.onChange();
			this.schedule();
		}, POLL_MS);
		this.timer.unref?.();
	}
}

/** A session's agent counts for the sidebar, counted as the renderer counts them. */
export function agentsOf(runs: Run[], background: BackgroundRuns): { running: number; waiting: number } {
	return agentCounts(markBackground(runs, background));
}

/** Whether a session still has children at work, so it must stay loaded: a child detached in it would die with it. */
export function hasLiveAgents(runs: Run[], background: BackgroundRuns): boolean {
	return agentsOf(runs, background).running > 0 || background.liveRuns() > 0;
}

/**
 * Tells when a session's agent counts changed, so the host refreshes the session list then. The sidebar row of a
 * session that is not on screen has no view to count from; its count comes from that list.
 */
export class AgentCountWatch {
	private last = "0:0";

	changed(counts: { running: number; waiting: number }): boolean {
		const key = `${counts.running}:${counts.waiting}`;
		if (key === this.last) return false;
		this.last = key;
		return true;
	}
}

/** Marks each background launch with what its run is doing now, for the view and for counting. */
export function markBackground(runs: Run[], background: BackgroundRuns): Run[] {
	for (const step of runs.flatMap((run) => run.steps)) {
		const subagent = step.subagent;
		if (subagent?.children.some((child) => child.detached)) {
			subagent.children = subagent.children.map((child) => (child.detached ? endedAs(child, background.state(child.runId) ?? "gone") : child));
		}
		if (!subagent?.background || !subagent.asyncId) continue;
		const state = background.state(subagent.asyncId);
		// A launch the host has no record of (its details had no asyncDir) cannot show it is alive.
		subagent.backgroundState = state ?? "gone";
	}
	return runs;
}
