import { mkdirSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { copyFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, clipboard, dialog, type IpcMainInvokeEvent, ipcMain, Menu, nativeImage, net, Notification, protocol, shell } from "electron";
import { APP_USER_MODEL_ID, appIconFilename } from "../shared/branding.ts";
import type {
	AppId,
	ConnectorInput,
	CustomProvider,
	DialogAnswer,
	GitFile,
	HostEvent,
	MemoryCategory,
	MemoryEntry,
	MemoryTarget,
	McpExposure,
	NewSessionInput,
	PresetProviderChanges,
	TriviumSettings,
	TrustChoice,
} from "../shared/protocol.ts";
import { APP_IDS } from "../shared/protocol.ts";
import { resolveLocale, setLocale, t } from "../shared/i18n.ts";
import { triviumDir, profileInfo } from "./apps.ts";
import { AttachmentStore } from "./attachments.ts";
import { ConnectorStore } from "./connectors.ts";
import { LoginFlow, listProviders } from "./auth.ts";
import { writePermissionLevel } from "./builtin-packages.ts";
import {
	fetchModels,
	fetchPresetModels,
	isBuiltIn,
	readCustomProviders,
	readPresetProvider,
	removeCustomProvider,
	saveCustomProvider,
	savePresetProvider,
} from "./custom-models.ts";
import { exportFileName, sessionMarkdown } from "./export.ts";
import { recallLessons } from "@pify/memory/src/lessons.ts";
import { scanForSecrets } from "@pify/memory/src/secrets.ts";
import { MemoryStore } from "./memory.ts";
import { installNodeHost } from "./node-host.ts";
import { DialogBroker } from "./dialogs.ts";
import { type Rewound, SessionHost } from "./host.ts";
import { packageSource } from "../shared/packages.ts";
import { READER_SCHEME, ReaderStore } from "./reader.ts";
import { ServiceTracker } from "./services.ts";
import { SettingsStore } from "./settings.ts";
import { Updater } from "./updater.ts";
import { UsageCounter } from "./usage.ts";
import { refreshWindowsIcons, registerWindowsShortcuts } from "./windows-branding.ts";

type MemoryEntryRef = Pick<MemoryEntry, "line" | "raw">;

const assets = fileURLToPath(new URL("./", import.meta.url));
const page = pathToFileURL(join(assets, "index.html")).href;
let window: BrowserWindow | undefined;

app.setName("Trivium");
// A separate home is a separate copy: its window state and storage stay with it, not the real profile.
if (process.env.TRIVIUM_HOME) app.setPath("userData", join(triviumDir, "electron"));
// Before any session loads its extensions.
installNodeHost();
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
// The Preview panel's pages load from this scheme. Standard, so a page's relative links resolve; it must be
// declared before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: READER_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);

mkdirSync(triviumDir, { recursive: true });
const settings = new SettingsStore(join(triviumDir, "settings.json"));

/** Menus, dialogs and notifications from this process speak the language the window does. */
function applyLanguage(): void {
	setLocale(resolveLocale(settings.get().language, app.getPreferredSystemLanguages()));
}

function send(event: HostEvent): void {
	if (window && !window.isDestroyed()) window.webContents.send("trivium:event", event);
}

/** A system notification, only while the window is in the background. Clicking it opens the session. */
function alert(kind: "done" | "waiting", path: string, body: string): void {
	const prefs = settings.get();
	if ((kind === "done" ? !prefs.notifyDone : !prefs.notifyWaiting) || !Notification.isSupported()) return;
	if (window?.isFocused()) return;
	const notification = new Notification({ title: t(kind === "done" ? "Run finished" : "Waiting for your answer"), body });
	notification.on("click", () => {
		window?.show();
		window?.focus();
		send({ type: "focus_session", path });
	});
	notification.show();
}

function emit(event: HostEvent): void {
	if (event.type === "dialog") alert("waiting", event.request.sessionPath, event.request.title);
	send(event);
}

const broker = new DialogBroker(emit);
const services = new ServiceTracker({ file: join(triviumDir, "services.json"), emit: (list) => send({ type: "services", services: list }) });
const host = new SessionHost({
	emit,
	broker,
	indexFile: join(triviumDir, "session-apps.json"),
	settings,
	onDone: (path, title) => alert("done", path, title),
	thumbnail,
	services,
});

/** A preview at most 320×240, twice the size it shows at. JPEG keeps it small; PNG keeps transparency. */
function thumbnail(data: string, mimeType: string): string | undefined {
	const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
	if (image.isEmpty()) return undefined;
	const { width, height } = image.getSize();
	const scale = Math.min(1, 320 / width, 240 / height);
	const small = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" });
	return mimeType === "image/jpeg" ? `data:image/jpeg;base64,${small.toJPEG(82).toString("base64")}` : small.toDataURL();
}
const attachments = new AttachmentStore();
const reader = new ReaderStore((id) => send({ type: "reader_changed", id }));
const usage = new UsageCounter(join(triviumDir, "usage-cache.json"));
const connectors = new ConnectorStore(getAgentDir(), (url) => void shell.openExternal(url));
// The Memory page decides what loads, what is recalled and what counts as a secret with @pify/memory's own code.
const memory = new MemoryStore(getAgentDir(), { secrets: (text) => scanForSecrets(text), recall: (lessons) => recallLessons(lessons) }, async () => [
	...new Set((await host.listSessions()).flatMap((session) => (session.cwd ? [session.cwd] : []))),
]);
const updater = new Updater({
	version: app.getVersion(),
	platform: process.platform,
	arch: process.arch,
	execPath: process.execPath,
	// A renamed development runtime reports isPackaged=true, but runs the project from source.
	packaged: app.isPackaged && !process.defaultApp,
	portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
	dir: join(triviumDir, "update"),
	// Electron's fetch goes through the system's proxy settings.
	fetch: (url, init) => net.fetch(url, init),
	emit: (update) => send({ type: "update", update }),
	enabled: () => settings.get().checkUpdates,
	confirmQuit: async () => stopConfirmed || !services.count() || confirmStop(),
	quit: () => app.quit(),
});
// pi's login flow asks the host for this installation's device ID.
const loginSettings = SettingsManager.create(homedir(), getAgentDir());
const login = new LoginFlow(
	(event) => send({ type: "login", event }),
	(url) => void shell.openExternal(url),
	() => loginSettings.getOrCreateDeviceId(),
);

/** Only the app's own page may call into the main process. */
function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
	ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
		if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page) {
			throw new Error("Untrusted request.");
		}
		return fn(...(args as T));
	});
}

