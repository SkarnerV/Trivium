import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ShortcutDetails } from "electron";
import { APP_USER_MODEL_ID, LEGACY_APP_USER_MODEL_IDS } from "../shared/branding.ts";

function isTriviumShortcut(details: ShortcutDetails | undefined): boolean {
	const id = details?.appUserModelId;
	return Boolean(id && (id === APP_USER_MODEL_ID || LEGACY_APP_USER_MODEL_IDS.includes(id)));
}

interface ShortcutShell {
	readShortcutLink(path: string): ShortcutDetails;
	writeShortcutLink(path: string, operation: "create" | "update" | "replace", details: ShortcutDetails): boolean;
}

interface Registration {
	appData: string;
	appPath: string;
	executable: string;
	icon: string;
	packaged: boolean;
}

function shortcutsIn(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return shortcutsIn(path);
		return entry.isFile() && entry.name.toLowerCase().endsWith(".lnk") ? [path] : [];
	});
}

function samePath(a: string | undefined, b: string | undefined): boolean {
	return Boolean(a && b && resolve(a).toLowerCase() === resolve(b).toLowerCase());
}

/** Windows resolves taskbar identity through shortcuts too, not just the window/executable icon. */
export function registerWindowsShortcuts(shell: ShortcutShell, options: Registration): string[] {
	const programs = join(options.appData, "Microsoft/Windows/Start Menu/Programs");
	const pinned = join(options.appData, "Microsoft/Internet Explorer/Quick Launch/User Pinned");
	const canonical = join(programs, "Trivium.lnk");
	const legacy = join(programs, "Electron.lnk");
	const appPath = resolve(options.appPath);
	const desired: ShortcutDetails = {
		target: resolve(options.executable),
		args: options.packaged ? "" : `"${appPath}"`,
		cwd: appPath,
		description: "Trivium — Code, Research, Write",
		icon: resolve(options.icon),
		iconIndex: 0,
		appUserModelId: APP_USER_MODEL_ID,
	};
	const read = (path: string): ShortcutDetails | undefined => {
		try { return shell.readShortcutLink(path); } catch { return undefined; }
	};
	const existing = existsSync(canonical) ? read(canonical) : undefined;
	// Never overwrite someone else's shortcut, even if it happens to have our display name.
	if (existsSync(canonical) && !isTriviumShortcut(existing)) {
		throw new Error("Trivium.lnk already exists but is not owned by Trivium.");
	}
	const owned = [...shortcutsIn(programs), ...shortcutsIn(pinned)]
		.filter((path) => isTriviumShortcut(read(path)));
	const changed: string[] = [];
	mkdirSync(programs, { recursive: true });
	for (const path of new Set([canonical, ...owned])) {
		// Remove only the old default-named Start Menu entry with our exact application identity.
		// User-created/pinned aliases are repaired in place instead.
		if (path === legacy) continue;
		const current = read(path);
		if (current && samePath(current.target, desired.target) && samePath(current.cwd, desired.cwd)
			&& samePath(current.icon, desired.icon) && current.args === desired.args
			&& current.iconIndex === 0 && current.appUserModelId === APP_USER_MODEL_ID) continue;
		if (!shell.writeShortcutLink(path, existsSync(path) ? "update" : "create", desired)) {
			throw new Error(`Could not register Trivium shortcut: ${path}`);
		}
		changed.push(path);
	}
	if (owned.includes(legacy)) {
		rmSync(legacy);
		changed.push(legacy);
	}
	return changed;
}

/** Ask Explorer to re-read application icons; do not delete caches or restart Explorer. */
export function refreshWindowsIcons(): Promise<void> {
	const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
public static class TriviumShellNotify {
[DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}'; [TriviumShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)`;
	return new Promise((resolve, reject) => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
			{ windowsHide: true, timeout: 10_000 }, (error) => error ? reject(error) : resolve());
	});
}
