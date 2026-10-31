import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PermissionModeId } from "../shared/permissions.ts";
import { t } from "../shared/i18n.ts";
import { isInside } from "./reader.ts";

/**
 * Trivium's permission gate for Code, with the rules PERMISSION_MODES describes and nothing else. It reads the mode
 * on every call, so a change in the composer reaches sessions already running.
 */

export type Decision = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask"; title: string; remember: Remembered };

/** What "Allow for this session" approves from then on. */
export type Remembered =
	| { kind: "command"; prefix: string }
	| { kind: "edits" }
	| { kind: "outside"; dir: string };

const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** .env and .env.local, or a file named like config.env, but not .env.example. */
export function isEnvFile(path: string): boolean {
	const name = basename(path);
	return (/\.env$/.test(name) || /\.env\./.test(name)) && !/\.env\.example$/.test(name);
}

/**
 * A command naming a .env file. Only `.env` and `.env.*` count here, so code such as `process.env.HOME` in a
 * `node -e` script doesn't.
 */
export function namesEnvFile(command: string): boolean {
	return command
		.split(/[\s"'`;|&<>()=,]+/)
		.map((token) => token.split(/[\\/]/).pop() ?? "")
		.some((name) => (name === ".env" || name.startsWith(".env.")) && name !== ".env.example");
}

/** Commands that only read, whatever they are given. */
const READERS = new Set([
	"cat", "head", "tail", "less", "wc", "grep", "rg", "ls", "dir", "tree", "pwd", "cd", "echo", "printf", "which", "where",
	"type", "file", "stat", "du", "df", "diff", "cut", "uniq", "basename", "dirname", "realpath", "date", "whoami", "true",
]);
const GIT_READERS = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog"]);

/**
 * Whether a command only reads: each part of a pipe or chain is a reader, and nothing writes through a redirect,
 * substitutes another command or reaches a find action that changes files.
 */
export function onlyReads(command: string): boolean {
	const plain = command.replace(/\d?>&\d/g, "").replace(/\d?>\s*\/dev\/null/g, "");
	if (/[>`]|\$\(|<</.test(plain)) return false;
	return plain
		.split(/&&|\|\||[;|\n]/)
		.map((part) => part.trim().split(/\s+/))
		.every(([word = "", sub, ...rest]) => {
			if (!word) return true;
			if (word === "git") return GIT_READERS.has(sub ?? "");
			if (word === "find") return ![sub, ...rest].some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint)/.test(arg ?? ""));
			if (word === "sort") return ![sub, ...rest].some((arg) => arg === "-o" || arg?.startsWith("--output"));
			return READERS.has(word);
		});
}

/** What Approve for me asks about: removing folders, sudo and git push, wherever they sit in the command. */
export function isRisky(command: string): boolean {
	return /\brm\s+(?:-\S+\s+)*-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b/.test(command) || /\bsudo\b/.test(command) || /\bgit(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+push\b/.test(command);
}

/** The words "Allow for this session" approves: `git push`, `npm test`, or a lone `rm`. */
export function commandPrefix(command: string): string {
	const [word = "", next] = command.trim().split(/\s+/);
	return next && /^[a-z][\w:-]*$/.test(next) ? `${word} ${next}` : word;
}

export function targetPath(input: Record<string, unknown>, cwd: string): string {
	const raw = typeof input.path === "string" && input.path.trim() ? input.path.trim().replace(/^@/, "") : ".";
	const expanded = raw === "~" ? homedir() : raw.startsWith("~/") || raw.startsWith(`~${sep}`) ? homedir() + raw.slice(1) : raw;
	return resolve(cwd, expanded);
}

export interface Approvals {
	commands: Set<string>;
	edits: boolean;
	outside: Set<string>;
}

export const noApprovals = (): Approvals => ({ commands: new Set(), edits: false, outside: new Set() });

/** The gate's answer for one tool call, before anyone is asked. */
export function decide(mode: PermissionModeId, toolName: string, input: Record<string, unknown>, cwd: string, approved: Approvals): Decision {
	const allow = { action: "allow" } as const;
	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof input.command === "string" ? input.command : "";
		if (namesEnvFile(command)) return { action: "deny", reason: "Blocked: .env files are off limits. Ask the user for the values you need." };
		if (mode === "bypass") return allow;
		const prefix = commandPrefix(command);
		if (approved.commands.has(prefix)) return allow;
		const asks = mode === "auto" ? isRisky(command) : !onlyReads(command);
		return asks ? { action: "ask", title: t("Run this command?\n\n{command}", { command }), remember: { kind: "command", prefix } } : allow;
	}
	if (!FILE_TOOLS.has(toolName)) return allow;
	const path = targetPath(input, cwd);
	if (isEnvFile(path)) return { action: "deny", reason: "Blocked: .env files are off limits. Ask the user for the values you need." };
	if (mode === "bypass") return allow;
	const writes = WRITE_TOOLS.has(toolName);
	if (!isInside(cwd, path)) {
		if ((mode === "auto" && !writes) || [...approved.outside].some((dir) => isInside(dir, path))) return allow;
		const dir = writes || toolName === "read" ? dirname(path) : path;
		return {
			action: "ask",
			title: writes ? t("Change a file outside the project?\n\n{path}", { path }) : t("Read outside the project?\n\n{path}", { path }),
			remember: { kind: "outside", dir },
		};
	}
	if (!writes || mode === "edits" || mode === "auto" || approved.edits) return allow;
	return { action: "ask", title: t("Edit this file?\n\n{path}", { path: relative(cwd, path) }), remember: { kind: "edits" } };
}

function rememberLabel(remember: Remembered): string {
	if (remember.kind === "command") return t("Allow `{prefix}` for this session", { prefix: remember.prefix });
	if (remember.kind === "edits") return t("Allow edits in the project for this session");
	return t("Allow {dir} for this session", { dir: remember.dir });
}

/** The extension, with the mode read from Trivium's settings each time. */
export function permissionGate(mode: () => PermissionModeId) {
	return (pi: ExtensionAPI) => {
		const approved = noApprovals();
		pi.on("tool_call", async (event, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
			const decision = decide(mode(), event.toolName, event.input as Record<string, unknown>, ctx.cwd, approved);
			if (decision.action === "allow") return undefined;
			if (decision.action === "deny") return { block: true, reason: decision.reason };
			if (!ctx.hasUI) return { block: true, reason: "Blocked: this needs the user's approval, and no one can answer here." };
			const yes = t("Allow");
			const always = rememberLabel(decision.remember);
			const no = t("Deny");
			const noWithNote = t("Deny and say what to do instead");
			const answer = await ctx.ui.select(decision.title, [yes, always, no, noWithNote]);
			if (answer === yes) return undefined;
			if (answer === always) {
				const { remember } = decision;
				if (remember.kind === "command") approved.commands.add(remember.prefix);
				else if (remember.kind === "edits") approved.edits = true;
				else approved.outside.add(remember.dir);
				return undefined;
			}
			const note = answer === noWithNote ? (await ctx.ui.input(t("What should it do instead?")))?.trim() : undefined;
			return { block: true, reason: note ? `The user denied this and said: ${note}` : "The user denied this. Don't try it another way; ask them what they want." };
		});
	};
}