function setAppIcon(id: AppId): void {
	if (!APP_IDS.includes(id)) throw new Error("Invalid app.");
	const icon = join(assets, appIconFilename(id, process.platform === "win32" ? "ico" : "png"));
	if (process.platform === "darwin") app.dock?.setIcon(icon);
	else window?.setIcon(icon);
	if (process.platform === "win32") {
		window?.setAppDetails({
			appId: APP_USER_MODEL_ID,
			appIconPath: icon,
			appIconIndex: 0,
			// A renamed development runtime reports isPackaged=true, but still needs the project argument.
			relaunchCommand: process.defaultApp ? `"${process.execPath}" "${app.getAppPath()}"` : `"${process.execPath}"`,
			relaunchDisplayName: "Trivium",
		});
	}
}

function registerIpc(): void {
	handle("trivium:setWindowIcon", setAppIcon);
	handle("trivium:setWindowChrome", (color: string) => {
		if (process.platform !== "win32") return;
		if (typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color)) throw new Error("Invalid window color.");
		window?.setBackgroundColor(color);
	});
	handle("trivium:windowMinimize", () => window?.minimize());
	handle("trivium:windowToggleMaximize", () => {
		if (!window) return false;
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
		return window.isMaximized();
	});
	handle("trivium:windowClose", () => window?.close());
	handle("trivium:windowIsMaximized", () => window?.isMaximized() ?? false);
	handle("trivium:listSessions", () => host.listSessions());
	handle("trivium:listModels", () => host.listModels());
	handle("trivium:profiles", () => APP_IDS.map((id: AppId) => profileInfo(id)));
	handle("trivium:recentProjects", () => host.recentProjects());
	handle("trivium:pickFolder", async () => {
		const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory", "createDirectory"] });
		return result.canceled ? undefined : result.filePaths[0];
	});
	handle("trivium:openSession", (path: string) => host.openSession(path));
	handle("trivium:newSession", (input: NewSessionInput) => host.newSession(input));
	// A forked message comes back with its attachments stored again, so it can be sent as it was.
	const draftOf = (rewound: Rewound | undefined) =>
		rewound && { view: rewound.view, draft: { text: rewound.prompt, attachments: attachments.fromMessage(rewound.files) } };
	handle("trivium:editMessage", (path: string, run: number, text: string) => host.editMessage(path, run, text));
	handle("trivium:fork", async (path: string, run: number) => draftOf(await host.fork(path, run)));
	handle("trivium:send", async (path: string, text: string, mode: "prompt" | "steer" | "followUp", ids?: string[]) => {
		await host.send(path, text, mode, ids?.length ? attachments.build(ids) : undefined);
		if (ids?.length) attachments.drop(ids);
	});
	handle("trivium:pickAttachments", async () => {
		const result = await dialog.showOpenDialog(window!, { title: t("Attach files"), properties: ["openFile", "multiSelections"] });
		return result.canceled ? [] : attachments.fromPaths(result.filePaths);
	});
	handle("trivium:attachPaths", (paths: string[]) => attachments.fromPaths(paths));
	handle("trivium:attachImageData", (name: string, mimeType: string, base64: string) =>
		attachments.fromImageData(name, mimeType, base64),
	);
	handle("trivium:dropAttachments", (ids: string[]) => attachments.drop(ids));
	handle("trivium:answerTrust", (id: string, choice: TrustChoice) => host.answerTrust(id, choice));
	handle("trivium:abort", (path: string) => host.abort(path));
	handle("trivium:commands", (path: string) => host.commands(path));
	handle("trivium:completeCommand", (path: string, name: string, prefix: string) => host.completeCommand(path, name, prefix));
	handle("trivium:setModel", (path: string, key: string, level: string) => host.setModel(path, key, level));
	handle("trivium:answerDialog", (id: string, answer: DialogAnswer) => broker.answer(id, answer));
	handle("trivium:keepChanges", (path: string, files?: string[]) => host.keepChanges(path, files));
	handle("trivium:revertChanges", (path: string, files?: string[]) => host.revertChanges(path, files));
	handle("trivium:getSettings", () => settings.get());
	handle("trivium:updateSettings", async (patch: Partial<TriviumSettings>) => {
		const next = await settings.update(patch);
		if (patch.textSize) window?.webContents.setZoomFactor(next.textSize);
		if (patch.language) {
			applyLanguage();
			setMenu();
		}
		return next;
	});
	handle("trivium:appDetails", (id: AppId) => host.describeApp(id));
	handle("trivium:addExtension", async (id: AppId) => {
		const result = await dialog.showOpenDialog(window!, {
			title: t("Add an extension"),
			properties: ["openFile", "openDirectory"],
			filters: [{ name: "Extensions", extensions: ["ts", "js", "mjs"] }],
		});
		const path = result.canceled ? undefined : result.filePaths[0];
		if (!path) return undefined;
		const current = settings.app(id);
		if (!current.added.includes(path)) {
			await settings.update({ apps: { ...settings.get().apps, [id]: { ...current, added: [...current.added, path] } } });
		}
		return host.describeApp(id);
	});
	handle("trivium:installPackage", async (id: AppId, source: string) => {
		await host.installPackage(packageSource(source));
		return host.describeApp(id);
	});
	handle("trivium:setPermissionLevel", async (id: AppId, level: string) => {
		await writePermissionLevel(getAgentDir(), level);
		return host.describeApp(id);
	});
	handle("trivium:setSessionPermissions", (level: string) => writePermissionLevel(getAgentDir(), level));
	handle("trivium:reloadApp", (id: AppId) => host.reloadApp(id));
	handle("trivium:exportSession", async (path: string) => {
		const info = host.exportInfo(path);
		const result = await dialog.showSaveDialog(window!, {
			title: t("Export session"),
			defaultPath: join(app.getPath("downloads"), `${exportFileName(info.title)}.md`),
			filters: [
				{ name: "Markdown", extensions: ["md"] },
				{ name: "pi session file", extensions: ["jsonl"] },
			],
		});
		if (result.canceled || !result.filePath) return undefined;
		// The session file itself, which pi can open again, or a readable copy of the conversation.
		if (/\.jsonl$/i.test(result.filePath)) await copyFile(path, result.filePath);
		else await writeFile(result.filePath, sessionMarkdown(info));
		return result.filePath;
	});
	handle("trivium:copyText", (text: string) => clipboard.writeText(text));
	handle("trivium:deleteSessions", (paths: string[]) => host.deleteSessions(paths, (path) => shell.trashItem(path)));
	handle("trivium:providers", () =>
		listProviders(host.runtime, new Set(readCustomProviders(getAgentDir()).map((provider) => provider.id)), isBuiltIn),
	);
	handle("trivium:login", (providerId: string, type: "api_key" | "oauth") => {
		// The flow reports progress through events; the call returns at once.
		void login.start(host.runtime, providerId, type);
	});
	handle("trivium:answerLogin", (id: string, value: string | undefined) => login.answer(id, value));
	handle("trivium:logout", (providerId: string) => host.runtime.logout(providerId));
	handle("trivium:customProviders", () => readCustomProviders(getAgentDir()));
	handle("trivium:fetchModels", (endpoint: Pick<CustomProvider, "baseUrl" | "api" | "apiKey">) => fetchModels(endpoint));
	// pi reads models.json again on refresh; network catalogs stay as they are.
	handle("trivium:saveCustomProvider", async (provider: CustomProvider, previousId?: string) => {
		await saveCustomProvider(getAgentDir(), provider, previousId);
		await host.runtime.refresh({ allowNetwork: false });
		return readCustomProviders(getAgentDir());
	});
	handle("trivium:removeCustomProvider", async (id: string) => {
		await removeCustomProvider(getAgentDir(), id);
		await host.runtime.refresh({ allowNetwork: false });
		return readCustomProviders(getAgentDir());
	});
	handle("trivium:connectors", () => connectors.view());
	handle("trivium:checkConnectors", () => connectors.check());
	handle("trivium:saveConnector", (input: ConnectorInput, previousName?: string) => connectors.save(input, previousName));
	handle("trivium:importConnectors", (json: string, name?: string) => connectors.import(json, name));
	handle("trivium:removeConnector", (name: string) => connectors.remove(name));
	handle("trivium:setConnector", (name: string, patch: { enabled?: boolean; exposure?: McpExposure }) => connectors.set(name, patch));
	handle("trivium:setToolExposure", (name: string, tool: string, exposure: McpExposure) => connectors.setToolExposure(name, tool, exposure));
	handle("trivium:signInConnector", (name: string) => connectors.signIn(name));
	handle("trivium:signOutConnector", (name: string) => connectors.signOut(name));
	handle("trivium:presetProvider", (id: string) => {
		const { mainApi: _mainApi, ...preset } = readPresetProvider(getAgentDir(), host.runtime, id);
		const prefix = `${id}/`;
		const hidden = settings.get().hiddenModels.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
		return { ...preset, hidden };
	});
	handle("trivium:fetchPresetModels", (id: string, baseUrl: string) => fetchPresetModels(getAgentDir(), host.runtime, id, baseUrl));
	handle("trivium:savePresetProvider", async (id: string, changes: PresetProviderChanges) => {
		await savePresetProvider(getAgentDir(), host.runtime, id, changes);
		const prefix = `${id}/`;
		const others = settings.get().hiddenModels.filter((key) => !key.startsWith(prefix));
		await settings.update({ hiddenModels: [...others, ...changes.hidden.map((model) => prefix + model)] });
		await host.runtime.refresh({ allowNetwork: false });
	});
	handle("trivium:setDefaultModel", async (key: string, level: string) => {
		const slash = key.indexOf("/");
		const manager = SettingsManager.create(homedir(), getAgentDir());
		manager.setDefaultModelAndProvider(key.slice(0, slash), key.slice(slash + 1));
		manager.setDefaultThinkingLevel(level as Parameters<SettingsManager["setDefaultThinkingLevel"]>[0]);
		await manager.flush();
	});
	handle("trivium:appInfo", () => {
		const manager = SettingsManager.create(homedir(), getAgentDir());
		const provider = manager.getDefaultProvider();
		const model = manager.getDefaultModel();
		return {
			version: app.getVersion(),
			piVersion: VERSION,
			electron: process.versions.electron,
			node: process.versions.node,
			agentDir: getAgentDir(),
			sessionsDir: join(getAgentDir(), "sessions"),
			triviumDir,
			defaultModel: provider && model ? `${provider}/${model}` : undefined,
			defaultThinkingLevel: manager.getDefaultThinkingLevel(),
		};
	});
	handle("trivium:updateStatus", () => updater.get());
	handle("trivium:checkForUpdates", () => updater.check());
	handle("trivium:installUpdate", () => updater.install());
	handle("trivium:openPath", async (path: string) => {
		mkdirSync(path, { recursive: true });
		const error = await shell.openPath(path);
		if (error) throw new Error(error);
	});
	handle("trivium:memoryOverview", () => memory.overview());
	handle("trivium:memoryFile", (target: MemoryTarget) => memory.file(target));
	handle("trivium:memoryDays", () => memory.days());
	handle("trivium:memoryDeleted", () => memory.deleted());
	handle("trivium:memoryAdd", (target: MemoryTarget, category: MemoryCategory | undefined, text: string) => memory.add(target, category, text));
	handle("trivium:memoryEdit", (target: MemoryTarget, entry: MemoryEntryRef, category: MemoryCategory | undefined, text: string) =>
		memory.edit(target, entry, category, text),
	);
	handle("trivium:memoryDelete", (target: MemoryTarget, entry: MemoryEntryRef) => memory.delete(target, entry));
	handle("trivium:memoryMoveToTop", (target: MemoryTarget, entry: MemoryEntryRef) => memory.moveToTop(target, entry));
	handle("trivium:memoryRestore", (id: string) => memory.restore(id));
	handle("trivium:setMemoryConsent", (cwd: string, allowed: boolean) => memory.setConsent(cwd, allowed));
	handle("trivium:keepMemoryLocal", (cwd: string) => memory.keepLocal(cwd));
	handle("trivium:usage", async () => usage.report(await host.listSessions(), (provider) => host.runtime.isUsingOAuth(provider)));
	handle("trivium:openFile", async (file: string) => {
		const error = await shell.openPath(file);
		if (error) throw new Error(error);
	});
	handle("trivium:readChangedFile", (path: string, file: string) => host.readChangedFile(path, file));
	handle("trivium:openReader", async (path: string, file: string) => {
		const target = await host.previewTarget(path, file);
		return reader.open(target.file, target.root, target.rel);
	});
	handle("trivium:pickReaderFile", async (path: string) => {
		const result = await dialog.showOpenDialog(window!, { title: t("Preview a file"), defaultPath: host.cwdOf(path), properties: ["openFile"] });
		const file = result.filePaths[0];
		if (result.canceled || !file) return undefined;
		// A file the user picked may come from anywhere; its page loads only from its own folder.
		const target = await host.previewTarget(path, file).catch(() => ({ file, root: dirname(file), rel: file }));
		return reader.open(target.file, target.root, target.rel);
	});
	handle("trivium:reloadReader", (id: string) => reader.reload(id));
	handle("trivium:setReaderScripts", (id: string, on: boolean) => reader.setScripts(id, Boolean(on)));
	handle("trivium:closeReader", (id: string) => reader.close(id));
	handle("trivium:imageData", (path: string, id: string) => {
		const image = host.image(path, id);
		return `data:${image.mimeType};base64,${image.data}`;
	});
	handle("trivium:saveImage", async (path: string, id: string, name: string) => {
		const image = host.image(path, id);
		const result = await dialog.showSaveDialog(window!, { title: t("Save image"), defaultPath: join(app.getPath("downloads"), basename(name)) });
		if (result.canceled || !result.filePath) return false;
		await writeFile(result.filePath, Buffer.from(image.data, "base64"));
		return true;
	});
	handle("trivium:reviewFile", (path: string, file: string) => host.reviewFile(path, file));
	handle(
		"trivium:resolveChange",
		(path: string, file: string, id: number, action: "accept" | "reject", expect: { del: string; ins: string }) =>
			host.resolveChange(path, file, id, action, expect),
	);
	handle("trivium:gitStatus", (path: string) => host.gitStatus(path));
	handle("trivium:services", () => services.list());
	handle("trivium:stopService", (id: string) => services.stop(id));
	handle("trivium:openExternal", async (url: string) => {
		if (!/^https?:\/\//i.test(url)) throw new Error("Only web addresses open in the browser.");
		await shell.openExternal(url);
	});
	handle("trivium:gitDiff", (path: string, file: Pick<GitFile, "rel" | "area">) => host.gitDiff(path, file));
	handle("trivium:openInEditor", async (file: string, line?: number) => {
		// VS Code's URL handler opens the file at a line; fall back to the system default app.
		const url = `vscode://file${encodeURI(file)}${line ? `:${line}` : ""}`;
		try {
			await shell.openExternal(url);
		} catch {
			const error = await shell.openPath(file);
			if (error) throw new Error(error);
		}
	});
}

