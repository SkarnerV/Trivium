import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The shell commands a `subagent` call makes pi-subagents run itself, past every tool the permission gate sees.
 *
 * Found in pi-subagents 0.82.1 (`src/runs/shared/acceptance.js`, `runVerifyCommand`): after a child finishes, the
 * extension spawns through a shell, under no permission gate,
 *
 * - the call's `gate`, a command or `{ command }`, at the top level or in `options`;
 * - each `command` in its `acceptance.verify`, where `acceptance` may also be that object as JSON text;
 * - the same in a custom agent's own `acceptance` frontmatter, which `create` and `update` actions can also write;
 * - the same on any `runs.run` in a workflow script, and, for a named workflow, `runs.host` commands.
 *
 * So each is judged as if the model had asked for it with the shell tool. A script is read and the gates it writes
 * out are collected; one that could hold a command this cannot read is `unknown`, and asked about as a whole.
 */
export interface EmbeddedCommands {
	commands: string[];
	/** Set when the call may also run commands that cannot be read beforehand: what to name in the question. */
	unknown?: string;
}

/** A larger script or agent file counts as unreadable. */
const MAX_BYTES = 256 * 1024;
const MAX_AGENT_FILES = 500;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Actions that start a child. Every other action manages something, and runs no command of its own. */
const STARTING_ACTIONS = new Set(["resume", "schedule.create"]);
/** Actions that save an agent definition, whose commands then run for every child started from it. */
const AGENT_ACTIONS = new Set(["create", "update"]);

export function subagentAction(input: Record<string, unknown>): string | undefined {
	return typeof input.action === "string" && input.action.trim() ? input.action.trim() : undefined;
}

/** A field as pi-subagents reads it: at the top level or in `options`. Both count; a conflict is the extension's to refuse. */
export function subagentFields(input: Record<string, unknown>, name: string): unknown[] {
	const options = isObject(input.options) ? input.options : {};
	return [input[name], options[name]].filter((value) => value !== undefined);
}

class Found implements EmbeddedCommands {
	commands: string[] = [];
	unknown?: string;

	gate(value: unknown): void {
		const command = isObject(value) ? value.command : value;
		if (typeof command === "string" && command.trim()) this.commands.push(command.trim());
		else this.unknown ??= "gate";
	}

