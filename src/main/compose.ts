import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { InfraInfo } from "../shared/protocol.ts";
import { stripAnsi } from "./services.ts";

/**
 * The Docker Compose projects Launch brings up for apps, kept apart from everything else in Docker by a project name
 * of Trivium's own. A project outlives the app that needed it, so the next launch finds the database already up, and
 * its record on disk outlives Trivium, so a crash never loses track of what it started.
 */

export interface DockerResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Runs the docker CLI with arguments, never through a shell. Tests pass their own. */
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<DockerResult>;

export const dockerRunner: DockerRunner = (args, timeoutMs) =>
	new Promise((resolve) => {
		execFile("docker", args, { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
			resolve({
				code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? "") || (failure && typeof failure.code === "string" ? failure.message : ""),
				timedOut: Boolean(failure?.killed),
			});
		});
	});

/** What Trivium keeps about a project it started, written before `up` so a crash during it is found again. */
export interface InfraRecord {
	project: string;
	/** The sessions using it, by session path. */
	holders: string[];
	label: string;
	files: string[];
	dockerContext: string;
	engineId: string;
	startedAt: number;
	services?: string[];
	profiles?: string[];
}

/** How to bring a project up, from a docker-compose task. */
export interface UpSpec {
	project: string;
	label: string;
	files: string[];
	envFile?: string;
	services?: string[];
	profiles?: string[];
	build: boolean;
	holder: string;
}

/**
 * Trivium's own name for a project: stable for one Compose file's folder in one Trivium home, so relaunching finds
 * the same containers and named volumes, and apart from the developer's own default projects, other worktrees and
 * other Trivium profiles.
 */
export function projectName(triviumDir: string, firstFileDir: string, workspace: string): string {
	const slug =
		basename(workspace)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24) || "app";
	const hash = createHash("sha256").update(`${triviumDir}\0${firstFileDir}`).digest("hex").slice(0, 10);
	return `trivium-${slug}-${hash}`;
}

/** The arguments of `up`: always detached, always waiting for healthchecks, once. */
export function upArgs(context: string, spec: UpSpec): string[] {
	return [
		"--context",
		context,
		"compose",
		"-p",
		spec.project,
		...spec.files.flatMap((file) => ["-f", file]),
		...(spec.envFile ? ["--env-file", spec.envFile] : []),
		...(spec.profiles ?? []).flatMap((profile) => ["--profile", profile]),
		"up",
		"-d",
		"--wait",
		...(spec.build ? ["--build"] : []),
		...(spec.services?.length ? ["--", ...spec.services] : []),
	];
}

/**
 * The arguments of `down`: by project name alone, so it works after the Compose files moved or went, and without
 * `-v`, so named volumes and the data in them stay.
 */
export function downArgs(record: Pick<InfraRecord, "project" | "dockerContext">): string[] {
	return ["--context", record.dockerContext, "compose", "-p", record.project, "down"];
}

/** The same, as a command to copy into a terminal. */
export function downCommand(record: Pick<InfraRecord, "project" | "dockerContext">): string {
	return ["docker", ...downArgs(record)].join(" ");
}

const LABEL = "com.docker.compose.project";
const OUTPUT_LIMIT = 16_000;

function bounded(text: string): string {
	const clean = stripAnsi(text).replace(/\r\n/g, "\n");
	return clean.length > OUTPUT_LIMIT ? clean.slice(-OUTPUT_LIMIT) : clean;
}

function failureText(result: DockerResult, what: string): string {
	if (result.timedOut) return `${what} timed out`;
	const text = (result.stderr || result.stdout).trim().split("\n").at(-1);
	return text || `${what} failed`;
}

interface Live {
	record: InfraRecord;
	state: InfraInfo["state"];
	output: string;
	logs: string;
	error?: string;
}

export class InfraManager {
	private readonly file: string;
	private readonly run: DockerRunner;
	private readonly emit: () => void;
	private readonly upTimeoutMs: number;
	private readonly downTimeoutMs: number;
	private live = new Map<string, Live>();
	/** Each project's Compose operations run one at a time. */
	private queues = new Map<string, Promise<unknown>>();

	constructor(options: { file: string; run?: DockerRunner; emit: () => void; upTimeoutMs?: number; downTimeoutMs?: number }) {
		this.file = options.file;
		this.run = options.run ?? dockerRunner;
		this.emit = options.emit;
		this.upTimeoutMs = options.upTimeoutMs ?? 10 * 60_000;
		this.downTimeoutMs = options.downTimeoutMs ?? 60_000;
	}

