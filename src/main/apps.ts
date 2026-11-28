import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppId, AppProfileInfo } from "../shared/protocol.ts";

/**
 * Each app is a separate agent profile: its own tool set, an addition to the
 * system prompt, and extension and skill folders loaded on top of the shared ~/.pi/agent setup.
 */
interface AppProfile {
	id: AppId;
	/** Changes to pi's default tools as "+name" and "-name" entries. Undefined keeps the defaults. */
	tools?: string[];
	appendSystemPrompt?: string;
}

/**
 * The Launch button reads .vscode/tasks.json, in a narrow subset of VS Code's format that refuses anything else.
 * Code's model hears the subset, so a file it writes when asked to set up launching runs on the first try.
 */
const LAUNCH = [
	"Trivium's Launch button starts this project's app, after the Docker Compose infrastructure it needs, from .vscode/tasks.json. When the user asks to set up or fix launching, write that file in this subset of VS Code Tasks 2.0.0; Launch refuses anything else:",
	'- "version": "2.0.0" and a "tasks" list. No file-level command, args, options, type or windows/osx/linux. Comments and trailing commas are fine.',
	'- App task: unique "label", "type": "shell", a string "command" with no ${...} in it, optional "args" (each only letters, digits and _@%+=:,./-), optional "options" with only "cwd" and "env" (string values; ${workspaceFolder} is the only variable), optional windows/osx/linux blocks with command, args and options, and optional "dependsOn" naming exactly one docker-compose task.',
	'- Infrastructure task: "type": "docker-compose", "dockerCompose": { "files": [Compose files inside the project], "up": { "services": [...] or "profiles": [...], "build": true or false, "customOptions": "--wait" }, optional "envFile" }. No projectName, down, scale, "detached": false, options or dependsOn.',
	"- In the Compose file, give each service a healthcheck so Launch waits until it is ready, bind ports to 127.0.0.1, and keep data in named volumes. Keep secrets out of tasks.json: use an env file or ${VAR:?message} in the Compose file.",
	"Afterwards, tell the user to press Launch in the session header; it shows what will run and asks before running it. Don't start the app yourself for them to use.",
].join("\n");

const PROFILES: Record<AppId, AppProfile> = {
	code: { id: "code", appendSystemPrompt: LAUNCH },
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

/** Skills only this app loads. One wins over a skill of the same name from pi's own folders. */
export function skillDir(app: AppId): string {
	const dir = join(triviumDir, "apps", app, "skills");
	mkdirSync(dir, { recursive: true });
	return dir;
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

/** Every app's replies draw Mermaid blocks as diagrams, so each one's model hears it can use them. */
const DIAGRAMS = [
	"Replies are shown in Trivium, which draws a fenced ```mermaid code block as a diagram the user can zoom, open beside the chat and download.",
	"When a picture explains something better than prose, such as how parts connect, a flow or sequence of calls, a state machine, a timeline or a data model, include a Mermaid diagram with the explanation. Skip it for simple answers.",
	"Keep a diagram small and focused, and label nodes in plain words. Put a label in double quotes when it has punctuation such as parentheses, colons or slashes, use <br/> for a line break, and don't name a node `end`.",
].join("\n");

/**
 * What a model writes before a tool call stays in the conversation, between the steps it took. Models differ in
 * how much they say there, so each hears what the user sees: updates worth reading, and an answer that needs none of them.
 */
const PROGRESS = [
	"Text you write before a tool call is shown to the user in the conversation as you work, in the order you wrote it, with your tool calls folded away between.",
	"Use it for short progress updates: a sentence or two when you start a new part of the task, find something that matters, or change approach. Don't announce each tool call, and don't repeat what your last update said.",
	"Put the full result in your final reply, after your last tool call. It should stand on its own for someone who skipped the updates.",
].join("\n");

export function profileFor(app: AppId): AppProfile & { extensions: string[]; skillDir: string } {
	const profile = PROFILES[app];
	const appendSystemPrompt = [profile.appendSystemPrompt, PROGRESS, DIAGRAMS].filter(Boolean).join("\n\n");
	return { ...profile, appendSystemPrompt, extensions: extensionFiles(app), skillDir: skillDir(app) };
}

export function profileInfo(app: AppId): AppProfileInfo {
	const profile = profileFor(app);
	return {
		id: app,
		tools: resolveTools(profile.tools),
		extensionDir: extensionDir(app),
		extensions: profile.extensions,
		skillDir: profile.skillDir,
	};
}