/** Development aid: `npm run dev` rebuilds into dist; reload the page, or swap only the stylesheet when that is all that changed. */
function reloadOnRebuild(target: BrowserWindow): void {
	const changed = new Set<string>();
	let timer: NodeJS.Timeout | undefined;
	const watcher = watch(assets, (_event, file) => {
		if (!file || !["renderer.js", "preload.cjs", "index.html", "styles.css"].includes(file)) return;
		changed.add(file);
		// One save can write a file several times; act once it settles.
		clearTimeout(timer);
		timer = setTimeout(() => {
			const styleOnly = [...changed].every((name) => name === "styles.css");
			changed.clear();
			if (target.isDestroyed()) return;
			console.log(styleOnly ? "[dev] updated styles" : "[dev] reloaded window");
			if (styleOnly) {
				void target.webContents
					.executeJavaScript(`document.querySelector('link[href^="styles.css"]').href = "styles.css?" + Date.now()`)
					.catch(console.error);
			} else {
				target.webContents.reloadIgnoringCache();
			}
		}, 150);
	});
	target.on("closed", () => watcher.close());
}

function createWindow(): void {
	window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 900,
		minHeight: 600,
		backgroundColor: "#EEEFFA",
		icon: join(assets, appIconFilename("code", process.platform === "win32" ? "ico" : "png")),
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		...(process.platform === "win32" ? {
			frame: false,
			autoHideMenuBar: true,
		} : {}),
		trafficLightPosition: { x: 16, y: 18 },
		show: false,
		webPreferences: {
			preload: join(assets, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	setAppIcon("code");
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== page) event.preventDefault();
	});
	// A previewed page stays on Trivium's files, whose random tokens it cannot guess, or on a local service's
	// pages; other web links open in the browser.
	window.webContents.on("will-frame-navigate", (event) => {
		if (event.isMainFrame || event.url.startsWith(`${READER_SCHEME}://`) || isLocalPage(event.url)) return;
		event.preventDefault();
		if (/^https?:/.test(event.url)) void shell.openExternal(event.url);
	});
	window.once("ready-to-show", () => window?.show());
	// Closing the window quits on Windows and Linux; say first that the services will stop.
	window.on("close", (event) => {
		if (process.platform === "darwin" || stopConfirmed || !services.count()) return;
		event.preventDefault();
		void confirmStop().then((ok) => ok && window?.close());
	});
	// The custom title bar's maximize button reflects the window state.
	window.on("maximize", () => window?.webContents.send("trivium:maximize-changed", true));
	window.on("unmaximize", () => window?.webContents.send("trivium:maximize-changed", false));
	window.webContents.on("did-finish-load", () => window?.webContents.setZoomFactor(settings.get().textSize));
	// Development aid: TRIVIUM_CAPTURE=/path/shot.png saves a screenshot after the first render.
	const capture = process.env.TRIVIUM_CAPTURE;
	if (capture) {
		window.webContents.on("console-message", (event) => console.log(`[page] ${event.message}`));
		window.webContents.once("did-finish-load", () => {
			// TRIVIUM_EVAL runs a script in the page first, to put the UI into the state being checked.
			if (process.env.TRIVIUM_EVAL) void window?.webContents.executeJavaScript(process.env.TRIVIUM_EVAL).catch(console.error);
			setTimeout(async () => {
				const image = await window?.webContents.capturePage();
				if (image) writeFileSync(capture, image.toPNG());
				// The page capture leaves out the native window buttons; tests capture this rectangle of the screen.
				const bounds = window?.getBounds();
				if (bounds) console.log(`[bounds] ${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
			}, Number(process.env.TRIVIUM_CAPTURE_DELAY ?? 3000));
		});
	}
	if (process.env.TRIVIUM_DEV) reloadOnRebuild(window);
	void window.loadURL(page);
	window.on("closed", () => {
		window = undefined;
	});
}

/** Electron names the role menus in the system's language; the one Trivium names follows the setting. */
function setMenu(): void {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: "appMenu" },
			{ role: "editMenu" },
			{ label: t("View"), submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
			{ role: "windowMenu" },
		]),
	);
}

app.whenReady().then(async () => {
	applyLanguage();
	if (process.platform === "win32") {
		try {
			const portableLauncher = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_FILE : undefined;
			const repaired = registerWindowsShortcuts(shell, {
				appData: app.getPath("appData"),
				appPath: portableLauncher ? dirname(portableLauncher) : app.getAppPath(),
				// A portable build extracts its runtime to a temporary directory on each launch.
				// Shortcuts must point to the durable launcher and its embedded icon instead.
				executable: portableLauncher ?? process.execPath,
				icon: portableLauncher ?? join(assets, appIconFilename("code", "ico")),
				packaged: !process.defaultApp && app.isPackaged,
			});
			if (repaired.length) await refreshWindowsIcons();
		} catch (error) {
			console.error("Could not refresh Windows application branding:", error);
		}
	}
	setMenu();
	await host.init();
	// Services a crash left running show again in their sessions.
	void services.init().catch((error: unknown) => console.error("Could not check for services left running:", error));
	protocol.handle(READER_SCHEME, (request) => reader.respond(request));
	registerIpc();
	createWindow();
	void updater.start().catch((error: unknown) => console.error("Could not start the update check:", error));
	app.on("activate", () => {
		if (!window) createWindow();
	});
});

/** A page a local service serves, which the Preview panel may show. */
function isLocalPage(url: string): boolean {
	return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)(:\d+)?(\/|$)/i.test(url);
}

/** Set once the user agreed to stop the services, or there were none, so quitting goes ahead. */
let stopConfirmed = false;

/**
 * Asks before quitting while sessions' services run, then stops them all: they would otherwise run on with
 * nothing in Trivium to show or stop them.
 */
async function confirmStop(): Promise<boolean> {
	const count = services.count();
	const options = {
		type: "question" as const,
		buttons: [t("Stop and quit"), t("Cancel")],
		defaultId: 0,
		cancelId: 1,
		message: count === 1 ? t("A service started by Trivium is still running") : t("{n} services started by Trivium are still running", { n: count }),
		detail: t("Quitting stops them, such as dev servers and watchers your sessions started. To keep one, run it yourself outside Trivium."),
	};
	const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
	if (response !== 0) return false;
	stopConfirmed = true;
	await services.stopAll().catch(() => {});
	return true;
}

app.on("before-quit", (event) => {
	if (stopConfirmed || !services.count()) return;
	event.preventDefault();
	void confirmStop().then((ok) => ok && app.quit());
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// Cleanup is synchronous, so it runs here without holding up the quit.
app.on("will-quit", () => {
	host.dispose();
	updater.dispose();
	// Whatever is left, such as a service that started while the question was open.
	services.dispose();
	reader.dispose();
});