	acceptance(value: unknown): void {
		let policy = value;
		if (typeof policy === "string") {
			// A level such as "checked" names no command.
			if (!/^\s*[{[]/.test(policy)) return;
			try {
				policy = JSON.parse(policy);
			} catch {
				this.unknown ??= "acceptance";
				return;
			}
		}
		if (!isObject(policy) || policy.verify === undefined) return;
		for (const entry of Array.isArray(policy.verify) ? policy.verify : [undefined]) {
			if (isObject(entry) && typeof entry.command === "string" && entry.command.trim()) this.commands.push(entry.command.trim());
			else this.unknown ??= "acceptance.verify";
		}
	}
}

/**
 * What makes a script unreadable: escapes, spreads, computed keys and members other than an index, and the names
 * through which a field could be set, or a whole option object passed, without being written out where this can see it.
 */
const UNREADABLE = [
	/\\[ux]/,
	/\.\.\./,
	// A bracket that can only open a list: anywhere else it may name a field, as value[key] does. Then { [key]: … }.
	/(?<!(?:[=(,:[{;?&|!>]|\b(?:return|of|in|const|let|var|await|yield|case|default))\s*)\[(?!\s*\d+\s*\])/,
	/\/\/.*\r?\n\s*\[/,
	/\]\s*:/,
	/\b(?:class|args|acceptance|verify|host|resume|eval|Function|Reflect|Object|JSON|globalThis|import|require|constructor|prototype|fromCharCode|atob|Proxy|state)\b/,
];
const LITERAL_GATE = /(?<![\w$.])(?:gate|"gate"|'gate')\s*:\s*(?:\{\s*command\s*:\s*)?("(?:[^"\\\n]|\\["\\])*"|'(?:[^'\\\n]|\\['\\])*')(?=\s*[,}])/g;

/** The gates a script writes out, and whether it could run anything else. */
export function scriptCommands(script: string): EmbeddedCommands {
	const commands: string[] = [];
	const rest = script.replace(LITERAL_GATE, (_match, literal: string) => {
		commands.push(literal.slice(1, -1).replace(/\\(["'\\])/g, "$1").trim());
		return "";
	});
	// Any other mention: `gate: command`, `child.gate = …`, or quotes that only look like one around more code.
	const readable = ![rest, ...commands].some((text) => /gate/i.test(text)) && !UNREADABLE.some((pattern) => pattern.test(script));
	return { commands, ...(readable ? {} : { unknown: "workflow" }) };
}

function readText(path: string): string | undefined {
	try {
		const info = statSync(path);
		return info.isFile() && info.size <= MAX_BYTES ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/** A custom agent definition, as far as Trivium reads one. */
export interface AgentDefinition {
	name: string;
	aliases: string[];
	frontmatter: string;
}

/** pi's agent folder, as pi resolves it; read here so the child gate's bundle does not need the whole SDK. */
function agentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured === "~" || /^~[\\/]/.test(configured) ? join(homedir(), configured.slice(1)) : configured;
}

/**
 * The custom agents defined where pi-subagents would look for this call: `.pi/agents` and `.agents` in the project
 * and the folders above it, and the user's own. Looking further up than the extension does only finds more to ask about.
 */
export function customAgents(cwd: string): AgentDefinition[] {
	const folders = [join(agentDirectory(), "agents"), join(homedir(), ".agents")];
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		folders.push(join(dir, ".pi", "agents"), join(dir, ".agents"));
		if (dir === dirname(dir)) break;
	}
	const found: AgentDefinition[] = [];
	let files = 0;
	const visit = (dir: string, depth: number): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const path = join(dir, name);
			if (!name.endsWith(".md")) {
				// Skills live in .agents/skills, and are not agents.
				if (name !== "skills" && !name.includes(".") && depth < 4) visit(path, depth + 1);
				continue;
			}
			if (++files > MAX_AGENT_FILES) return;
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readText(path) ?? "")?.[1];
			const named = frontmatter && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)?.[1];
			if (!frontmatter || !named) continue;
			const aliases = /^aliases:\s*(.+)$/m.exec(frontmatter)?.[1]?.split(",").map((alias) => alias.trim()) ?? [];
			found.push({ name: named, aliases, frontmatter });
		}
	};
	for (const folder of new Set(folders)) visit(folder, 0);
	return found;
}

/** Whether a definition answers to the name a call gives: its own, an alias, or the last part of `package.name`. */
export function answersTo(agent: AgentDefinition, name: string): boolean {
	const wanted = name.trim();
	return agent.name === wanted || agent.aliases.includes(wanted) || wanted.endsWith(`.${agent.name}`);
}

function agentCommands(found: Found, agents: AgentDefinition[]): void {
	for (const agent of agents) {
		const value = /^acceptance:[ \t]*(.*)$/m.exec(agent.frontmatter)?.[1]?.trim();
		// None, or a level such as `checked`.
		if (value === undefined || /^["']?[\w-]+["']?$/.test(value)) continue;
		if (/^\{.*\}$/.test(value)) {
			try {
				found.acceptance(JSON.parse(value));
				continue;
			} catch {
				// Written as YAML, which this does not read.
			}
		}
		if (/verify/.test(agent.frontmatter)) found.unknown ??= agent.name;
	}
}

/**
 * Every command this `subagent` call makes the extension run, and whether it may run more. `settled` is false when
 * other calls of the same reply may still change files: what a script says now is then not what will run.
 */
export function embeddedCommands(input: Record<string, unknown>, cwd: string, settled = true): EmbeddedCommands {
	const found = new Found();
	const action = subagentAction(input);
	if (action && AGENT_ACTIONS.has(action)) {
		for (const config of subagentFields(input, "config")) {
			let value = config;
			if (typeof value === "string") {
				try {
					value = JSON.parse(value);
				} catch {
					continue;
				}
			}
			if (isObject(value)) found.acceptance(value.acceptance);
		}
		return found;
	}
	if (action && !STARTING_ACTIONS.has(action)) return found;
	for (const gate of subagentFields(input, "gate")) found.gate(gate);
	for (const acceptance of subagentFields(input, "acceptance")) found.acceptance(acceptance);
	const [folder] = subagentFields(input, "cwd");
	const base = typeof folder === "string" && folder.trim() ? resolve(cwd, folder.trim()) : cwd;
	const custom = customAgents(base);
	const [workflow] = subagentFields(input, "workflow");
	const [agent] = subagentFields(input, "agent");
	if (workflow === undefined && typeof agent === "string") {
		agentCommands(found, custom.filter((each) => answersTo(each, agent)));
		return found;
	}
	// A script, a resumed run or a list of steps picks its own agents, so every custom agent's commands count.
	agentCommands(found, custom);
	if (workflow === undefined) return found;
	// Only a script file can be read here: `true` is a block of the reply, and any other name an installed workflow.
	const path = typeof workflow === "string" && /[\\/]/.test(workflow) ? workflow : undefined;
	const script = path === undefined || !settled ? undefined : readText(resolve(base, path));
	const read: EmbeddedCommands = script === undefined ? { commands: [], unknown: "workflow" } : scriptCommands(script);
	found.commands.push(...read.commands);
	if (read.unknown) found.unknown ??= typeof workflow === "string" && workflow !== "true" ? workflow : "workflow";
	return found;
}
