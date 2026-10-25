import { contextBridge, ipcRenderer } from "electron";
import type { TriviumApi, HostEvent } from "../shared/protocol.ts";

const call =
	(channel: string) =>
	(...args: unknown[]) =>
		ipcRenderer.invoke(`trivium:${channel}`, ...args);

const api: TriviumApi = {
	listSessions: call("listSessions") as TriviumApi["listSessions"],
	listModels: call("listModels") as TriviumApi["listModels"],
	profiles: call("profiles") as TriviumApi["profiles"],
	recentProjects: call("recentProjects") as TriviumApi["recentProjects"],
	pickFolder: call("pickFolder") as TriviumApi["pickFolder"],
	openSession: call("openSession") as TriviumApi["openSession"],
	newSession: call("newSession") as TriviumApi["newSession"],
	deleteSessions: call("deleteSessions") as TriviumApi["deleteSessions"],
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
	getSettings: call("getSettings") as TriviumApi["getSettings"],
	updateSettings: call("updateSettings") as TriviumApi["updateSettings"],
	appDetails: call("appDetails") as TriviumApi["appDetails"],
	addExtension: call("addExtension") as TriviumApi["addExtension"],
	reloadApp: call("reloadApp") as TriviumApi["reloadApp"],
	providers: call("providers") as TriviumApi["providers"],
	login: call("login") as TriviumApi["login"],
	answerLogin: call("answerLogin") as TriviumApi["answerLogin"],
	logout: call("logout") as TriviumApi["logout"],
	setDefaultModel: call("setDefaultModel") as TriviumApi["setDefaultModel"],
	appInfo: call("appInfo") as TriviumApi["appInfo"],
	openPath: call("openPath") as TriviumApi["openPath"],
	onEvent(listener) {
		const wrapped = (_event: unknown, payload: HostEvent) => listener(payload);
		ipcRenderer.on("trivium:event", wrapped);
		return () => ipcRenderer.removeListener("trivium:event", wrapped);
	},
};

contextBridge.exposeInMainWorld("trivium", api);
