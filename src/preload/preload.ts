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
	setVisible: call("setVisible") as TriviumApi["setVisible"],
	newSession: call("newSession") as TriviumApi["newSession"],
	editMessage: call("editMessage") as TriviumApi["editMessage"],
	fork: call("fork") as TriviumApi["fork"],
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
	setModel: call("setModel") as TriviumApi["setModel"],
	answerDialog: call("answerDialog") as TriviumApi["answerDialog"],
	keepChanges: call("keepChanges") as TriviumApi["keepChanges"],
	revertChanges: call("revertChanges") as TriviumApi["revertChanges"],
	gitStatus: call("gitStatus") as TriviumApi["gitStatus"],
	gitDiff: call("gitDiff") as TriviumApi["gitDiff"],
	openInEditor: call("openInEditor") as TriviumApi["openInEditor"],
	services: call("services") as TriviumApi["services"],
	stopService: call("stopService") as TriviumApi["stopService"],
	openExternal: call("openExternal") as TriviumApi["openExternal"],
	openFile: call("openFile") as TriviumApi["openFile"],
	readChangedFile: call("readChangedFile") as TriviumApi["readChangedFile"],
	openReader: call("openReader") as TriviumApi["openReader"],
	pickReaderFile: call("pickReaderFile") as TriviumApi["pickReaderFile"],
	reloadReader: call("reloadReader") as TriviumApi["reloadReader"],
	setReaderScripts: call("setReaderScripts") as TriviumApi["setReaderScripts"],
	closeReader: call("closeReader") as TriviumApi["closeReader"],
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
	setSessionPermissions: call("setSessionPermissions") as TriviumApi["setSessionPermissions"],
	reloadApp: call("reloadApp") as TriviumApi["reloadApp"],
	providers: call("providers") as TriviumApi["providers"],
	login: call("login") as TriviumApi["login"],
	answerLogin: call("answerLogin") as TriviumApi["answerLogin"],
	logout: call("logout") as TriviumApi["logout"],
	customProviders: call("customProviders") as TriviumApi["customProviders"],
	fetchModels: call("fetchModels") as TriviumApi["fetchModels"],
	saveCustomProvider: call("saveCustomProvider") as TriviumApi["saveCustomProvider"],
	removeCustomProvider: call("removeCustomProvider") as TriviumApi["removeCustomProvider"],
	presetProvider: call("presetProvider") as TriviumApi["presetProvider"],
	fetchPresetModels: call("fetchPresetModels") as TriviumApi["fetchPresetModels"],
	savePresetProvider: call("savePresetProvider") as TriviumApi["savePresetProvider"],
	setDefaultModel: call("setDefaultModel") as TriviumApi["setDefaultModel"],
	connectors: call("connectors") as TriviumApi["connectors"],
	checkConnectors: call("checkConnectors") as TriviumApi["checkConnectors"],
	saveConnector: call("saveConnector") as TriviumApi["saveConnector"],
	importConnectors: call("importConnectors") as TriviumApi["importConnectors"],
	removeConnector: call("removeConnector") as TriviumApi["removeConnector"],
	setConnector: call("setConnector") as TriviumApi["setConnector"],
	setToolExposure: call("setToolExposure") as TriviumApi["setToolExposure"],
	signInConnector: call("signInConnector") as TriviumApi["signInConnector"],
	signOutConnector: call("signOutConnector") as TriviumApi["signOutConnector"],
	appInfo: call("appInfo") as TriviumApi["appInfo"],
	updateStatus: call("updateStatus") as TriviumApi["updateStatus"],
	checkForUpdates: call("checkForUpdates") as TriviumApi["checkForUpdates"],
	installUpdate: call("installUpdate") as TriviumApi["installUpdate"],
	openPath: call("openPath") as TriviumApi["openPath"],
	memoryOverview: call("memoryOverview") as TriviumApi["memoryOverview"],
	memoryFile: call("memoryFile") as TriviumApi["memoryFile"],
	memoryDays: call("memoryDays") as TriviumApi["memoryDays"],
	memoryDeleted: call("memoryDeleted") as TriviumApi["memoryDeleted"],
	memoryAdd: call("memoryAdd") as TriviumApi["memoryAdd"],
	memoryEdit: call("memoryEdit") as TriviumApi["memoryEdit"],
	memoryDelete: call("memoryDelete") as TriviumApi["memoryDelete"],
	memoryMoveToTop: call("memoryMoveToTop") as TriviumApi["memoryMoveToTop"],
	memoryRestore: call("memoryRestore") as TriviumApi["memoryRestore"],
	setMemoryConsent: call("setMemoryConsent") as TriviumApi["setMemoryConsent"],
	keepMemoryLocal: call("keepMemoryLocal") as TriviumApi["keepMemoryLocal"],
	usage: call("usage") as TriviumApi["usage"],
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
