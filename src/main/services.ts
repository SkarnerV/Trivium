import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, join } from "node:path";
import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ServiceInfo } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";

/**
 * Every agent command runs with this variable set to an id of its own. Processes inherit it, so the ones a
 * command leaves running still carry it after the shell has gone, wherever they were reparented.
 */
export const MARKER = "TRIVIUM_COMMAND_ID";

/** A live process, as the system lists it. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	/** The process group, on macOS and Linux. */
	pgid?: number;
	name: string;
	/** When it started, in ms, where the system says. */
	created?: number;
	/** The command id it carries, if any. */
	marker?: string;
}

/** What a service needs to find its processes again. */
export interface ServiceKey {
	id: string;
	startedAt: number;
	/** The shell that ran the command; its process group holds the command's processes on macOS and Linux. */
	shellPid?: number;
}

/**
 * Each service's live processes: the ones carrying its id or in its shell's process group, and their children.
 * On Windows a native child carries no readable environment, so it is found by its parent; one started before
 * the service is a reused process id, not a child.
 */
export function groupProcesses(rows: ProcessRow[], services: ServiceKey[]): Map<string, ProcessRow[]> {
	const children = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const list = children.get(row.ppid);
		if (list) list.push(row);
		else children.set(row.ppid, [row]);
	}
	const claimed = new Set<number>();
	const groups = new Map<string, ProcessRow[]>();
	for (const service of services) {
		const seeds = rows.filter(
			(row) => !claimed.has(row.pid) && (row.marker === service.id || (service.shellPid !== undefined && row.pgid === service.shellPid && row.pid !== service.shellPid)),
		);
		const found: ProcessRow[] = [];
		const queue = [...seeds];
		for (const row of seeds) claimed.add(row.pid);
		while (queue.length) {
			const row = queue.shift()!;
			found.push(row);
			for (const child of children.get(row.pid) ?? []) {
				if (claimed.has(child.pid) || (child.created !== undefined && child.created < service.startedAt - 1000)) continue;
				claimed.add(child.pid);
				queue.push(child);
			}
		}
		if (found.length) groups.set(service.id, found.sort((a, b) => a.pid - b.pid));
	}
	return groups;
}

/** The processes to signal so a whole group ends: those whose parent is not in it. */
export function rootsOf(rows: ProcessRow[]): ProcessRow[] {
	const pids = new Set(rows.map((row) => row.pid));
	return rows.filter((row) => !pids.has(row.ppid));
}

/** Windows' process list, from PowerShell's Win32_Process query as JSON. */
export function parseWindowsProcesses(json: string): ProcessRow[] {
	if (!json.trim()) return [];
	const parsed = JSON.parse(json) as unknown;
	const list = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; ParentProcessId: number; Name: string | null; Created: number | null }[];
	return list.map((entry) => ({
		pid: entry.ProcessId,
		ppid: entry.ParentProcessId,
		name: (entry.Name ?? "").replace(/\.exe$/i, ""),
		created: entry.Created ?? undefined,
	}));
}

/** "winpid<TAB>id" lines from Git Bash's /proc: the processes carrying a command id. */
export function parseMarkerLines(text: string): Map<number, string> {
	const markers = new Map<number, string>();
	for (const line of text.split(/\r?\n/)) {
		const [pid, id] = line.trim().split("\t");
		if (pid && id && /^\d+$/.test(pid)) markers.set(Number(pid), id);
	}
	return markers;
}

/** `ps` lines of pid, ppid, pgid and command, with the environment after the command on macOS. */
export function parsePs(text: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	const marker = new RegExp(`(?:^|\\s)${MARKER}=([\\w-]+)`);
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const command = match[4]!;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			pgid: Number(match[3]),
			name: basename(command.split(/\s/)[0] ?? ""),
			marker: marker.exec(command)?.[1],
		});
	}
	return rows;
}

/** Listening TCP ports by process, from `netstat -ano`. A listening socket has no remote end, whatever the state is called. */
export function parseNetstat(text: string): Map<number, number[]> {
	const ports = new Map<number, number[]>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]|\*):0\s+\S+\s+(\d+)\s*$/i.exec(line);
		if (match) add(ports, Number(match[3]), Number(match[2]));
	}
	return ports;
}

/** Listening TCP ports by process, from `lsof -Fpn`: a "p" line names the process, "n" lines its addresses. */
export function parseLsof(text: string): Map<number, number[]> {
	const ports = new Map<number, number[]>();
	let pid = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid) {
			const port = /:(\d+)$/.exec(line)?.[1];
			if (port) add(ports, pid, Number(port));
		}
	}
	return ports;
}

