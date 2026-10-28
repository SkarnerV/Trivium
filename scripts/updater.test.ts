import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UpdateStatus } from "../src/shared/protocol.ts";
import { assetName, installTarget, newerThan, readRelease, Updater, type UpdaterOptions, windowsScript } from "../src/main/updater.ts";

test("versions compare by number, and a release comes after its prereleases", () => {
	assert.equal(newerThan("v0.3.0", "0.2.0"), true);
	assert.equal(newerThan("0.10.0", "0.9.9"), true);
	assert.equal(newerThan("0.2.0", "0.2.0"), false);
	assert.equal(newerThan("0.1.9", "0.2.0"), false);
	assert.equal(newerThan("1.0.0", "1.0.0-beta.2"), true);
	assert.equal(newerThan("1.0.0-beta.10", "1.0.0-beta.9"), true);
	assert.equal(newerThan("1.0.0-beta", "1.0.0"), false);
});

test("each platform downloads the file electron-builder names for it", () => {
	assert.equal(assetName("0.3.0", "win32", "x64"), "Trivium-0.3.0-Windows-x64.zip");
	assert.equal(assetName("0.3.0", "darwin", "arm64"), "Trivium-0.3.0-macOS-arm64.dmg");
	assert.equal(assetName("0.3.0", "darwin", "x64"), "Trivium-0.3.0-macOS-x64.dmg");
	assert.equal(assetName("0.3.0", "win32", "arm64"), undefined);
	assert.equal(assetName("0.3.0", "linux", "x64"), undefined);
});

test("an update replaces Trivium's folder on Windows and its bundle on macOS", () => {
	assert.equal(installTarget("win32", "C:\\Apps\\Trivium\\Trivium.exe"), "C:\\Apps\\Trivium");
	assert.equal(installTarget("darwin", "/Applications/Trivium.app/Contents/MacOS/Trivium"), "/Applications/Trivium.app");
	assert.equal(installTarget("darwin", "/usr/local/bin/electron"), undefined);
});

const RELEASE = {
	tag_name: "v0.3.0",
	html_url: "https://github.com/SkarnerV/Trivium/releases/tag/v0.3.0",
	body: "Notes",
	published_at: "2026-11-01T00:00:00Z",
	assets: [
		{ name: "Trivium-0.3.0-Windows-x64.zip", browser_download_url: "https://example.test/win.zip", size: 10, digest: "sha256:abc" },
		{ name: "Trivium-0.3.0-macOS-arm64.dmg", browser_download_url: "https://example.test/arm.dmg", size: 20, digest: null },
	],
};

test("a newer release is read with this platform's download", () => {
	const found = readRelease(RELEASE, "0.2.0", "win32", "x64");
	assert.equal(found?.release.version, "0.3.0");
	assert.equal(found?.release.url, RELEASE.html_url);
	assert.deepEqual(found?.asset, { name: "Trivium-0.3.0-Windows-x64.zip", url: "https://example.test/win.zip", size: 10, digest: "sha256:abc" });
	assert.equal(readRelease(RELEASE, "0.2.0", "darwin", "arm64")?.asset?.digest, undefined);
	// Found, but with nothing to download for this platform.
	assert.equal(readRelease(RELEASE, "0.2.0", "darwin", "x64")?.asset, undefined);
});

test("the running version, older ones, drafts and prereleases are not updates", () => {
	assert.equal(readRelease(RELEASE, "0.3.0", "win32", "x64"), undefined);
	assert.equal(readRelease(RELEASE, "0.4.0", "win32", "x64"), undefined);
	assert.equal(readRelease({ ...RELEASE, draft: true }, "0.2.0", "win32", "x64"), undefined);
	assert.equal(readRelease({ ...RELEASE, prerelease: true }, "0.2.0", "win32", "x64"), undefined);
	assert.equal(readRelease({}, "0.2.0", "win32", "x64"), undefined);
});

function updater(json: unknown, overrides: Partial<UpdaterOptions> = {}): { updater: Updater; events: UpdateStatus[] } {
	const events: UpdateStatus[] = [];
	const dir = mkdtempSync(join(tmpdir(), "trivium-updater-"));
	const instance = new Updater({
		version: "0.2.0",
		platform: "win32",
		arch: "x64",
		execPath: join(dir, "Trivium.exe"),
		packaged: true,
		portable: false,
		dir,
		fetch: async () => new Response(JSON.stringify(json), { status: 200 }),
		emit: (status) => events.push(status),
		enabled: () => true,
		confirmQuit: async () => true,
		quit: () => {},
		...overrides,
	});
	return { updater: instance, events };
}

