import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, Menu, Notification, shell } from "electron";
import type { AppId, TriviumSettings, DialogAnswer, HostEvent, NewSessionInput } from "../shared/protocol.ts";
import { APP_IDS } from "../shared/protocol.ts";
import { triviumDir, profileInfo } from "./apps.ts";
import { LoginFlow, listProviders } from "./auth.ts";
import { DialogBroker } from "./dialogs.ts";
import { SessionHost } from "./host.ts";
import { SettingsStore } from "./settings.ts";

const assets = fileURLToPath(new URL("./", import.meta.url));
const page = pathToFileURL(join(assets, "index.html")).href;
let window: BrowserWindow | undefined;

mkdirSync(triviumDir, { recursive: true });
const settings = new SettingsStore(join(triviumDir, "settings.json"));

function send(event: HostEvent): void {
	if (window && !window.isDestroyed()) window.webContents.send("trivium:event", event);
}

/** A system notification, only while the window is in the background. Clicking it opens the session. */
function alert(kind: "done" | "waiting", path: string, body: string): void {
	const prefs = settings.get();
	if ((kind === "done" ? !prefs.notifyDone : !prefs.notifyWaiting) || !Notification.isSupported()) return;
	if (window?.isFocused()) return;
	const notification = new Notification({ title: kind === "done" ? "Run finished" : "Waiting for your answer", body });
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
const host = new SessionHost({
	emit,
	broker,
	indexFile: join(triviumDir, "session-apps.json"),
	settings,
	onDone: (path, title) => alert("done", path, title),
});
const login = new LoginFlow(
	(event) => send({ type: "login", event }),
	(url) => void shell.openExternal(url),
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

function registerIpc(): void {
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
	handle("trivium:send", (path: string, text: string, mode: "prompt" | "steer" | "followUp") =>
		host.send(path, text, mode),
	);
	handle("trivium:abort", (path: string) => host.abort(path));
	handle("trivium:clearQueue", (path: string) => host.clearQueue(path));
	handle("trivium:setModel", (path: string, key: string, level: string) => host.setModel(path, key, level));
	handle("trivium:answerDialog", (id: string, answer: DialogAnswer) => broker.answer(id, answer));
	handle("trivium:keepChanges", (path: string, files?: string[]) => host.keepChanges(path, files));
	handle("trivium:revertChanges", (path: string, files?: string[]) => host.revertChanges(path, files));
	handle("trivium:getSettings", () => settings.get());
	handle("trivium:updateSettings", async (patch: Partial<TriviumSettings>) => {
		const next = await settings.update(patch);
		if (patch.textSize) window?.webContents.setZoomFactor(next.textSize);
		return next;
	});
	handle("trivium:appDetails", (id: AppId) => host.describeApp(id));
	handle("trivium:addExtension", async (id: AppId) => {
		const result = await dialog.showOpenDialog(window!, {
			title: "Add an extension",
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
	handle("trivium:reloadApp", (id: AppId) => host.reloadApp(id));
	handle("trivium:deleteSessions", (paths: string[]) => host.deleteSessions(paths, (path) => shell.trashItem(path)));
	handle("trivium:providers", () => listProviders(host.runtime));
	handle("trivium:login", (providerId: string, type: "api_key" | "oauth") => {
		// The flow reports progress through events; the call returns at once.
		void login.start(host.runtime, providerId, type);
	});
	handle("trivium:answerLogin", (id: string, value: string | undefined) => login.answer(id, value));
	handle("trivium:logout", (providerId: string) => host.runtime.logout(providerId));
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
	handle("trivium:openPath", async (path: string) => {
		mkdirSync(path, { recursive: true });
		const error = await shell.openPath(path);
		if (error) throw new Error(error);
	});
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

function createWindow(): void {
	window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 900,
		minHeight: 600,
		backgroundColor: "#EEEFFA",
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
		trafficLightPosition: { x: 16, y: 18 },
		show: false,
		webPreferences: {
			preload: join(assets, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== page) event.preventDefault();
	});
	window.once("ready-to-show", () => window?.show());
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
			}, Number(process.env.TRIVIUM_CAPTURE_DELAY ?? 3000));
		});
	}
	void window.loadURL(page);
	window.on("closed", () => {
		window = undefined;
	});
}

app.whenReady().then(async () => {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: "appMenu" },
			{ role: "editMenu" },
			{ label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
			{ role: "windowMenu" },
		]),
	);
	await host.init();
	registerIpc();
	createWindow();
	app.on("activate", () => {
		if (!window) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// Cleanup is synchronous, so it runs here without holding up the quit.
app.on("will-quit", () => host.dispose());
