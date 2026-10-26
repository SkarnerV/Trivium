import { existsSync, readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * pi extensions are written for the pi CLI, where process.execPath is Node. Here it is Trivium's Electron
 * executable, so a helper an extension starts with spawn(process.execPath, [script]) would open another app
 * instead of running the script. These routes make such children run as Node, and only those children:
 * commands the agent runs through bash, and other Electron apps they launch, are untouched.
 */

export interface SpawnTarget {
	command: string;
	options: { env?: NodeJS.ProcessEnv; shell?: unknown } & Record<string, unknown>;
}

export interface NodeHost {
	execPath: string;
	env: NodeJS.ProcessEnv;
	/** Whether a real `node` is on PATH. */
	hasNode: () => boolean;
}

const sameFile = (a: string, b: string): boolean =>
	process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/**
 * Where a direct spawn should go. Trivium's own executable runs as Node; a bare `node` uses the one on PATH,
 * or Trivium as Node when there is none. Shell commands and everything else are returned as they are.
 */
export function routeSpawn(target: SpawnTarget, host: NodeHost): SpawnTarget {
	const { command, options } = target;
	if (options.shell) return target;
	const isSelf = sameFile(command, host.execPath);
	const isBareNode = /^node(\.exe)?$/i.test(command) && !host.hasNode();
	if (!isSelf && !isBareNode) return target;
	return { command: host.execPath, options: { ...options, env: { ...(options.env ?? host.env), ELECTRON_RUN_AS_NODE: "1" } } };
}

function nodeOnPath(env: NodeJS.ProcessEnv): boolean {
	const names = process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"];
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
	return dirs.some((dir) => names.some((name) => existsSync(join(dir, name))));
}

type Launcher = (command: string, ...rest: unknown[]) => unknown;

/** spawn and execFile take (command, args?, options?, callback?), where args and options may each be left out. */
function wrap(original: Launcher, host: NodeHost): Launcher {
	return (command, ...rest) => {
		const args = Array.isArray(rest[0]) || (rest.length && rest[0] == null) ? (rest.shift() ?? []) : [];
		const given = typeof rest[0] === "object" || (rest.length && rest[0] === undefined) ? rest.shift() : undefined;
		const routed = routeSpawn({ command, options: (given ?? {}) as SpawnTarget["options"] }, host);
		return original(routed.command, args, routed.options, ...rest);
	};
}

/** execFile's promisified form is bound to the original, so the wrapped one needs its own. */
function promisified(execFile: Launcher): Launcher {
	return (command, ...rest) => {
		let child: unknown;
		const result = new Promise((done, fail) => {
			child = execFile(command, ...rest, (error: (Error & object) | null, stdout: unknown, stderr: unknown) =>
				error ? fail(Object.assign(error, { stdout, stderr })) : done({ stdout, stderr }),
			);
		});
		return Object.assign(result, { child });
	};
}

/** Trivium's own copy of the pi package, which pi-subagents needs to start child pi processes. */
function piPackageRoot(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	for (; dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
	}
	return undefined;
}

/** Installs the routes for the whole main process, where extensions run. Call once, before sessions load. */
export function installNodeHost(): void {
	let hasNode: boolean | undefined;
	const host: NodeHost = { execPath: process.execPath, env: process.env, hasNode: () => (hasNode ??= nodeOnPath(process.env)) };
	// The CommonJS exports object is the mutable one; syncing carries the change to ESM named imports.
	const cp = createRequire(import.meta.url)("node:child_process") as Record<"spawn" | "spawnSync" | "execFile" | "execFileSync", Launcher>;
	for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) cp[name] = wrap(cp[name], host);
	Object.assign(cp.execFile, { [promisify.custom]: promisified(cp.execFile) });
	syncBuiltinESMExports();
	process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT ??= piPackageRoot();
}