test("a check finds the release and says whether Trivium can install it", async () => {
	const { updater: found } = updater(RELEASE);
	const status = await found.check();
	assert.equal(status.state, "available");
	assert.equal(status.state === "available" && status.release.installable, true);

	const fromSource = await updater(RELEASE, { packaged: false }).updater.check();
	assert.equal(fromSource.state === "available" && fromSource.release.installable, false);
	assert.match(fromSource.state === "available" ? fromSource.release.reason ?? "" : "", /source/);

	const portable = await updater(RELEASE, { portable: true }).updater.check();
	assert.match(portable.state === "available" ? portable.release.reason ?? "" : "", /ZIP/);

	assert.equal((await updater({ ...RELEASE, tag_name: "v0.2.0" }).updater.check()).state, "current");
});

test("a check the user asked for reports a failure; a scheduled one keeps what it had", async () => {
	const failing = { fetch: async () => new Response("", { status: 403 }) };
	const manual = await updater(RELEASE, failing).updater.check(true);
	assert.equal(manual.state, "error");
	assert.match(manual.state === "error" ? manual.message : "", /rate limited/);

	const { updater: quiet, events } = updater(RELEASE, failing);
	const original = console.error;
	console.error = () => {};
	try {
		assert.equal((await quiet.check(false)).state, "idle");
	} finally {
		console.error = original;
	}
	assert.deepEqual(
		events.map((event) => event.state),
		["idle"],
	);
});

test("a download that doesn't match the release's checksum is not installed", async () => {
	const body = new Uint8Array(10);
	const release = { ...RELEASE, assets: [{ ...RELEASE.assets[0]!, digest: "sha256:0000" }] };
	const { updater: instance } = updater(release, {
		fetch: async (url) => (url.includes("api.github.com") ? new Response(JSON.stringify(release)) : new Response(body, { headers: { "content-length": "10" } })),
	});
	await instance.check();
	await assert.rejects(instance.install(), /checksum/);
	const status = instance.get();
	assert.equal(status.state, "error");
	// The release stays, so the user can try again.
	assert.equal(status.state === "error" && status.release?.version, "0.3.0");
});

test(
	"the Windows script swaps in the new version, keeps the user's other files, and starts Trivium",
	{ skip: process.platform !== "win32" && "PowerShell script" },
	() => {
		const root = mkdtempSync(join(tmpdir(), "trivium-swap-"));
		try {
			const target = join(root, "Trivium");
			const staging = join(target, ".trivium-update");
			mkdirSync(join(target, "resources", "old-only"), { recursive: true });
			writeFileSync(join(target, "resources", "app.txt"), "old");
			writeFileSync(join(target, "resources", "old-only", "stale.txt"), "stale");
			writeFileSync(join(target, "notes.txt"), "mine");
			mkdirSync(join(staging, "resources"), { recursive: true });
			writeFileSync(join(staging, "resources", "app.txt"), "new");
			writeFileSync(join(staging, "added.txt"), "added");
			// Stands in for Trivium.exe: a script that records it was started.
			const started = join(root, "started.txt");
			const exe = join(root, "start.cmd");
			writeFileSync(exe, `@echo started> "${started}"\r\n`);
			const log = join(root, "failed.log");
			const script = join(root, "install.ps1");
			// Any process that has already exited will do for the wait.
			writeFileSync(script, `\uFEFF${windowsScript({ pid: 999999, source: staging, target, staging, exe, log })}`);
			const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(existsSync(log), false, existsSync(log) ? readFileSync(log, "utf8") : "");
			assert.equal(readFileSync(join(target, "resources", "app.txt"), "utf8"), "new");
			assert.equal(existsSync(join(target, "resources", "old-only")), false);
			assert.equal(readFileSync(join(target, "added.txt"), "utf8"), "added");
			assert.equal(readFileSync(join(target, "notes.txt"), "utf8"), "mine");
			assert.equal(existsSync(staging), false);
			assert.equal(existsSync(join(target, ".trivium-previous")), false);
			for (let i = 0; i < 50 && !existsSync(started); i++) spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 100"]);
			assert.equal(existsSync(started), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