function add(ports: Map<number, number[]>, pid: number, port: number): void {
	const list = ports.get(pid) ?? [];
	if (!list.includes(port)) list.push(port);
	ports.set(pid, list.sort((a, b) => a - b));
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

/**
 * Where a service serves pages: a local address it printed, preferring one on a port it listens on, else the
 * first port it listens on. An address for all interfaces opens as localhost.
 */
export function serviceUrl(output: string, ports: number[]): string | undefined {
	const found = [...stripAnsi(output).matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::(\d{2,5}))?(?:\/[^\s'"<>)\]]*)?/g)].map(
		(match) => ({ url: match[0].replace(/\/\/(?:0\.0\.0\.0|\[::\])/, "//localhost").replace(/[.,;:]+$/, ""), port: Number(match[1] ?? 80) }),
	);
	const listening = found.filter((entry) => ports.includes(entry.port));
	if (listening.length) return listening.at(-1)!.url;
	if (ports.length) return `http://localhost:${ports[0]}`;
	return found.at(-1)?.url;
}

/** The last part of what a process printed: enough to see it start, or why it stopped. */
export class OutputTail {
	private text = "";
	private readonly limit: number;
	/** Called after each chunk. */
	onChange: () => void = () => {};

	constructor(limit = 16_000) {
		this.limit = limit;
	}

	append(chunk: Buffer | string): void {
		this.text += String(chunk);
		if (this.text.length > this.limit * 2) this.text = this.text.slice(-this.limit);
		this.onChange();
	}

	read(): string {
		const text = stripAnsi(this.text.length > this.limit ? this.text.slice(-this.limit) : this.text).replace(/\r\n/g, "\n");
		// A progress line redrawn with \r shows as its latest version.
		return text
			.split("\n")
			.map((line) => line.slice(line.lastIndexOf("\r") + 1))
			.join("\n");
	}
}

/** How the tracker reads and ends processes. Tests pass their own. */
export interface ProcessProbe {
	/** Every live process, with the command id it carries where that can be read. */
	list(shell: string | undefined): Promise<ProcessRow[]>;
	/** Just the command ids live processes carry, where that is much quicker than the full list. */
	markers?(shell: string | undefined): Promise<Set<string>>;
	/** Listening TCP ports by process. */
	listening(): Promise<Map<number, number[]>>;
	/** Ends these processes and everything under them. `force` is the second try. */
	kill(rows: ProcessRow[], force: boolean): Promise<void>;
	/** The same, without waiting, for when the app quits. */
	killSync(rows: ProcessRow[]): void;
}

function run(file: string, args: string[], timeout = 15_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");

const WINDOWS_LIST =
	"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name," +
	"@{n='Created';e={if ($_.CreationDate) {[long](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)} else {$null}}} " +
	"| ConvertTo-Json -Compress";

/**
 * Lists the Git Bash processes carrying a command id, by Windows process id. Git Bash keeps each process's
 * environment under /proc, including native programs it started; one grep reads them all.
 */
const MARKER_SCRIPT = `grep -a -o '${MARKER}=[A-Za-z0-9_-]*' /proc/[0-9]*/environ 2>/dev/null | while IFS= read -r line; do p=\${line#/proc/}; p=\${p%%/*}; read -r w < "/proc/$p/winpid" 2>/dev/null && printf '%s\\t%s\\n' "$w" "\${line##*=}"; done; true`;

/** Reads processes with the system's own tools: PowerShell and Git Bash on Windows, ps and lsof elsewhere. */
export const systemProbe: ProcessProbe = {
	async list(shell) {
		if (process.platform === "win32") {
			const [json, markers] = await Promise.all([
				run(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST]),
				shell ? run(shell, ["-c", MARKER_SCRIPT]).catch(() => "") : Promise.resolve(""),
			]);
			const ids = parseMarkerLines(markers);
			return parseWindowsProcesses(json).map((row) => ({ ...row, marker: ids.get(row.pid) }));
		}
		if (process.platform === "darwin") {
			// -E adds each process's environment after its command, for the user's own processes. Without it, the
			// shell's process group still finds what the command left.
			const columns = ["-o", "pid=,ppid=,pgid=,command="];
			return parsePs(await run("/bin/ps", ["-A", "-ww", "-E", ...columns]).catch(() => run("/bin/ps", ["-A", "-ww", ...columns])));
		}
		const rows = parsePs(await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="]));
		await Promise.all(
			rows.map(async (row) => {
				const environ = await readFile(`/proc/${row.pid}/environ`, "latin1").catch(() => "");
				row.marker = new RegExp(`(?:^|\\0)${MARKER}=([\\w-]+)`).exec(environ)?.[1];
			}),
		);
		return rows;
	},
	markers:
		process.platform === "win32"
			? async (shell) => new Set(shell ? parseMarkerLines(await run(shell, ["-c", MARKER_SCRIPT])).values() : [])
			: undefined,
	async listening() {
		if (process.platform === "win32") return parseNetstat(await run(join(process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe"), ["-ano"]));
		// lsof exits 1 when nothing listens.
		return parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).catch((error: { stdout?: string }) => error.stdout ?? ""));
	},
	async kill(rows, force) {
		if (process.platform === "win32") {
			const pids = (force ? rows : rootsOf(rows)).flatMap((row) => ["/PID", String(row.pid)]);
			// taskkill fails for a process that already ended; the next scan says what is left.
			await run(taskkill, ["/F", "/T", ...pids]).catch(() => "");
			return;
		}
		for (const row of rows) {
			try {
				process.kill(row.pid, force ? "SIGKILL" : "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	},
	killSync(rows) {
		if (!rows.length) return;
		if (process.platform === "win32") {
			spawnSync(taskkill, ["/F", "/T", ...rootsOf(rows).flatMap((row) => ["/PID", String(row.pid)])], { windowsHide: true, timeout: 5000 });
			return;
		}
		for (const row of rows) {
			try {
				process.kill(row.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	},
};

/** Ends a shell and everything it started, as pi does for a command that is stopped or times out. */
function killShell(pid: number): void {
	if (process.platform === "win32") {
		const child = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		child.once("error", () => {});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

/**
 * Waits for the shell to exit and its output to stop. Processes it left running may keep the output open; once the
 * shell has exited, a short quiet spell, or a second at most, ends the wait, and they go on printing to the service's log.
 */
function waitForShell(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let open = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
		let exited = false;
		let code: number | null = null;
		let quiet: ReturnType<typeof setTimeout> | undefined;
		let latest: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(quiet);
			clearTimeout(latest);
			child.stdout?.off("data", onData);
			child.stderr?.off("data", onData);
			resolve(code);
		};
		const onData = () => {
			if (!exited || settled) return;
			clearTimeout(quiet);
			quiet = setTimeout(finish, 100);
		};
		const onEnd = () => {
			open--;
			if (exited && open <= 0) finish();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.stdout?.once("end", onEnd);
		child.stderr?.once("end", onEnd);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.once("exit", (exitCode) => {
			exited = true;
			code = exitCode;
			if (open <= 0) return finish();
			quiet = setTimeout(finish, 100);
			latest = setTimeout(finish, 1000);
		});
	});
}

interface Tracked extends ServiceKey {
	sessionPath: string;
	command: string;
	cwd: string;
	output: OutputTail;
	processes: ProcessRow[];
	ports: number[];
	stopping: boolean;
}

/** What services.json keeps, so services left by a crash are found again at the next start. */
interface Saved {
	id: string;
	sessionPath: string;
	command: string;
	cwd: string;
	startedAt: number;
}

/**
 * Keeps track of the processes agent commands leave running, such as dev servers and watchers, per session.
 * Each command runs with an id in its environment; when the shell exits, any process still carrying the id is a
 * service. They are checked every few seconds and dropped once they have all ended.
 *
 * Unloading a session leaves its services running and listed. Deleting a session stops them. Quitting the app
 * stops them all, after saying so; a crash leaves them running, and the next start finds them again.
 */
export class ServiceTracker {
	private services = new Map<string, Tracked>();
	private readonly file: string;
	private readonly emit: (services: Record<string, ServiceInfo[]>) => void;
	private readonly probe: ProcessProbe;
	private readonly pollMs: number;
	private poll: ReturnType<typeof setInterval> | undefined;
	private outputTimer: ReturnType<typeof setTimeout> | undefined;
	/** The shell commands run in, which Windows needs to read command ids. */
	private shell: string | undefined;
	/** Commands that just ended, to check for processes they left. */
	private pending = new Map<string, Tracked>();
	private refreshing: Promise<void> | undefined;
	private again = false;

	constructor(options: { file: string; emit: (services: Record<string, ServiceInfo[]>) => void; probe?: ProcessProbe; pollMs?: number }) {
		this.file = options.file;
		this.emit = options.emit;
		this.probe = options.probe ?? systemProbe;
		this.pollMs = options.pollMs ?? (process.platform === "win32" ? 5000 : 3000);
	}

	/** Finds services a crash left running, from the list saved before it. */
	async init(): Promise<void> {
		if (!existsSync(this.file)) return;
		let saved: Saved[] = [];
		try {
			saved = JSON.parse(await readFile(this.file, "utf8")) as Saved[];
		} catch {
			return;
		}
		if (!Array.isArray(saved) || !saved.length) return;
		try {
			this.shell ??= process.platform === "win32" ? getShellConfig().shell : undefined;
		} catch {
			// Without Git Bash there are no ids to read.
		}
		for (const entry of saved) this.pending.set(entry.id, { ...entry, output: new OutputTail(), processes: [], ports: [], stopping: false });
		await this.refresh();
		await this.save();
	}

	/** Bash operations that run each command with an id, and check for processes it left once it ends. */
	bashOperations(sessionPath: () => string, options: { shellPath?: string; commandPrefix?: string } = {}): BashOperations {
		return {
			exec: async (command, cwd, { onData, signal, timeout, env }) => {
				if (signal?.aborted) throw new Error("aborted");
				if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Invalid timeout: must be a finite number of seconds");
				try {
					await access(cwd);
				} catch {
					throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
				}
				const shell = getShellConfig(options.shellPath);
				this.shell = shell.shell;
				const id = randomBytes(8).toString("hex");
				const fromStdin = shell.commandTransport === "stdin";
				const startedAt = Date.now();
				const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: { ...(env ?? process.env), [MARKER]: id },
					stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				if (fromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
				const output = new OutputTail();
				let forward = true;
				const onChunk = (data: Buffer) => {
					output.append(data);
					if (forward) onData(data);
				};
				child.stdout?.on("data", onChunk);
				child.stderr?.on("data", onChunk);
				// The pipes stay read after the command returns, so a service printing to them is not cut off.
				child.stdout?.on("error", () => {});
				child.stderr?.on("error", () => {});
				let timedOut = false;
				const stop = () => child.pid && killShell(child.pid);
				const timer = timeout ? setTimeout(() => ((timedOut = true), stop()), timeout * 1000) : undefined;
				signal?.addEventListener("abort", stop, { once: true });
				try {
					const exitCode = await waitForShell(child);
					if (signal?.aborted) throw new Error("aborted");
					if (timedOut) throw new Error(`timeout:${timeout}`);
					const signalCode = child.signalCode;
					return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
				} finally {
					forward = false;
					clearTimeout(timer);
					signal?.removeEventListener("abort", stop);
					const shown = options.commandPrefix && command.startsWith(`${options.commandPrefix}\n`) ? command.slice(options.commandPrefix.length + 1) : command;
					this.ended({ id, startedAt, shellPid: child.pid, sessionPath: sessionPath(), command: shown.trim(), cwd, output, processes: [], ports: [], stopping: false });
				}
			},
		};
	}

	/** The running services of every session, by session path. */
	list(): Record<string, ServiceInfo[]> {
		const result: Record<string, ServiceInfo[]> = {};
		for (const service of this.services.values()) (result[service.sessionPath] ??= []).push(this.info(service));
		for (const list of Object.values(result)) list.sort((a, b) => a.startedAt - b.startedAt);
		return result;
	}

	count(): number {
		return this.services.size;
	}

	/** Ends a service and everything it started. Resolves once its processes are gone, or fails if some are left. */
	async stop(id: string): Promise<void> {
		const service = this.services.get(id);
		if (!service) return;
		await this.stopAll([service]);
		if (this.services.has(id)) {
			const left = this.services.get(id)!.processes.map((row) => `${row.name} (${row.pid})`).join(", ");
			throw new Error(
				t(process.platform === "darwin" ? "Couldn't stop {name}. Try again, or end it from Activity Monitor." : "Couldn't stop {name}. Try again, or end it from Task Manager.", {
					name: left,
				}),
			);
		}
	}

	/** Stops a session's services, such as when it is deleted. */
	stopSession(sessionPath: string): Promise<void> {
		return this.stopAll([...this.services.values()].filter((service) => service.sessionPath === sessionPath));
	}

	/** Asks each service to end, waits a moment, then forces whatever is left. */
	async stopAll(services = [...this.services.values()]): Promise<void> {
		if (!services.length) return;
		for (const service of services) service.stopping = true;
		this.changed();
		await this.probe.kill(services.flatMap((service) => service.processes), false);
		for (let attempt = 0; attempt < 10; attempt++) {
			await this.refresh();
			if (services.every((service) => !this.services.has(service.id))) return;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		const left = services.filter((service) => this.services.has(service.id));
		await this.probe.kill(left.flatMap((service) => service.processes), true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await this.refresh();
		for (const service of left) service.stopping = false;
		this.changed();
	}

	/** Ends every service at once, for when the app quits. */
	dispose(): void {
		clearInterval(this.poll);
		clearTimeout(this.outputTimer);
		this.probe.killSync([...this.services.values()].flatMap((service) => service.processes));
		this.services.clear();
		void this.save().catch(() => {});
	}

	private ended(service: Tracked): void {
		this.pending.set(service.id, service);
		void this.refresh().catch(() => {});
	}

	/** Reads the process list once for every service and every command that just ended; overlapping calls share a read. */
	refresh(): Promise<void> {
		if (this.refreshing) {
			this.again = true;
			return this.refreshing;
		}
		this.refreshing = this.scan()
			.catch(() => {
				// A failed read keeps what was last known; the next poll tries again.
			})
			.finally(() => {
				this.refreshing = undefined;
				if (this.again) {
					this.again = false;
					void this.refresh();
				}
			});
		return this.refreshing;
	}

	private async scan(): Promise<void> {
		let pending = [...this.pending.values()];
		this.pending.clear();
		// Most commands leave nothing running; on Windows a quick look for their ids saves reading every process.
		if (!this.services.size && pending.length && this.probe.markers) {
			const ids = await this.probe.markers(this.shell);
			pending = pending.filter((service) => ids.has(service.id));
		}
		const all = [...this.services.values(), ...pending];
		if (!all.length) return;
		const rows = await this.probe.list(this.shell);
		const groups = groupProcesses(rows, all);
		const live = all.filter((service) => groups.has(service.id));
		const ports = live.length ? await this.probe.listening().catch(() => new Map<number, number[]>()) : new Map<number, number[]>();
		let changed = false;
		for (const service of all) {
			const processes = groups.get(service.id);
			if (!processes) {
				if (this.services.delete(service.id)) changed = true;
				continue;
			}
			const next = [...new Set(processes.flatMap((row) => ports.get(row.pid) ?? []))].sort((a, b) => a - b);
			if (!this.services.has(service.id) || JSON.stringify(processes.map((row) => row.pid)) !== JSON.stringify(service.processes.map((row) => row.pid)) || next.join() !== service.ports.join()) {
				changed = true;
			}
			service.processes = processes;
			service.ports = next;
			if (!this.services.has(service.id)) {
				this.services.set(service.id, service);
				service.output.onChange = () => this.outputChanged();
			}
		}
		if (changed) {
			this.changed();
			await this.save();
		}
	}

	private changed(): void {
		clearTimeout(this.outputTimer);
		this.outputTimer = undefined;
		if (this.services.size && !this.poll) {
			this.poll = setInterval(() => void this.refresh(), this.pollMs);
			this.poll.unref?.();
		} else if (!this.services.size && this.poll) {
			clearInterval(this.poll);
			this.poll = undefined;
		}
		this.emit(this.list());
	}

	/** New output shows at most once a second. */
	private outputChanged(): void {
		this.outputTimer ??= setTimeout(() => {
			this.outputTimer = undefined;
			this.emit(this.list());
		}, 1000);
	}

	private info(service: Tracked): ServiceInfo {
		const output = service.output.read();
		return {
			id: service.id,
			command: service.command,
			cwd: service.cwd,
			startedAt: service.startedAt,
			processes: service.processes.map((row) => ({ pid: row.pid, name: row.name })),
			ports: service.ports,
			url: serviceUrl(output, service.ports),
			output,
			stopping: service.stopping,
		};
	}

	private async save(): Promise<void> {
		// Not the shell's process id: after a restart another process may have it.
		const saved: Saved[] = [...this.services.values()].map(({ id, sessionPath, command, cwd, startedAt }) => ({ id, sessionPath, command, cwd, startedAt }));
		if (!saved.length && !existsSync(this.file)) return;
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
		await rename(tmp, this.file);
	}
}
