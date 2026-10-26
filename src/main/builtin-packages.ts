import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import { packageName } from "../shared/packages.ts";
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

export const PERMISSION_PACKAGE = "@gotgenes/pi-permission-system";

/**
 * With no config, pi-permission-system asks before every tool call. This starting policy keeps Code working as it
 * did and gates what is hard to undo; it is written only when the user has no config of their own.
 */
export const STARTER_PERMISSIONS = {
	permission: {
		"*": "allow",
		path: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
		bash: { "*": "allow", "rm -rf *": "ask", "sudo *": "ask", "git push": "ask", "git push *": "ask" },
		external_directory: "ask",
	},
};

export function ensurePermissionConfig(agentDir: string): void {
	const dir = join(agentDir, "extensions", "pi-permission-system");
	const file = join(dir, "config.json");
	if (existsSync(file)) return;
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, `${JSON.stringify(STARTER_PERMISSIONS, null, "\t")}\n`, { flag: "wx" });
}
