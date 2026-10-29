import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import type { ReleaseInfo, UpdateStatus } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";

const run = promisify(execFile);

export const REPOSITORY = "SkarnerV/Trivium";
const FIRST_CHECK = 15_000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
/** Written by the install script when it could not put the new version in place; read at the next start. */
const FAILURE_LOG = "failed.log";

export interface ReleaseAsset {
	name: string;
	url: string;
	size: number;
	/** "sha256:<hex>", which GitHub records for each uploaded file. */
	digest?: string;
}

/** The fields Trivium reads from GitHub's release JSON. */
interface GitHubRelease {
	tag_name?: string;
	html_url?: string;
	body?: string | null;
	published_at?: string;
	draft?: boolean;
	prerelease?: boolean;
	assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
}

/** Whether version `a` comes after `b`. Versions are x.y.z, optionally with a leading v and a -prerelease. */
export function newerThan(a: string, b: string): boolean {
	const parse = (version: string) => {
		const [core = "", pre] = version.trim().replace(/^v/i, "").split("-", 2);
		return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
		const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
		if (diff) return diff > 0;
	}
	// 1.0.0 comes after 1.0.0-beta.
	if (x.pre === undefined || y.pre === undefined) return x.pre === undefined && y.pre !== undefined;
	return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0;
}

/** The release file for this platform, as electron-builder.yml names it. */
export function assetName(version: string, platform: NodeJS.Platform, arch: string): string | undefined {
	if (platform === "win32" && arch === "x64") return `Trivium-${version}-Windows-x64.zip`;
	if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `Trivium-${version}-macOS-${arch}.dmg`;
	return undefined;
}

/** What an update replaces: the folder holding Trivium.exe, or the Trivium.app bundle. */
export function installTarget(platform: NodeJS.Platform, execPath: string): string | undefined {
	if (platform === "win32") return win32.dirname(execPath);
	if (platform === "darwin") return /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
	return undefined;
}

