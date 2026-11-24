import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type BuildOptions } from "esbuild";
import type { PermissionModeId } from "../../src/shared/permissions.ts";
import type { DialogRequest, HostEvent, Run, SessionView, Subagent } from "../../src/shared/protocol.ts";
import { bundles } from "../bundles.mjs";
import { ModelServer } from "./model-server.ts";

/**
 * Trivium's own session host with the real pi-subagents package, on throwaway folders: its profile, pi's agent
 * folder, pi-subagents' temp root and a git project. Nothing of the user's is read or written, and the model is the
 * scripted one in model-server.ts.
 *
 * The folders are set through environment variables the modules read once, so one process runs one harness.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
/** Inside node_modules so the bundle finds its external packages, and out of git's sight. */
const out = join(root, "node_modules", ".cache", "trivium-real");

type HostModule = typeof import("./host-entry.ts");

export interface Real {
	model: ModelServer;
	host: InstanceType<HostModule["SessionHost"]>;
	dir: string;
	project: string;
	events: HostEvent[];
	/** Every dialog asked, in order. */
	dialogs: DialogRequest[];
	/** Answers select dialogs with the option that starts with the returned text; undefined leaves one open. */
	answer: (reply: ((request: DialogRequest) => string | undefined) | undefined) => void;
	setMode: (mode: PermissionModeId) => Promise<void>;
	/** A new Code session in the project. */
	open: (orchestrator?: boolean) => Promise<string>;
	view: (path: string) => Promise<SessionView>;
	runs: (path: string) => Promise<Run[]>;
	subagents: (path: string) => Promise<Subagent[]>;
	prompt: (path: string, text: string) => Promise<void>;
	settled: (path: string, timeoutMs?: number) => Promise<void>;
	/** Ends a session as quitting the app does, leaving its background runs going. Opening it again reads it back. */
	restart: (path: string) => Promise<void>;
	close: () => Promise<void>;
}

export async function until<T>(what: string, read: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 100));
	}
}

async function bundleHost(): Promise<string> {
	await build({ ...bundles.childPermissions, outfile: join(out, "child-permissions.mjs"), logLevel: "error" } as BuildOptions);
	const outfile = join(out, "host.mjs");
	await build({ ...bundles.main, entryPoints: [join(root, "scripts", "real", "host-entry.ts")], outfile, logLevel: "error" } as BuildOptions);
	return outfile;
}

export interface Folders {
	dir: string;
	home: string;
	project: string;
	temp: string;
	/** What points Trivium, pi and pi-subagents at these folders. */
	env: Record<string, string>;
	model: ModelServer;
	close: () => Promise<void>;
}

/** The throwaway folders, and the scripted model they are set up to use. */
export async function prepare(): Promise<Folders> {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "trivium-real-")));
	const agentDir = join(dir, "agent");
	const home = join(dir, "trivium");
	const project = join(dir, "project");
	const temp = join(dir, "temp");
	for (const folder of [agentDir, home, join(project, "src"), temp]) mkdirSync(folder, { recursive: true });
	const model = new ModelServer();
	const baseUrl = await model.start();
	const provider = { baseUrl, api: "openai-completions", apiKey: "none", models: [{ id: "scripted", contextWindow: 200_000, maxTokens: 8000 }] };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { scripted: provider } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted" }));
	writeFileSync(join(home, "settings.json"), JSON.stringify({ permissionMode: "auto" }));
	writeFileSync(join(project, "src", "app.ts"), "export const ready = false;\n");
	writeFileSync(join(project, ".gitignore"), ".pi/\nnode_modules/\n");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: project, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-qm", "start");
	return {
		dir,
		home,
		project,
		temp,
		env: { PI_CODING_AGENT_DIR: agentDir, TRIVIUM_HOME: home, PI_SUBAGENTS_TEMP_ROOT: temp, PI_OFFLINE: "1" },
		model,
		close: async () => {
			await model.stop();
			// Runners of writers left waiting for a reply that never comes.
			const runs = join(temp, "async-subagent-runs");
			for (const name of existsSync(runs) ? readdirSync(runs) : []) {
				try {
					process.kill((JSON.parse(readFileSync(join(runs, name, "status.json"), "utf8")) as { pid: number }).pid, "SIGKILL");
				} catch {
					// It ended by itself.
				}
			}
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
			} catch (error) {
				console.warn(`Left behind: ${dir} (${String(error)})`);
			}
		},
	};
}

export async function startReal(): Promise<Real> {
	const folders = await prepare();
	const { dir, home, project, model } = folders;
	Object.assign(process.env, folders.env);
	delete process.env.TRIVIUM_DEV_FAUX;

	const { SessionHost, SettingsStore, DialogBroker, ServiceTracker } = (await import(pathToFileURL(await bundleHost()).href)) as HostModule;
	const events: HostEvent[] = [];
	const dialogs: DialogRequest[] = [];
	let reply: ((request: DialogRequest) => string | undefined) | undefined;
	const emit = (event: HostEvent) => {
		events.push(event);
		if (event.type !== "dialog") return;
		const { request } = event;
		dialogs.push(request);
		const wanted = reply?.(request);
		if (wanted === undefined || request.kind !== "select") return;
		const value = request.options.find((option) => option.startsWith(wanted));
		setImmediate(() => broker.answer(request.id, value === undefined ? { cancelled: true } : { value }));
	};
	const broker = new DialogBroker(emit);
	const settings = new SettingsStore(join(home, "settings.json"));
	const services = new ServiceTracker({ file: join(home, "services.json"), emit: () => {} });
	const host = new SessionHost({ emit, broker, indexFile: join(home, "session-apps.json"), settings, onDone: () => {}, services });
	await host.init();
	const view = (path: string) => host.openSession(path);
	const runs = async (path: string) => (await view(path)).runs;
	return {
		model,
		host,
		dir,
		project,
		events,
		dialogs,
		answer: (next) => {
			reply = next;
		},
		setMode: async (mode) => {
			await settings.update({ permissionMode: mode });
		},
		open: async (orchestrator = true) => {
			await settings.update({ apps: { ...settings.get().apps, code: { ...settings.app("code"), workMode: orchestrator ? "orchestrator" : "default" } } });
			return (await host.newSession({ app: "code", cwd: project })).path;
		},
		view,
		runs,
		subagents: async (path) => (await runs(path)).flatMap((run) => run.steps.flatMap((step) => (step.subagent ? [step.subagent] : []))),
		prompt: async (path, text) => {
			const before = (await runs(path)).length;
			await host.send(path, text, "prompt");
			await until("the run to start", async () => (await runs(path)).length > before);
		},
		settled: async (path, timeoutMs = 120_000) => {
			await until("the session to settle", async () => !(await view(path)).running, timeoutMs);
		},
		restart: async (path) => {
			const internals = host as unknown as { live: Map<string, { session: { extensionRunner: { emit(event: object): Promise<unknown> } } }>; unload(live: unknown): void };
			const live = internals.live.get(path)!;
			await live.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			internals.unload(live);
		},
		close: async () => {
			host.dispose();
			services.dispose();
			await folders.close();
		},
	};
}
