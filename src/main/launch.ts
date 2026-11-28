import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AppLaunchInfo, LaunchPlan, LaunchState, LaunchTaskList } from "../shared/protocol.ts";
import { type InfraManager, projectName } from "./compose.ts";
import { type AppTask, commandLine, type InfraTask, parseJsonc, readTasks, TasksFileError } from "./launch-config.ts";
import type { AppExit, ServiceTracker } from "./services.ts";

/**
 * The Launch button: starts an app from a Code project's .vscode/tasks.json, after the Docker Compose infrastructure
 * it depends on is healthy. Only the user starts it, from the window, and confirms every launch; nothing here is
 * reachable from the agent.
 */

const TASKS_FILE = join(".vscode", "tasks.json");
/** An unconfirmed plan is dropped after this long. */
const PLAN_MS = 10 * 60_000;
/** How long deleting a session waits for Docker to stop what only it held. */
const DELETE_DOWN_MS = 30_000;

/** What the Launch button needs to know about a session. */
export interface LaunchSession {
	cwd: string;
	/** A Code session with a project folder, which Launch is for. */
	eligible: boolean;
	title: string;
	shellPath?: string;
}

export interface LaunchHost {
	session(path: string): LaunchSession | undefined;
	title(path: string): string;
	/** Whether the user has said no to this project, or to undecided projects. */
	trustDenied(cwd: string): boolean;
}