/** The release GitHub reports, when it is newer than `current`, with this platform's download. */
export function readRelease(
	json: GitHubRelease,
	current: string,
	platform: NodeJS.Platform,
	arch: string,
): { release: Omit<ReleaseInfo, "installable" | "reason">; asset?: ReleaseAsset } | undefined {
	const tag = json.tag_name;
	if (!tag || json.draft || json.prerelease || !newerThan(tag, current)) return undefined;
	const version = tag.replace(/^v/i, "");
	const name = assetName(version, platform, arch);
	const found = name ? json.assets?.find((asset) => asset.name === name) : undefined;
	return {
		release: {
			version,
			url: json.html_url ?? `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
			notes: json.body ?? "",
			publishedAt: json.published_at ?? "",
		},
		asset: found && { name: found.name, url: found.browser_download_url, size: found.size, digest: found.digest ?? undefined },
	};
}

const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
const sh = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Waits for Trivium to exit, then moves each top-level entry of the new version over the old one, keeping the
 * old entry aside until all have moved so a failure puts the old version back. Other files the user keeps in the
 * folder stay. Starts Trivium again either way.
 */
export function windowsScript(input: { pid: number; source: string; target: string; staging: string; exe: string; log: string }): string {
	return `$ErrorActionPreference = 'Stop'
$source = ${ps(input.source)}
$target = ${ps(input.target)}
$backup = Join-Path $target '.trivium-previous'
function Retry([scriptblock]$step) {
	for ($i = 0; ; $i++) {
		try { & $step; return } catch { if ($i -ge 40) { throw }; Start-Sleep -Milliseconds 500 }
	}
}
try {
	Wait-Process -Id ${input.pid} -Timeout 60 -ErrorAction SilentlyContinue
	if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
	New-Item -ItemType Directory -Path $backup | Out-Null
	$moved = @()
	try {
		foreach ($item in @(Get-ChildItem -LiteralPath $source -Force)) {
			$dest = Join-Path $target $item.Name
			if (Test-Path -LiteralPath $dest) { Retry { Move-Item -LiteralPath $dest -Destination (Join-Path $backup $item.Name) } }
			$moved += $item.Name
			Retry { Move-Item -LiteralPath $item.FullName -Destination $dest }
		}
	} catch {
		foreach ($name in $moved) {
			$dest = Join-Path $target $name
			$old = Join-Path $backup $name
			if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue }
			if (Test-Path -LiteralPath $old) { Move-Item -LiteralPath $old -Destination $dest -ErrorAction SilentlyContinue }
		}
		throw
	}
} catch {
	Set-Content -LiteralPath ${ps(input.log)} -Value $_.Exception.Message -Encoding utf8
} finally {
	Start-Process -FilePath ${ps(input.exe)} -WorkingDirectory $target
	Remove-Item -LiteralPath ${ps(input.staging)}, $backup -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

/** How the install script starts. It runs in `cwd`, and must keep running once Trivium quits. */
export interface Launch {
	command: string;
	args: string[];
	cwd: string;
	/** The arguments go on the command line as written, for cmd's own quoting. */
	verbatim?: boolean;
}

/**
 * Starts the Windows install script through `start`, from a detached cmd. Node ends every child that isn't
 * detached when Trivium exits, and PowerShell started detached has no console and exits without running the
 * script; `start` gives PowerShell a console of its own, minimized and then hidden.
 */
export function windowsLaunch(script: string): Launch {
	const powershell = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${basename(script)}"`;
	return {
		command: process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
		// The script is named relative to its folder, so nothing in the path can mean something to cmd.
		args: ["/d", "/s", "/c", `"start "" /min ${powershell}"`],
		cwd: dirname(script),
		verbatim: true,
	};
}

/** Starts the install script on its own, so it keeps running once Trivium quits. */
export function launch({ command, args, cwd, verbatim }: Launch): void {
	spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: verbatim }).unref();
}

/** Waits for Trivium to exit, swaps in the new Trivium.app, putting the old one back if that fails, and opens it. */
export function macScript(input: { pid: number; source: string; target: string; log: string }): string {
	return `#!/bin/sh
target=${sh(input.target)}
source=${sh(input.source)}
backup="$target.previous"
while kill -0 ${input.pid} 2>/dev/null; do sleep 0.5; done
rm -rf "$backup"
if mv "$target" "$backup"; then
	if mv "$source" "$target"; then
		rm -rf "$backup"
	else
		mv "$backup" "$target"
		echo "The new version could not be moved into place." > ${sh(input.log)}
	fi
else
	echo "The current version could not be moved aside." > ${sh(input.log)}
fi
rm -rf "$source"
xattr -dr com.apple.quarantine "$target" 2>/dev/null
open "$target"
`;
}

export interface UpdaterOptions {
	version: string;
	platform: NodeJS.Platform;
	arch: string;
	execPath: string;
	/** False when running from source, where updates are reported but come through git. */
	packaged: boolean;
	/** The portable EXE extracts itself to a temporary folder on each launch, so there is nothing to replace. */
	portable: boolean;
	/** Downloads and the install script's failure log. */
	dir: string;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	emit: (status: UpdateStatus) => void;
	/** Whether the user wants the periodic check. */
	enabled: () => boolean;
	/** Asks to quit, as closing the window does; false when the user kept Trivium open. */
	confirmQuit: () => Promise<boolean>;
	quit: () => void;
}

/** Finds new Trivium releases on GitHub, and replaces this copy of Trivium with one when the user asks. */
export class Updater {
	private status: UpdateStatus = { state: "idle" };
	private asset: ReleaseAsset | undefined;
	/** The install script, written once the new version is unpacked and waiting for the restart. */
	private pending: Launch | undefined;
	private timers: NodeJS.Timeout[] = [];
	private readonly options: UpdaterOptions;

	constructor(options: UpdaterOptions) {
		this.options = options;
	}

	get(): UpdateStatus {
		return this.status;
	}

	/** Reports a failed install from the last restart, then checks shortly after startup and every few hours. */
	async start(): Promise<void> {
		const log = join(this.options.dir, FAILURE_LOG);
		if (existsSync(log)) {
			const reason = (await readFile(log, "utf8").catch(() => "")).trim();
			await rm(log, { force: true });
			this.set({ state: "error", message: reason ? t("The last update could not be installed: {reason}", { reason }) : t("The last update could not be installed.") });
		}
		// An install script that never ran, as from 0.3.0 and earlier, left the unpacked version behind.
		if (this.options.platform === "win32" && this.options.packaged && !this.options.portable) {
			const target = installTarget("win32", this.options.execPath)!;
			await Promise.all([".trivium-update", ".trivium-previous"].map((name) => rm(join(target, name), { recursive: true, force: true }).catch(() => {})));
		}
		const scheduled = () => {
			if (this.options.enabled()) void this.check(false);
		};
		this.timers.push(setTimeout(scheduled, FIRST_CHECK), setInterval(scheduled, CHECK_EVERY));
	}

	dispose(): void {
		for (const timer of this.timers) clearTimeout(timer);
	}

	/** Asks GitHub for the latest release. A check the user didn't ask for fails quietly. */
	async check(manual = true): Promise<UpdateStatus> {
		const busy = ["checking", "downloading", "installing", "ready"];
		if (busy.includes(this.status.state)) return this.status;
		const before = this.status;
		if (manual) this.set({ state: "checking" });
		try {
			const response = await this.options.fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": `Trivium/${this.options.version}` },
			});
			if (!response.ok) {
				throw new Error(response.status === 403 ? t("GitHub answered 403 (rate limited, try again later).") : t("GitHub answered {status}.", { status: response.status }));
			}
			const found = readRelease((await response.json()) as GitHubRelease, this.options.version, this.options.platform, this.options.arch);
			if (!found) {
				this.asset = undefined;
				return this.set({ state: "current", checkedAt: Date.now() });
			}
			this.asset = found.asset;
			const reason = await this.blocker(found.asset);
			return this.set({ state: "available", release: { ...found.release, installable: !reason, ...(reason ? { reason } : {}) } });
		} catch (error) {
			if (!manual) {
				console.error("Could not check for updates:", error);
				return this.set(before);
			}
			return this.set({ state: "error", message: t("Could not check for updates: {error}", { error: messageOf(error) }) });
		}
	}

	/** Downloads the release, puts it in place and restarts. Called again after the user put off a restart, it restarts. */
	async install(): Promise<void> {
		const status = this.status;
		if (status.state === "ready" && this.pending) return this.restart(status.release);
		const release = status.state === "available" || status.state === "error" ? status.release : undefined;
		if (!release) throw new Error(t("There is no update to install."));
		const asset = this.asset;
		if (!release.installable || !asset) throw new Error(release.reason ?? t("This update can't be installed from Trivium."));
		try {
			await mkdir(this.options.dir, { recursive: true });
			const file = join(this.options.dir, asset.name);
			await this.download(asset, file, release);
			this.set({ state: "installing", release });
			this.pending = this.options.platform === "win32" ? await this.stageWindows(file) : await this.stageMac(file);
			await rm(file, { force: true });
		} catch (error) {
			this.set({ state: "error", message: t("The update could not be installed: {error}", { error: messageOf(error) }), release });
			throw error;
		}
		this.set({ state: "ready", release });
		await this.restart(release);
	}

	private async restart(release: ReleaseInfo): Promise<void> {
		if (!this.pending) return;
		if (!(await this.options.confirmQuit())) {
			this.set({ state: "ready", release });
			return;
		}
		launch(this.pending);
		this.options.quit();
	}

	/** Why this copy can't replace itself, if it can't. */
	private async blocker(asset: ReleaseAsset | undefined): Promise<string | undefined> {
		const { platform, arch, packaged, portable, execPath } = this.options;
		if (!packaged) return t("Trivium is running from source. Pull the new version with git instead.");
		if (portable) return t("The portable EXE can't update itself. Download the ZIP instead.");
		if (!asset) return t("This release has no download for {platform} {arch}.", { platform, arch });
		const target = installTarget(platform, execPath);
		if (!target || target.includes("/AppTranslocation/")) return t("Move Trivium to your Applications folder to update it from here.");
		// The swap writes beside Trivium.app, and into Trivium's own folder on Windows.
		const folder = platform === "darwin" ? dirname(target) : target;
		const probe = join(folder, `.trivium-write-test-${process.pid}`);
		try {
			await writeFile(probe, "");
			await rm(probe, { force: true });
		} catch {
			return t("Trivium can't write to {folder}. Download the new version and replace it yourself.", { folder });
		}
		return undefined;
	}

	private async download(asset: ReleaseAsset, file: string, release: ReleaseInfo): Promise<void> {
		const response = await this.options.fetch(asset.url, { headers: { "User-Agent": `Trivium/${this.options.version}` } });
		if (!response.ok || !response.body) throw new Error(t("The download failed ({status}).", { status: response.status }));
		const total = Number(response.headers.get("content-length")) || asset.size;
		const hash = createHash("sha256");
		const out = createWriteStream(file);
		const reader = response.body.getReader();
		let received = 0;
		let reported = 0;
		this.set({ state: "downloading", release, received, total });
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				hash.update(value);
				received += value.byteLength;
				if (!out.write(value)) await once(out, "drain");
				// About every 1% is plenty for a progress bar.
				if (received - reported > total / 100) {
					reported = received;
					this.set({ state: "downloading", release, received, total });
				}
			}
		} finally {
			out.end();
			await once(out, "close");
		}
		if (received !== asset.size) throw new Error(t("The download is incomplete ({received} of {size} bytes).", { received, size: asset.size }));
		const [algorithm, expected] = asset.digest?.split(":") ?? [];
		if (algorithm === "sha256" && hash.digest("hex") !== expected) throw new Error(t("The download doesn't match the release's checksum."));
	}

	/** Unpacks the ZIP inside Trivium's folder, so the script's moves stay on one drive. */
	private async stageWindows(zip: string): Promise<Launch> {
		const target = installTarget("win32", this.options.execPath)!;
		const staging = join(target, ".trivium-update");
		await rm(staging, { recursive: true, force: true });
		await mkdir(staging, { recursive: true });
		const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		if (existsSync(tar)) {
			await run(tar, ["-xf", zip, "-C", staging], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
		} else {
			const command = `Expand-Archive -LiteralPath ${ps(zip)} -DestinationPath ${ps(staging)} -Force`;
			await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
		}
		const exe = basename(this.options.execPath);
		const source = await folderWith(staging, exe);
		if (!source) throw new Error(t("The download has no {file}.", { file: exe }));
		const script = join(this.options.dir, "install.ps1");
		const log = join(this.options.dir, FAILURE_LOG);
		// PowerShell 5 reads a script without a byte order mark as the system code page, which garbles non-ASCII paths.
		await writeFile(script, `\uFEFF${windowsScript({ pid: process.pid, source, target, staging, exe: join(target, exe), log })}`);
		return windowsLaunch(script);
	}

	/** Copies Trivium.app out of the disk image to beside the running one. */
	private async stageMac(dmg: string): Promise<Launch> {
		const target = installTarget("darwin", this.options.execPath)!;
		const mount = join(this.options.dir, "mount");
		const source = join(dirname(target), ".Trivium-update.app");
		await mkdir(mount, { recursive: true });
		await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg]);
		try {
			const bundle = (await readdir(mount)).find((name) => name.endsWith(".app"));
			if (!bundle) throw new Error(t("The disk image has no app in it."));
			await rm(source, { recursive: true, force: true });
			await run("ditto", [join(mount, bundle), source]);
		} finally {
			await run("hdiutil", ["detach", mount, "-force"]).catch(() => {});
		}
		const script = join(this.options.dir, "install.sh");
		await writeFile(script, macScript({ pid: process.pid, source, target, log: join(this.options.dir, FAILURE_LOG) }));
		return { command: "/bin/sh", args: [script], cwd: this.options.dir };
	}

	private set(status: UpdateStatus): UpdateStatus {
		this.status = status;
		this.options.emit(status);
		return status;
	}
}

/** The folder holding `file`: the extracted folder itself, or the one folder in it. */
async function folderWith(dir: string, file: string): Promise<string | undefined> {
	if (existsSync(join(dir, file))) return dir;
	const entries = await readdir(dir, { withFileTypes: true });
	const only = entries.length === 1 && entries[0]!.isDirectory() ? join(dir, entries[0]!.name) : undefined;
	return only && existsSync(join(only, file)) ? only : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
