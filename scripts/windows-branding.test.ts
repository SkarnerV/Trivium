import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import type { ShortcutDetails } from "electron";
import { registerWindowsShortcuts } from "../src/main/windows-branding.ts";
import { APP_USER_MODEL_ID, LEGACY_APP_USER_MODEL_IDS } from "../src/shared/branding.ts";

function fixture(t: { after(fn: () => void): void }) {
	const directory = mkdtempSync(join(tmpdir(), "trivium-branding-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const options = {
		appData: directory, appPath: join(directory, "project with spaces"),
		executable: join(directory, "runtime/Trivium.exe"), icon: join(directory, "dist/trivium-icon.ico"), packaged: false,
	};
	const programs = join(directory, "Microsoft/Windows/Start Menu/Programs");
	const pinned = join(directory, "Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar");
	const save = (path: string, details: ShortcutDetails) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(details));
	};
	const shell = {
		readShortcutLink: (path: string): ShortcutDetails => JSON.parse(readFileSync(path, "utf8")),
		writeShortcutLink: (path: string, _operation: string, details: ShortcutDetails) => { save(path, details); return true; },
	};
	return { options, programs, pinned, save, shell };
}

test("repairs Trivium-owned legacy and pinned shortcuts without touching other apps", (t) => {
	const { options, programs, pinned, save, shell } = fixture(t);
	const legacy = join(programs, "Electron.lnk");
	const canonical = join(programs, "Trivium.lnk");
	const alias = join(pinned, "My Trivium.lnk");
	const unrelated = join(pinned, "Electron.lnk");
	const old = { target: join(options.appPath, "node_modules/electron/dist/electron.exe"), appUserModelId: APP_USER_MODEL_ID };
	save(legacy, old);
	save(canonical, { target: options.executable, appUserModelId: APP_USER_MODEL_ID, args: "" });
	save(alias, old);
	save(unrelated, { target: "Other Electron.exe", appUserModelId: "some.other.app" });
	const before = readFileSync(unrelated, "utf8");
	const changed = registerWindowsShortcuts(shell, options);
	assert.ok(changed.includes(legacy));
	assert.equal(existsSync(legacy), false);
	for (const path of [canonical, alias]) {
		const shortcut = shell.readShortcutLink(path);
		assert.equal(shortcut.target, options.executable);
		assert.equal(shortcut.args, `"${options.appPath}"`);
		assert.equal(shortcut.cwd, options.appPath);
		assert.equal(shortcut.icon, options.icon);
		assert.equal(shortcut.iconIndex, 0);
		assert.equal(shortcut.appUserModelId, APP_USER_MODEL_ID);
	}
	assert.equal(readFileSync(unrelated, "utf8"), before);
	assert.deepEqual(registerWindowsShortcuts(shell, options), [], "registration must be idempotent");
});

test("migrates the old Electron-associated application identity in Start Menu and pinned links", (t) => {
	const { options, programs, pinned, save, shell } = fixture(t);
	const canonical = join(programs, "Trivium.lnk");
	const alias = join(pinned, "Trivium.lnk");
	const old = { target: options.executable, appUserModelId: LEGACY_APP_USER_MODEL_IDS[0]! };
	save(canonical, old);
	save(alias, old);
	registerWindowsShortcuts(shell, options);
	assert.equal(shell.readShortcutLink(canonical).appUserModelId, APP_USER_MODEL_ID);
	assert.equal(shell.readShortcutLink(alias).appUserModelId, APP_USER_MODEL_ID);
});

test("preserves an unrelated default-named Electron Start Menu shortcut", (t) => {
	const { options, programs, save, shell } = fixture(t);
	const legacy = join(programs, "Electron.lnk");
	save(legacy, { target: "unrelated.exe", appUserModelId: "unrelated.app" });
	const before = readFileSync(legacy, "utf8");
	registerWindowsShortcuts(shell, options);
	assert.equal(readFileSync(legacy, "utf8"), before);
});

test("source shortcut arguments normalize a trailing slash before adding quotes", (t) => {
	const { options, programs, shell } = fixture(t);
	registerWindowsShortcuts(shell, { ...options, appPath: options.appPath + sep });
	assert.equal(shell.readShortcutLink(join(programs, "Trivium.lnk")).args, `"${options.appPath}"`);
});

test("packaged shortcuts do not pass the source project as an argument", (t) => {
	const { options, programs, shell } = fixture(t);
	registerWindowsShortcuts(shell, { ...options, packaged: true });
	assert.equal(shell.readShortcutLink(join(programs, "Trivium.lnk")).args, "");
});

test("does not overwrite a shortcut named Trivium that belongs to another application", (t) => {
	const { options, programs, save, shell } = fixture(t);
	const canonical = join(programs, "Trivium.lnk");
	save(canonical, { target: "another.exe", appUserModelId: "another.app" });
	const before = readFileSync(canonical, "utf8");
	assert.throws(() => registerWindowsShortcuts(shell, options), /not owned by Trivium/);
	assert.equal(readFileSync(canonical, "utf8"), before);
});

test("keeps the legacy shortcut if the replacement cannot be created", (t) => {
	const { options, programs, save, shell } = fixture(t);
	const legacy = join(programs, "Electron.lnk");
	save(legacy, { target: "electron.exe", appUserModelId: APP_USER_MODEL_ID });
	assert.throws(() => registerWindowsShortcuts({ ...shell, writeShortcutLink: () => false }, options), /Could not register/);
	assert.equal(existsSync(legacy), true);
});