	private serial<T>(project: string, work: () => Promise<T>): Promise<T> {
		const before = this.queues.get(project) ?? Promise.resolve();
		const next = before.catch(() => {}).then(work);
		this.queues.set(project, next);
		void next.finally(() => {
			if (this.queues.get(project) === next) this.queues.delete(project);
		}).catch(() => {});
		return next;
	}

	/** The projects to show, with who holds them. */
	list(): InfraInfo[] {
		return [...this.live.values()].map(({ record, state, output, logs, error }) => ({
			project: record.project,
			label: record.label,
			files: record.files,
			services: record.services,
			profiles: record.profiles,
			holders: record.holders,
			state,
			output,
			logs,
			error,
			startedAt: record.startedAt,
			downCommand: downCommand(record),
		}));
	}

	get(project: string): InfraInfo | undefined {
		return this.list().find((info) => info.project === project);
	}

	/** How many projects are up or might be, for the quit question. */
	count(): number {
		return this.live.size;
	}

	private async save(): Promise<void> {
		const records = [...this.live.values()].map((entry) => entry.record);
		if (!records.length && !existsSync(this.file)) return;
		await mkdir(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
		await rename(tmp, this.file);
	}

	private async engine(context: string): Promise<string | undefined> {
		const result = await this.run(["--context", context, "info", "--format", "{{.ID}}"], 15_000);
		const id = result.stdout.trim();
		return result.code === 0 && id ? id : undefined;
	}

	/** What is left of a project in Docker: its containers, stopped ones too, and its networks. */
	private async remnants(record: InfraRecord): Promise<{ containers: number; running: number; networks: number } | undefined> {
		const filter = `label=${LABEL}=${record.project}`;
		const [all, running, networks] = await Promise.all([
			this.run(["--context", record.dockerContext, "ps", "-a", "-q", "--filter", filter], 15_000),
			this.run(["--context", record.dockerContext, "ps", "-q", "--filter", filter], 15_000),
			this.run(["--context", record.dockerContext, "network", "ls", "-q", "--filter", filter], 15_000),
		]);
		if ([all, running, networks].some((result) => result.code !== 0)) return undefined;
		const lines = (text: string) => text.split(/\r?\n/).filter((line) => line.trim()).length;
		return { containers: lines(all.stdout), running: lines(running.stdout), networks: lines(networks.stdout) };
	}

	/**
	 * Picks up the projects a crash or a forced quit left. One with containers or networks still there shows again;
	 * one Docker says is gone is forgotten; one on a Docker that can't be reached, or that is now another engine,
	 * stays as Unknown and is never cleaned up blind.
	 */
	async init(): Promise<void> {
		let records: InfraRecord[] = [];
		try {
			records = JSON.parse(await readFile(this.file, "utf8")) as InfraRecord[];
		} catch {
			return;
		}
		if (!Array.isArray(records)) return;
		for (const record of records) this.live.set(record.project, { record, state: "unknown", output: "", logs: "" });
		this.emit();
		await Promise.all(records.map((record) => this.reconcile(record.project)));
	}

	/** Checks a project against Docker again, such as once Docker is back. */
	reconcile(project: string): Promise<void> {
		return this.serial(project, async () => {
			const entry = this.live.get(project);
			if (!entry) return;
			const engine = await this.engine(entry.record.dockerContext);
			if (!engine) {
				entry.state = "unknown";
				entry.error = "Docker isn't reachable, so Trivium can't tell whether it is still up.";
			} else if (engine !== entry.record.engineId) {
				entry.state = "unknown";
				entry.error = `Docker context ${entry.record.dockerContext} is now a different engine. Trivium won't stop anything there.`;
			} else {
				const left = await this.remnants(entry.record);
				if (!left) {
					entry.state = "unknown";
					entry.error = "Docker didn't answer.";
				} else if (!left.containers && !left.networks) {
					this.live.delete(project);
				} else {
					entry.state = left.running ? "running" : "failed";
					entry.error = left.running ? undefined : "Its containers are not running.";
				}
			}
			await this.save();
			this.emit();
		});
	}

	/** A project already recorded with other files, which a launch with these must not take over. */
	conflict(project: string, files: string[]): InfraRecord | undefined {
		const record = this.live.get(project)?.record;
		return record && JSON.stringify(record.files) !== JSON.stringify(files) ? record : undefined;
	}

	holders(project: string): string[] {
		return this.live.get(project)?.record.holders ?? [];
	}

	/**
	 * Brings a project up for an app and adds its session as a holder; resolves once Compose says it is healthy.
	 * Every launch runs `up`, which starts what stopped and leaves what runs. Fails with the reason, keeping the
	 * project as Failed with what `up` printed and the containers' last log lines.
	 */
	up(spec: UpSpec): Promise<void> {
		return this.serial(spec.project, async () => {
			const existing = this.live.get(spec.project);
			if (existing && JSON.stringify(existing.record.files) !== JSON.stringify(spec.files)) {
				throw new Error(`${existing.record.label} is running with other Compose files. Stop it before launching with these.`);
			}
			let context = existing?.record.dockerContext;
			if (!context) {
				const shown = await this.run(["context", "show"], 15_000);
				context = shown.stdout.trim();
				if (shown.code !== 0 || !context) throw new Error(`Docker isn't available: ${failureText(shown, "docker context show")}`);
			}
			const engineId = await this.engine(context);
			if (!engineId) throw new Error(`Docker isn't running, or context ${context} can't be reached.`);
			if (existing && existing.record.engineId !== engineId) throw new Error(`Docker context ${context} is now a different engine than the one ${existing.record.label} runs on.`);
			const record: InfraRecord = existing?.record ?? {
				project: spec.project,
				holders: [],
				label: spec.label,
				files: spec.files,
				dockerContext: context,
				engineId,
				startedAt: Date.now(),
				services: spec.services,
				profiles: spec.profiles,
			};
			if (!record.holders.includes(spec.holder)) record.holders.push(spec.holder);
			const entry: Live = existing ?? { record, state: "starting", output: "", logs: "" };
			entry.state = "starting";
			entry.error = undefined;
			entry.logs = "";
			this.live.set(spec.project, entry);
			await this.save();
			this.emit();
			const result = await this.run(upArgs(context, spec), this.upTimeoutMs);
			entry.output = bounded(`${result.stdout}${result.stderr}`);
			if (result.code === 0) {
				entry.state = "running";
				this.emit();
				return;
			}
			entry.state = "failed";
			entry.error = failureText(result, "docker compose up");
			const logs = await this.run(
				["--context", context, "compose", "-p", spec.project, ...spec.files.flatMap((file) => ["-f", file]), ...(spec.envFile ? ["--env-file", spec.envFile] : []), "logs", "--no-color", "--tail", "200"],
				30_000,
			);
			entry.logs = bounded(`${logs.stdout}${logs.stderr}`);
			this.emit();
			throw new Error(entry.error);
		});
	}

	/** Takes a session off a project. Resolves true when it was the last one, and so the project should go. */
	release(project: string, holder: string): Promise<boolean> {
		return this.serial(project, async () => {
			const entry = this.live.get(project);
			if (!entry) return false;
			entry.record.holders = entry.record.holders.filter((path) => path !== holder);
			await this.save();
			this.emit();
			return entry.record.holders.length === 0;
		});
	}

	/**
	 * Stops a project with `down` by its name, then forgets it once Docker shows none of its containers or networks
	 * left. Refuses on an engine other than the one it started on. Fails with the reason, keeping the record.
	 */
	stop(project: string, timeoutMs = this.downTimeoutMs): Promise<void> {
		return this.serial(project, async () => {
			const entry = this.live.get(project);
			if (!entry) return;
			const before = entry.state;
			entry.state = "stopping";
			this.emit();
			try {
				const engine = await this.engine(entry.record.dockerContext);
				if (!engine) throw new Error("Docker isn't reachable.");
				if (engine !== entry.record.engineId) throw new Error(`Docker context ${entry.record.dockerContext} is now a different engine. Nothing was stopped.`);
				const result = await this.run(downArgs(entry.record), timeoutMs);
				if (result.code !== 0) throw new Error(failureText(result, "docker compose down"));
				const left = await this.remnants(entry.record);
				if (!left) throw new Error("Docker didn't say whether it is gone.");
				if (left.containers || left.networks) throw new Error("Some of its containers or networks are still there.");
				this.live.delete(project);
				await this.save();
			} catch (error) {
				entry.state = before === "stopping" ? "unknown" : before;
				entry.error = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				this.emit();
			}
		});
	}

	/** Stops every project, each within the time left; resolves with the ones that could not be stopped. */
	async stopAll(timeoutMs: number): Promise<InfraRecord[]> {
		const deadline = Date.now() + timeoutMs;
		const entries = [...this.live.values()];
		const failed: InfraRecord[] = [];
		await Promise.all(
			entries.map(async (entry) => {
				const left = Math.max(1000, deadline - Date.now());
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						this.stop(entry.record.project, left),
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error("timed out")), left + 2000);
						}),
					]);
				} catch {
					failed.push(entry.record);
				} finally {
					clearTimeout(timer);
				}
			}),
		);
		return failed;
	}

	record(project: string): InfraRecord | undefined {
		return this.live.get(project)?.record;
	}
}
