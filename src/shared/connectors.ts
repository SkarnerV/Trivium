import type { McpExposure } from "./protocol.ts";

/** How each exposure reaches the agent, in the order the Connectors page offers them. */
export const EXPOSURES: { value: McpExposure; label: string; hint: string }[] = [
	{ value: "codemode", label: "Code mode", hint: "pi's default. The agent finds and calls them from codemode scripts, so they stay out of every prompt." },
	{ value: "deferred", label: "On search", hint: "The agent searches for the tools it needs, then calls them directly." },
	{ value: "direct", label: "Always", hint: "Sent with every prompt, like a built-in tool. Best for a few tools used often." },
	{ value: "hidden", label: "Off", hint: "Connected, but the agent can't reach them." },
];

/** pi's rule for server names, which become part of tool names. */
export const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * A command line split into the program and its arguments, as a shell would split words: quotes group,
 * backslashes escape. Nothing is expanded; pi runs the program itself, not through a shell.
 */
export function splitCommand(line: string): string[] {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && (line[index + 1] === '"' || line[index + 1] === "\\")) word += line[++index];
			else word += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (char === "\\" && index + 1 < line.length) {
			word += line[++index];
			started = true;
		} else if (/\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += char;
			started = true;
		}
	}
	if (started) words.push(word);
	return words;
}

/** The program and its arguments as one line, quoting the words that need it, so splitCommand gives them back. */
export function joinCommand(words: string[]): string {
	return words.map((word) => (word && /^[\w@%+=:,./~${}-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`)).join(" ");
}

/** `KEY=value` or `Name: value` lines, one entry each; blank lines are skipped. Throws on a line without the separator. */
export function parsePairs(text: string, separator: "=" | ":"): Record<string, string> {
	const pairs: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const at = line.indexOf(separator);
		const key = at < 0 ? "" : line.slice(0, at).trim();
		if (!key) throw new Error(separator === "=" ? `“${line.trim()}” needs the form NAME=value.` : `“${line.trim()}” needs the form Name: value.`);
		pairs[key] = line.slice(at + 1).trim();
	}
	return pairs;
}

export function formatPairs(pairs: Record<string, string>, separator: "=" | ":"): string {
	return Object.entries(pairs)
		.map(([key, value]) => (separator === "=" ? `${key}=${value}` : `${key}: ${value}`))
		.join("\n");
}