/** Whether `child` is `root` or inside it, by path components, so `C:\\app2` is not inside `C:\\app`. */
export function isWithin(root: string, child: string): boolean {
	const rel = relative(root, child);
	// Another drive comes back absolute.
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** A path inside the workspace past links and junctions: its real path, or an error naming it. */
async function contained(workspace: string, path: string, what: string): Promise<string> {
	const real = await realpath(path).catch(() => {
		throw new Error(`${what} ${path} doesn't exist.`);
	});
	if (!isWithin(workspace, real)) throw new Error(`${what} ${path} is outside the project folder.`);
	return real;
}

async function digest(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

interface Plan {
	plan: LaunchPlan;
	app: AppTask;
	infra?: InfraTask & { project: string };
	workspace: string;
	shellPath?: string;
	/** The Compose files and env file as they were shown, which must not change before the launch. */
	hashes: Map<string, string>;
	expires: number;
}

interface Pending {
	cancelled: boolean;
}

export class LaunchManager {
	private readonly host: LaunchHost;
	private readonly services: ServiceTracker;
	private readonly infra: InfraManager;
	private readonly triviumDir: string;
	private readonly emitState: (state: LaunchState) => void;
	private readonly notice: (message: string, copy?: string) => void;
	private plans = new Map<string, Plan>();
	/** Launches under way, by session and label. */
	private pending = new Map<string, Pending>();
	private apps = new Map<string, AppLaunchInfo>();
	/** Sessions being deleted: nothing more starts for them. */
	private deleted = new Set<string>();
	private shuttingDown = false;

	constructor(options: {
		host: LaunchHost;
		services: ServiceTracker;
		infra: InfraManager;
		triviumDir: string;
		emit: (state: LaunchState) => void;
		notice: (message: string, copy?: string) => void;
	}) {
		this.host = options.host;
		this.services = options.services;
		this.infra = options.infra;
		this.triviumDir = options.triviumDir;
		this.emitState = options.emit;
		this.notice = options.notice;
	}

	state(): LaunchState {
		return { infra: this.infra.list(), apps: [...this.apps.values()], shuttingDown: this.shuttingDown };
	}

	emit(): void {
		this.emitState(this.state());
	}

	private session(path: string): LaunchSession {
		const session = this.host.session(path);
		if (!session?.eligible) throw new Error("Launch is for Code sessions with a project folder.");
		return session;
	}

	private blocked(session: LaunchSession): string | undefined {
		if (this.shuttingDown) return "Trivium is quitting.";
		if (this.host.trustDenied(session.cwd)) return "This project is not trusted, so Launch is off.";
		return undefined;
	}

	private async read(workspace: string) {
		const file = join(workspace, TASKS_FILE);
		if (!existsSync(file)) return { missing: true as const, launchJson: existsSync(join(workspace, ".vscode", "launch.json")) };
		const real = await contained(workspace, file, "tasks.json");
		return { tasks: readTasks(parseJsonc(await readFile(real, "utf8")), workspace) };
	}

	/** The menu: the app tasks the file has, each ready or with what is wrong. */
	async list(path: string): Promise<LaunchTaskList> {
		const session = this.session(path);
		const file = TASKS_FILE.split(sep).join("/");
		const blocked = this.blocked(session);
		if (blocked) return { file, tasks: [], hidden: 0, blocked };
		const workspace = await realpath(session.cwd);
		try {
			const read = await this.read(workspace);
			if ("missing" in read) return { file, tasks: [], hidden: 0, missing: true, launchJson: read.launchJson };
			return {
				file,
				hidden: read.tasks.hidden,
				tasks: read.tasks.apps.map((entry) => ({
					label: entry.label,
					command: entry.app ? commandLine(entry.app) : "",
					dependsOn: entry.app?.dependsOn,
					dependsDetail: entry.infra
						? [entry.infra.files.map((path) => relative(workspace, path).split(sep).join("/")).join(", "), (entry.infra.services ?? entry.infra.profiles ?? []).join(", ")].filter(Boolean).join(" · ")
						: undefined,
					error: entry.error,
				})),
			};
		} catch (error) {
			if (error instanceof TasksFileError) return { file, tasks: [], hidden: 0, error: { message: error.message, ...error.position } };
			return { file, tasks: [], hidden: 0, error: { message: error instanceof Error ? error.message : String(error) } };
		}
	}

	/**
	 * Reads a task for launching and checks everything it would touch is inside the project. Resolves with what it
	 * will run, for the confirmation; nothing runs until that is confirmed.
	 */
	async prepare(path: string, label: string): Promise<LaunchPlan> {
		const session = this.session(path);
		const blocked = this.blocked(session);
		if (blocked) throw new Error(blocked);
		const workspace = await realpath(session.cwd);
		const read = await this.read(workspace);
		if ("missing" in read) {
			throw new Error(read.launchJson ? "Nothing is set up to launch. Debug configurations aren't used; ask in the chat to set up launching." : "Nothing is set up to launch. Ask in the chat to set up launching.");
		}
		const entry = read.tasks.apps.find((task) => task.label === label);
		if (!entry) throw new Error(`There's no task called "${label}" to launch.`);
		if (entry.error || !entry.app) throw new Error(`${label}: ${entry.error}`);
		const app = entry.app;
		app.cwd = await contained(workspace, app.cwd, "options.cwd");
		const hashes = new Map<string, string>();
		let infra: Plan["infra"];
		if (entry.infra) {
			const files: string[] = [];
			for (const file of entry.infra.files) {
				const real = await contained(workspace, file, "Compose file");
				files.push(real);
				hashes.set(real, await digest(real));
			}
			const envFile = entry.infra.envFile ? await contained(workspace, entry.infra.envFile, "envFile") : undefined;
			if (envFile) hashes.set(envFile, await digest(envFile));
			const project = projectName(await realpath(this.triviumDir).catch(() => this.triviumDir), dirname(files[0]!), workspace);
			const conflict = this.infra.conflict(project, files);
			if (conflict) throw new Error(`${conflict.label} is running with other Compose files. Stop it in the Services panel before launching ${label}.`);
			infra = { ...entry.infra, files, envFile, project };
		}
		const id = randomUUID();
		const show = (file: string) => relative(workspace, file).split(sep).join("/") || ".";
		const holders = infra ? this.infra.holders(infra.project) : [];
		const plan: LaunchPlan = {
			id,
			sessionPath: path,
			label,
			shell: process.platform === "win32" ? "Git Bash" : "bash",
			command: commandLine(app),
			// Relative to the project, which it is always inside: "." is the project folder itself.
			cwd: show(app.cwd),
			envNames: Object.keys(app.env),
			infra: infra && {
				label: infra.label,
				project: infra.project,
				files: infra.files.map(show),
				envFile: infra.envFile && show(infra.envFile),
				services: infra.services,
				profiles: infra.profiles,
				build: infra.build,
				sharedWith: holders.filter((holder) => holder !== path).map((holder) => this.host.title(holder)),
				running: this.infra.get(infra.project)?.state === "running",
			},
		};
		for (const [key, old] of this.plans) if (old.expires < Date.now()) this.plans.delete(key);
		this.plans.set(id, { plan, app, infra, workspace, shellPath: session.shellPath, hashes, expires: Date.now() + PLAN_MS });
		return plan;
	}

	cancel(id: string): void {
		this.plans.delete(id);
	}

	/**
	 * Runs a confirmed plan once. Resolves as soon as it has started, so the window stays free while images pull and
	 * healthchecks run; refuses when the same app is already starting or running in the session, or when a Compose
	 * file or env file changed while the confirmation was open.
	 */
	async start(id: string): Promise<void> {
		const entry = this.plans.get(id);
		this.plans.delete(id);
		if (!entry || entry.expires < Date.now()) throw new Error("This launch is out of date. Run Launch again.");
		const { plan } = entry;
		const key = `${plan.sessionPath}\0${plan.label}`;
		if (this.shuttingDown) throw new Error("Trivium is quitting.");
		if (this.deleted.has(plan.sessionPath)) throw new Error("This session is being deleted.");
		if (this.pending.has(key)) throw new Error(`${plan.label} is already starting.`);
		if (this.services.launched(plan.sessionPath, plan.label)) throw new Error(`${plan.label} is already running. Stop it first.`);
		const session = this.session(plan.sessionPath);
		if (this.host.trustDenied(session.cwd)) throw new Error("This project is not trusted, so Launch is off.");
		const pending: Pending = { cancelled: false };
		this.pending.set(key, pending);
		try {
			for (const [file, hash] of entry.hashes) {
				const now = await digest(file).catch(() => undefined);
				if (now !== hash) throw new Error(`Not launched: ${relative(entry.workspace, file).split(sep).join("/")} changed while the confirmation was open. Run Launch again.`);
			}
		} catch (error) {
			this.pending.delete(key);
			throw error;
		}
		this.apps.set(key, { sessionPath: plan.sessionPath, label: plan.label, state: entry.infra ? "waiting" : "starting", project: entry.infra?.project });
		this.emit();
		void this.run(entry, key, pending);
	}

	private async run(entry: Plan, key: string, pending: Pending): Promise<void> {
		const { plan, app, infra } = entry;
		try {
			if (infra) {
				try {
					await this.infra.up({ ...infra, label: infra.label, holder: plan.sessionPath });
				} catch (error) {
					this.apps.set(key, {
						sessionPath: plan.sessionPath,
						label: plan.label,
						state: "not_started",
						project: infra.project,
						reason: `${infra.label} failed: ${error instanceof Error ? error.message : String(error)}`,
					});
					return;
				}
			}
			if (pending.cancelled || this.shuttingDown || this.deleted.has(plan.sessionPath)) {
				this.apps.delete(key);
				return;
			}
			const serviceId = this.services.launchApp({
				sessionPath: plan.sessionPath,
				label: plan.label,
				command: commandLine(app),
				cwd: app.cwd,
				env: { ...process.env, ...app.env },
				shellPath: entry.shellPath,
				onExit: (exit) => this.exited(key, plan, exit),
			});
			this.apps.set(key, { sessionPath: plan.sessionPath, label: plan.label, state: "running", serviceId, project: infra?.project });
		} finally {
			this.pending.delete(key);
			this.emit();
		}
	}

	private exited(key: string, plan: LaunchPlan, exit: AppExit): void {
		const current = this.apps.get(key);
		if (exit.stopped || (exit.code === 0 && !exit.error) || this.deleted.has(plan.sessionPath)) this.apps.delete(key);
		else {
			this.apps.set(key, {
				sessionPath: plan.sessionPath,
				label: plan.label,
				state: "exited",
				project: current?.project,
				exitCode: exit.code,
				tail: exit.tail.split("\n").slice(-40).join("\n"),
				reason: exit.error,
			});
			this.notice(exit.code === null ? `${plan.label} couldn't start${exit.error ? `: ${exit.error}` : "."}` : `${plan.label} exited with code ${exit.code}.`);
		}
		this.emit();
	}

	dismiss(path: string, label: string): void {
		this.apps.delete(`${path}\0${label}`);
		this.emit();
	}

	stopInfra(project: string): Promise<void> {
		return this.infra.stop(project);
	}

	checkInfra(project: string): Promise<void> {
		return this.infra.reconcile(project);
	}

	/**
	 * A session is being deleted: what it was starting is cancelled and starts no app, and it lets go of its
	 * infrastructure, which stops when no session holds it. Never fails, so deleting goes ahead; a `down` that
	 * fails leaves the record and a notice with the command to finish it.
	 */
	async sessionDeleted(path: string): Promise<void> {
		this.deleted.add(path);
		for (const [key, pending] of this.pending) if (key.startsWith(`${path}\0`)) pending.cancelled = true;
		for (const key of [...this.apps.keys()]) if (key.startsWith(`${path}\0`)) this.apps.delete(key);
		for (const [id, plan] of this.plans) if (plan.plan.sessionPath === path) this.plans.delete(id);
		for (const info of this.infra.list()) {
			if (!info.holders.includes(path)) continue;
			try {
				if (await this.infra.release(info.project, path)) await this.infra.stop(info.project, DELETE_DOWN_MS);
			} catch {
				this.notice(`${info.label} could not be stopped. Run this when Docker is back:`, info.downCommand);
			}
		}
		this.emit();
	}

	/** The session's deletion is over; whatever its path is reused for starts fresh. */
	sessionGone(path: string): void {
		this.deleted.delete(path);
	}

	/** How much quitting would stop: launches under way and infrastructure. */
	count(): number {
		return this.pending.size + this.infra.count();
	}

	/** Quitting is under way: nothing new starts and what was starting is cancelled. */
	shutdown(): void {
		this.shuttingDown = true;
		for (const pending of this.pending.values()) pending.cancelled = true;
		this.plans.clear();
		this.emit();
	}

	/** Quitting was cancelled. */
	resume(): void {
		this.shuttingDown = false;
		this.emit();
	}

	/** Stops every Compose project within the time given; resolves with the labels of the ones left. */
	async stopInfraForQuit(timeoutMs: number): Promise<string[]> {
		// Launches still bringing a project up hold its queue; stopping waits behind them within the same time.
		const failed = await this.infra.stopAll(timeoutMs);
		this.emit();
		return failed.map((record) => record.label);
	}
}
