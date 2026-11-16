import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// Case-insensitive on Windows, as the Changes tracker compares project files.
import { pathKey } from "./changes.ts";

/**
 * Where pi-subagents 0.82.1 writes what the host reads back: run artifacts, handoff manifests and the patches they
 * name. A session file is extension-owned JSON, and a crafted one could name any path, so the host reads a file only
 * when its real location (after links) lies under one of these roots.
 *
 * Found in the extension:
 * - `src/shared/types.js`: `TEMP_ROOT_DIR` is `PI_SUBAGENTS_TEMP_ROOT`, else `<os.tmpdir()>/pi-subagents-<scope>`.
 *   Background runs live in its `async-subagent-runs/<id>` (`ASYNC_DIR`); their manifests are
 *   `<asyncDir>/handoffs/<runId>.json` (`parallelHandoffPath` in `src/runs/shared/parallel-handoff.js`) and their
 *   patches `<asyncDir>/worktree-diffs/step-<n>/…` (`subagent-runner.js`). `TEMP_ARTIFACTS_DIR` is under it too.
 * - `src/shared/artifacts.js`, `getArtifactsDir`: foreground runs write under the artifacts directory, which by
 *   `artifactDir` is `<dirname(session file)>/subagent-artifacts` ("session", the default), the temp root ("temp"),
 *   or `<cwd>/.pi/subagents/artifacts` ("project"). `artifactDir` accepts only those three words, not a path.
 *   Manifests are `<artifactsDir>/handoffs/<runId>.json`; patches `<artifactsDir>/worktree-diffs/<runId>/…`.
 * The scope segment of the temp root depends on the user name or home folder, so any `pi-subagents-*` folder
 * directly in the temp directory is accepted rather than recomputing it.
 */
export interface ExtensionRoots {
	/** Folders whose whole subtree the extension may write to. */
	trees: string[];
	/** Folders in which only `pi-subagents-*` children count: the OS temp directory. */
	temp: string[];
}

export function handoffRoots(input: { agentDir: string; cwd: string; sessionFile?: string; env?: NodeJS.ProcessEnv; temp?: string }): ExtensionRoots {
	const env = input.env ?? process.env;
	const trees = [join(input.agentDir, "sessions"), join(input.cwd, ".pi", "subagents")];
	if (input.sessionFile) trees.push(join(dirname(input.sessionFile), "subagent-artifacts"));
	if (env.PI_SUBAGENTS_TEMP_ROOT?.trim()) trees.push(resolve(env.PI_SUBAGENTS_TEMP_ROOT.trim()));
	return { trees, temp: [input.temp ?? tmpdir()] };
}

/** Only background run folders: what a launch's `asyncDir` may name. */
export function asyncRunRoots(input: { env?: NodeJS.ProcessEnv; temp?: string } = {}): ExtensionRoots {
	const env = input.env ?? process.env;
	const custom = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	return custom ? { trees: [join(resolve(custom), "async-subagent-runs")], temp: [] } : { trees: [], temp: [input.temp ?? tmpdir()] };
}

/** `\\server\share`, `\\?\C:\…`, `\\.\pipe\…`, `//server/…`: network shares and device paths are never read. */
export function isUncOrDevice(path: string): boolean {
	return /^[\\/]{2}/.test(path);
}

async function real(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

function inside(child: string, parent: string): string | undefined {
	const rel = relative(parent, child);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	// relative() already ignores case on Windows; compare keys too so a mixed-case path cannot slip past it.
	return pathKey(child).startsWith(`${pathKey(parent).replace(/\/$/, "")}/`) ? rel : undefined;
}

/**
 * The file's real path when it lies under one of the roots, else undefined. A missing file, a relative path, a
 * UNC or device path, and a link that leads outside the roots are all refused.
 */
export async function trustedPath(path: string, roots: ExtensionRoots): Promise<string | undefined> {
	if (typeof path !== "string" || !path || !isAbsolute(path) || isUncOrDevice(path)) return undefined;
	const target = await real(path);
	if (!target || isUncOrDevice(target)) return undefined;
	for (const root of roots.trees) {
		const base = (await real(root)) ?? resolve(root);
		if (inside(target, base)) return target;
	}
	for (const root of roots.temp) {
		const base = (await real(root)) ?? resolve(root);
		const rel = inside(target, base);
		const [first, ...rest] = rel?.split(sep) ?? [];
		if (first?.startsWith("pi-subagents-") && rest.length) return target;
	}
	return undefined;
}
