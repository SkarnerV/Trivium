import { contextBridge, ipcRenderer } from "electron";
import type { DeskApi, HostEvent } from "../shared/protocol.ts";

const call =
	(channel: string) =>
	(...args: unknown[]) =>
		ipcRenderer.invoke(`desk:${channel}`, ...args);

const api: DeskApi = {
	listSessions: call("listSessions") as DeskApi["listSessions"],
	listModels: call("listModels") as DeskApi["listModels"],
	profiles: call("profiles") as DeskApi["profiles"],
	recentProjects: call("recentProjects") as DeskApi["recentProjects"],
	pickFolder: call("pickFolder") as DeskApi["pickFolder"],
	openSession: call("openSession") as DeskApi["openSession"],
	newSession: call("newSession") as DeskApi["newSession"],
	send: call("send") as DeskApi["send"],
	abort: call("abort") as DeskApi["abort"],
	clearQueue: call("clearQueue") as DeskApi["clearQueue"],
	setModel: call("setModel") as DeskApi["setModel"],
	answerDialog: call("answerDialog") as DeskApi["answerDialog"],
	keepChanges: call("keepChanges") as DeskApi["keepChanges"],
	revertChanges: call("revertChanges") as DeskApi["revertChanges"],
	openInEditor: call("openInEditor") as DeskApi["openInEditor"],
	getSettings: call("getSettings") as DeskApi["getSettings"],
	updateSettings: call("updateSettings") as DeskApi["updateSettings"],
	appDetails: call("appDetails") as DeskApi["appDetails"],
	addExtension: call("addExtension") as DeskApi["addExtension"],
	reloadApp: call("reloadApp") as DeskApi["reloadApp"],
	providers: call("providers") as DeskApi["providers"],
	login: call("login") as DeskApi["login"],
	answerLogin: call("answerLogin") as DeskApi["answerLogin"],
	logout: call("logout") as DeskApi["logout"],
	setDefaultModel: call("setDefaultModel") as DeskApi["setDefaultModel"],
	appInfo: call("appInfo") as DeskApi["appInfo"],
	openPath: call("openPath") as DeskApi["openPath"],
	onEvent(listener) {
		const wrapped = (_event: unknown, payload: HostEvent) => listener(payload);
		ipcRenderer.on("desk:event", wrapped);
		return () => ipcRenderer.removeListener("desk:event", wrapped);
	},
};

contextBridge.exposeInMainWorld("desk", api);
