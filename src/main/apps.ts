import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppId, AppProfileInfo } from "../shared/protocol.ts";

/**
 * Each app is a separate agent profile: its own tool set, an addition to the
 * system prompt, and an extension folder loaded on top of the shared ~/.pi/agent setup.
 */
interface AppProfile {
	id: AppId;
	/** Changes to pi's default tools as "+name" and "-name" entries. Undefined keeps the defaults. */
	tools?: string[];
	appendSystemPrompt?: string;
}

const PROFILES: Record<AppId, AppProfile> = {
	code: { id: "code" },
	research: {
		id: "research",
		// "+" and "-" adjust pi's defaults instead of replacing them, so extension and MCP tools stay available.
		tools: ["-bash", "-edit", "+grep", "+find", "+ls"],
		appendSystemPrompt: [
			"You are working as a research assistant.",
			"Search and read sources before concluding. Cite every claim with the URL or file it came from.",
			"Write findings as Markdown notes under notes/ in the project when the user asks you to keep them.",
		].join("\n"),
	},
	write: {
		id: "write",
		tools: ["-bash", "+grep", "+find", "+ls"],
		appendSystemPrompt: [
			"You are working as a writing assistant for documents in this project.",
			"Keep the author's voice and the project's style guide. Prefer small, reviewable edits over rewrites.",
			"Before editing, say briefly what you will change and why.",
		].join("\n"),
	},
};

export const triviumDir = process.env.TRIVIUM_HOME ?? join(homedir(), ".trivium");

/** Where conversations started without a project run. pi gives every session a folder; this is theirs, shared. */
export const chatsDir = join(triviumDir, "chats");

function extensionDir(app: AppId): string {
	return join(triviumDir, "apps", app, "extensions");
}

function extensionFiles(app: AppId): string[] {
	const dir = extensionDir(app);
	mkdirSync(dir, { recursive: true });
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() || /\.(ts|js|mjs)$/.test(entry.name))
		.map((entry) => join(dir, entry.name));
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** The built-in tools a profile ends up with. Extension and MCP tools come on top. */
function resolveTools(changes: string[] | undefined): string[] {
	const tools = new Set(DEFAULT_TOOLS);
	for (const change of changes ?? []) {
		if (change.startsWith("-")) tools.delete(change.slice(1));
		else tools.add(change.replace(/^\+/, ""));
	}
	return [...tools];
}

export function profileFor(app: AppId): AppProfile & { extensions: string[] } {
	return { ...PROFILES[app], extensions: extensionFiles(app) };
}

export function profileInfo(app: AppId): AppProfileInfo {
	const profile = profileFor(app);
	return {
		id: app,
		tools: resolveTools(profile.tools),
		extensionDir: extensionDir(app),
		extensions: profile.extensions,
	};
}
