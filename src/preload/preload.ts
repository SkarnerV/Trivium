import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { TriviumApi, HostEvent } from "../shared/protocol.ts";

const call =
	(channel: string) =>
	(...args: unknown[]) =>
		ipcRenderer.invoke(`trivium:${channel}`, ...args);

const api: TriviumApi = {
	setWindowIcon: call("setWindowIcon") as TriviumApi["setWindowIcon"],
	setWindowChrome: call("setWindowChrome") as TriviumApi["setWindowChrome"],
	windowMinimize: call("windowMinimize") as TriviumApi["windowMinimize"],
	windowToggleMaximize: call("windowToggleMaximize") as TriviumApi["windowToggleMaximize"],
	windowClose: call("windowClose") as TriviumApi["windowClose"],
	windowIsMaximized: call("windowIsMaximized") as TriviumApi["windowIsMaximized"],
	listSessions: call("listSessions") as TriviumApi["listSessions"],
	listModels: call("listModels") as TriviumApi["listModels"],
	profiles: call("profiles") as TriviumApi["profiles"],
	recentProjects: call("recentProjects") as TriviumApi["recentProjects"],
	pickFolder: call("pickFolder") as TriviumApi["pickFolder"],
	openSession: call("openSession") as TriviumApi["openSession"],
	newSession: call("newSession") as TriviumApi["newSession"],
	deleteSessions: call("deleteSessions") as TriviumApi["deleteSessions"],
	pickAttachments: call("pickAttachments") as TriviumApi["pickAttachments"],
	attachPaths: call("attachPaths") as TriviumApi["attachPaths"],
	attachImageData: call("attachImageData") as TriviumApi["attachImageData"],
	dropAttachments: call("dropAttachments") as TriviumApi["dropAttachments"],
	answerTrust: call("answerTrust") as TriviumApi["answerTrust"],
	pathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	send: call("send") as TriviumApi["send"],
	abort: call("abort") as TriviumApi["abort"],
	commands: call("commands") as TriviumApi["commands"],
	completeCommand: call("completeCommand") as TriviumApi["completeCommand"],
	clearQueue: call("clearQueue") as TriviumApi["clearQueue"],
	setModel: call("setModel") as TriviumApi["setModel"],
	answerDialog: call("answerDialog") as TriviumApi["answerDialog"],
	keepChanges: call("keepChanges") as TriviumApi["keepChanges"],
	revertChanges: call("revertChanges") as TriviumApi["revertChanges"],
	openInEditor: call("openInEditor") as TriviumApi["openInEditor"],
	openFile: call("openFile") as TriviumApi["openFile"],
	readChangedFile: call("readChangedFile") as TriviumApi["readChangedFile"],
	imageData: call("imageData") as TriviumApi["imageData"],
	saveImage: call("saveImage") as TriviumApi["saveImage"],
	reviewFile: call("reviewFile") as TriviumApi["reviewFile"],
	resolveChange: call("resolveChange") as TriviumApi["resolveChange"],
	getSettings: call("getSettings") as TriviumApi["getSettings"],
	updateSettings: call("updateSettings") as TriviumApi["updateSettings"],
	appDetails: call("appDetails") as TriviumApi["appDetails"],
	addExtension: call("addExtension") as TriviumApi["addExtension"],
	installPackage: call("installPackage") as TriviumApi["installPackage"],
	exportSession: call("exportSession") as TriviumApi["exportSession"],
	copyText: call("copyText") as TriviumApi["copyText"],
	setPermissionLevel: call("setPermissionLevel") as TriviumApi["setPermissionLevel"],
	reloadApp: call("reloadApp") as TriviumApi["reloadApp"],
	providers: call("providers") as TriviumApi["providers"],
	login: call("login") as TriviumApi["login"],
	answerLogin: call("answerLogin") as TriviumApi["answerLogin"],
	logout: call("logout") as TriviumApi["logout"],
	customProviders: call("customProviders") as TriviumApi["customProviders"],
	fetchModels: call("fetchModels") as TriviumApi["fetchModels"],
	saveCustomProvider: call("saveCustomProvider") as TriviumApi["saveCustomProvider"],
	removeCustomProvider: call("removeCustomProvider") as TriviumApi["removeCustomProvider"],
	setDefaultModel: call("setDefaultModel") as TriviumApi["setDefaultModel"],
	appInfo: call("appInfo") as TriviumApi["appInfo"],
	openPath: call("openPath") as TriviumApi["openPath"],
	onEvent(listener) {
		const wrapped = (_event: unknown, payload: HostEvent) => listener(payload);
		ipcRenderer.on("trivium:event", wrapped);
		return () => ipcRenderer.removeListener("trivium:event", wrapped);
	},
	onWindowMaximized(listener) {
		const wrapped = (_event: unknown, maximized: boolean) => listener(maximized);
		ipcRenderer.on("trivium:maximize-changed", wrapped);
		return () => ipcRenderer.removeListener("trivium:maximize-changed", wrapped);
	},
};

contextBridge.exposeInMainWorld("trivium", api);
