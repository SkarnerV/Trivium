import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PermissionModeId } from "../shared/permissions.ts";
import { t } from "../shared/i18n.ts";
import { isInside } from "./reader.ts";
import { embeddedCommands } from "./subagent-commands.ts";

/**
 * Trivium's permission gate for Code, with the rules PERMISSION_MODES describes and nothing else. It reads the mode
 * on every call, so a change in the composer reaches sessions already running.
 */

export type Decision = { action: "allow" } | { action: "deny"; reason: string } | { action: "ask"; title: string; remember?: Remembered };

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

const ENV_REASON = "Blocked: .env files are off limits. Ask the user for the values you need.";

/** Whether a mode asks about a shell command, whoever is to run it: the shell tool, or pi-subagents for a call's gate. */
function asksAbout(mode: PermissionModeId, command: string, approved: Approvals): boolean {
	if (mode === "bypass" || approved.commands.has(commandPrefix(command))) return false;
	return mode === "auto" ? isRisky(command) : !onlyReads(command);
}

/**
 * A `subagent` call can make pi-subagents run shell commands itself (subagent-commands.ts), past every tool this gate
 * sees, so each is judged as the shell tool's would be. A script whose commands can't be read is asked about whole.
 */
function decideSubagent(mode: PermissionModeId, input: Record<string, unknown>, cwd: string, approved: Approvals, settled: boolean): Decision {
	const { commands, unknown } = embeddedCommands(input, cwd, settled);
	if (commands.some(namesEnvFile)) return { action: "deny", reason: ENV_REASON };
	if (mode === "bypass") return { action: "allow" };
	const asking = [...new Set(commands)].filter((command) => asksAbout(mode, command, approved));
	const command = asking.join("\n");
	if (unknown !== undefined) {
		// Never remembered: the next script may be another one.
		return {
			action: "ask",
			title: asking.length
				? t("Run subagents with commands that can't be checked first?\n\n{name}\n\nThey also run:\n{command}", { name: unknown, command })
				: t("Run subagents with commands that can't be checked first?\n\n{name}", { name: unknown }),
		};
	}
	if (!asking.length) return { action: "allow" };
	return {
		action: "ask",
		title: t("Run this command when the subagent finishes?\n\n{command}", { command }),
		...(asking.length === 1 ? { remember: { kind: "command", prefix: commandPrefix(command) } } : {}),
	};
}

/**
 * The gate's answer for one tool call, before anyone is asked. `settled` is false when other calls of the same reply
 * are still to run, which can rewrite a script this call names.
 */
export function decide(mode: PermissionModeId, toolName: string, input: Record<string, unknown>, cwd: string, approved: Approvals, settled = true): Decision {
	const allow = { action: "allow" } as const;
	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof input.command === "string" ? input.command : "";
		if (namesEnvFile(command)) return { action: "deny", reason: ENV_REASON };
		if (!asksAbout(mode, command, approved)) return allow;
		return { action: "ask", title: t("Run this command?\n\n{command}", { command }), remember: { kind: "command", prefix: commandPrefix(command) } };
	}
	if (toolName === "subagent") return decideSubagent(mode, input, cwd, approved, settled);
	if (!FILE_TOOLS.has(toolName)) return allow;
	const path = targetPath(input, cwd);
	if (isEnvFile(path)) return { action: "deny", reason: ENV_REASON };
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

/** Whether the reply that made this call made no other: pi checks every call of a reply before it runs any of them. */
function onlyCall(ctx: ExtensionContext, toolCallId: string): boolean {
	const branch = ctx.sessionManager?.getBranch() ?? [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const calls = entry.message.content.filter((part) => part.type === "toolCall");
		if (calls.some((call) => call.id === toolCallId)) return calls.length === 1;
	}
	return true;
}

/** The extension, with the mode read from Trivium's settings each time. */
export function permissionGate(mode: () => PermissionModeId) {
	return (pi: ExtensionAPI) => {
		const approved = noApprovals();
		pi.on("tool_call", async (event, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
			const settled = event.toolName !== "subagent" || onlyCall(ctx, event.toolCallId);
			const decision = decide(mode(), event.toolName, event.input as Record<string, unknown>, ctx.cwd, approved, settled);
			if (decision.action === "allow") return undefined;
			if (decision.action === "deny") return { block: true, reason: decision.reason };
			if (!ctx.hasUI) return { block: true, reason: "Blocked: this needs the user's approval, and no one can answer here." };
			const yes = t("Allow");
			const always = decision.remember && rememberLabel(decision.remember);
			const no = t("Deny");
			const noWithNote = t("Deny and say what to do instead");
			const answer = await ctx.ui.select(decision.title, [yes, ...(always ? [always] : []), no, noWithNote]);
			if (answer === yes) return undefined;
			if (decision.remember && answer === always) {
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
