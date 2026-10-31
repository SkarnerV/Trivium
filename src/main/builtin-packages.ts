import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import type { LoadExtensionsResult, PackageSource } from "@earendil-works/pi-coding-agent";
import { packageName } from "../shared/packages.ts";
import { DEFAULT_PERMISSION_MODE, type PermissionModeId } from "../shared/permissions.ts";
import type { AppId } from "../shared/protocol.ts";
import { builtInPackages } from "../shared/recommended.ts";

const require = createRequire(import.meta.url);

export interface BuiltInPackage {
	name: string;
	dir: string;
}

/** Where a shipped package is installed: Trivium's own node_modules, found as Node would find it. */
export function packageDir(name: string): string | undefined {
	for (const base of require.resolve.paths(name) ?? []) {
		const dir = join(base, name);
		if (existsSync(join(dir, "package.json"))) return dir;
	}
	return undefined;
}

/**
 * The packages Trivium ships that this app loads: those the user hasn't removed, and not those also installed
 * through pi, whose own copy loads instead of a second one.
 */
export function activeBuiltIns(app: AppId, removed: string[], installed: PackageSource[], find = packageDir): BuiltInPackage[] {
	const skip = new Set([...removed, ...installed.map((entry) => packageName(typeof entry === "string" ? entry : entry.source))]);
	return builtInPackages(app).flatMap((name) => {
		const dir = skip.has(name) ? undefined : find(name);
		return dir ? [{ name, dir }] : [];
	});
}

/**
 * Drops a shipped package that registers a tool another extension also registers, with the conflicts pi reported
 * for it. The user's own copy wins, as in activeBuiltIns, and covers one whose package name differs: pi-memory,
 * which Trivium shipped before, and @pify/memory both register memory_write.
 */
export function dropClashingBuiltIns(result: LoadExtensionsResult, builtInDirs: string[], off = new Set<string>()): LoadExtensionsResult {
	const isBuiltIn = (path: string) => builtInDirs.some((dir) => path.startsWith(dir + sep));
	const theirs = new Set(
		result.extensions
			.filter((extension) => !isBuiltIn(extension.resolvedPath) && !off.has(extension.resolvedPath))
			.flatMap((extension) => [...extension.tools.keys()]),
	);
	const clashing = result.extensions.filter(
		(extension) => isBuiltIn(extension.resolvedPath) && [...extension.tools.keys()].some((tool) => theirs.has(tool)),
	);
	if (clashing.length === 0) return result;
	const dropped = new Set(clashing.flatMap((extension) => [extension.path, extension.resolvedPath]));
	// Providers an extension registered while loading are queued separately; drop those too.
	result.runtime.pendingProviderRegistrations = result.runtime.pendingProviderRegistrations.filter(
		(registration) => !dropped.has(registration.extensionPath),
	);
	return {
		...result,
		extensions: result.extensions.filter((extension) => !dropped.has(extension.path)),
		// pi reports a conflict on the later of the two, naming the earlier.
		errors: result.errors.filter(
			(error) => !/^(Tool|Flag) ".+" conflicts with /.test(error.error) || ![...dropped].some((path) => error.path === path || error.error.endsWith(` ${path}`)),
		),
	};
}

/**
 * The mode closest to the pi-permission-system policy Trivium wrote before it had its own gate, so an upgrade keeps
 * the user's choice: yolo mode was Bypass, a bash policy of "ask" was Always ask, and anything else Approve for me.
 */
export function legacyPermissionMode(agentDir: string): PermissionModeId {
	try {
		const config = JSON.parse(readFileSync(join(agentDir, "extensions", "pi-permission-system", "config.json"), "utf8")) as {
			yoloMode?: unknown;
			permission?: { bash?: unknown };
		};
		if (config.yoloMode === true) return "bypass";
		if (config.permission?.bash === "ask") return "ask";
	} catch {
		// No config, or one Trivium can't read: the default.
	}
	return DEFAULT_PERMISSION_MODE;
}
