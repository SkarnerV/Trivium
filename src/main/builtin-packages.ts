import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import type { LoadExtensionsResult, PackageSource } from "@earendil-works/pi-coding-agent";
import { packageName } from "../shared/packages.ts";
import { DEFAULT_PERMISSION_LEVEL, PERMISSION_LEVELS, permissionLevelOf, withPermissionLevel } from "../shared/permissions.ts";
import type { AppId, PermissionSettings } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";
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

export const PERMISSION_PACKAGE = "@gotgenes/pi-permission-system";

export const permissionConfigPath = (agentDir: string): string => join(agentDir, "extensions", "pi-permission-system", "config.json");

const format = (config: unknown) => `${JSON.stringify(config, null, "\t")}\n`;

/**
 * With no config, pi-permission-system asks before every tool call. The default level keeps Code working as it
 * did and gates what is hard to undo; it is written only when the user has no config of their own.
 */
export function ensurePermissionConfig(agentDir: string): void {
	const file = permissionConfigPath(agentDir);
	if (existsSync(file)) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, format({ permission: DEFAULT_PERMISSION_LEVEL.permission }), { flag: "wx" });
}

/**
 * The level the config sets. A missing file reads as the default, which the next Code session writes. A file
 * Trivium can't parse as plain JSON, such as one with comments, is left to the user.
 */
export function readPermissions(agentDir: string): PermissionSettings {
	const path = permissionConfigPath(agentDir);
	if (!existsSync(path)) return { path, level: DEFAULT_PERMISSION_LEVEL.id };
	try {
		const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return { path, level: permissionLevelOf(config)?.id ?? "custom" };
	} catch {
		return { path, level: "custom", unreadable: true };
	}
}

/** Sets a level's policy, keeping the config's other settings. Refuses a file it can't parse rather than lose it. */
export async function writePermissionLevel(agentDir: string, id: string): Promise<PermissionSettings> {
	const level = PERMISSION_LEVELS.find((entry) => entry.id === id);
	if (!level) throw new Error(`Unknown permission level: ${id}`);
	const path = permissionConfigPath(agentDir);
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			throw new Error(t("{path} isn't plain JSON, so Trivium won't rewrite it. Edit it directly.", { path }));
		}
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(`${path}.tmp`, format(withPermissionLevel(config, level)));
	await rename(`${path}.tmp`, path);
	return { path, level: level.id };
}
