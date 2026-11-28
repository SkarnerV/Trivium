import { isAbsolute, resolve } from "node:path";

/**
 * `.vscode/tasks.json`, read as VS Code reads it (Tasks 2.0.0, JSONC) and narrowed to what the Launch button runs:
 * `shell` tasks for the app, each optionally depending on one Microsoft Container Tools `docker-compose` task for its
 * infrastructure. Nothing here is Trivium's own: a field this does not support is refused by name, never guessed at.
 */

/** Where a problem in the file is. */
export interface SourcePosition {
	line: number;
	column: number;
}

/** A problem with the file as a whole: it does not parse, or it sets something for every task. */
export class TasksFileError extends Error {
	readonly position?: SourcePosition;

	constructor(message: string, position?: SourcePosition) {
		super(position ? `${message} (line ${position.line}, column ${position.column})` : message);
		this.position = position;
	}
}

/**
 * Parses JSON with comments and trailing commas, as VS Code reads its settings files. A mistake stops it with
 * the line and column, so nothing runs from a file that was not read as written.
 */
export function parseJsonc(text: string): unknown {
	let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const position = (at: number): SourcePosition => {
		let line = 1;
		let column = 1;
		for (let i = 0; i < at && i < text.length; i++) {
			if (text[i] === "\n") {
				line++;
				column = 1;
			} else column++;
		}
		return { line, column };
	};
	const fail = (message: string, at = index): never => {
		throw new TasksFileError(message, position(at));
	};
	const skip = () => {
		for (;;) {
			const char = text[index];
			if (char === " " || char === "\t" || char === "\n" || char === "\r") index++;
			else if (char === "/" && text[index + 1] === "/") {
				while (index < text.length && text[index] !== "\n") index++;
			} else if (char === "/" && text[index + 1] === "*") {
				const end = text.indexOf("*/", index + 2);
				if (end < 0) fail("Unterminated comment");
				index = end + 2;
			} else return;
		}
	};
	const string = (): string => {
		const start = index;
		index++;
		let out = "";
		for (;;) {
			const char = text[index];
			if (char === undefined || char === "\n") return fail("Unterminated string", start);
			if (char === '"') {
				index++;
				return out;
			}
			if (char === "\\") {
				const next = text[index + 1];
				const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
				if (next !== undefined && next in simple) {
					out += simple[next];
					index += 2;
				} else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
					out += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16));
					index += 6;
				} else fail("Invalid escape in string");
			} else {
				out += char;
				index++;
			}
		}
	};
	const value = (): unknown => {
		skip();
		const char = text[index];
		if (char === "{") {
			index++;
			const object: Record<string, unknown> = {};
			skip();
			while (text[index] !== "}") {
				if (text[index] !== '"') fail("Expected a property name in double quotes");
				const key = string();
				skip();
				if (text[index] !== ":") fail("Expected ':' after a property name");
				index++;
				object[key] = value();
				skip();
				if (text[index] === ",") {
					index++;
					skip();
				} else if (text[index] !== "}") fail("Expected ',' or '}'");
			}
			index++;
			return object;
		}
		if (char === "[") {
			index++;
			const array: unknown[] = [];
			skip();
			while (text[index] !== "]") {
				array.push(value());
				skip();
				if (text[index] === ",") {
					index++;
					skip();
				} else if (text[index] !== "]") fail("Expected ',' or ']'");
			}
			index++;
			return array;
		}
		if (char === '"') return string();
		const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index, index + 64))?.[0];
		if (!literal) return fail(char === undefined ? "Unexpected end of file" : `Unexpected character '${char}'`);
		index += literal.length;
		return literal === "true" ? true : literal === "false" ? false : literal === "null" ? null : Number(literal);
	};
	const result = value();
	skip();
	if (index < text.length) fail("Unexpected content after the end");
	return result;
}

/** What a `shell` task runs, with its platform block merged in. */
export interface AppTask {
	label: string;
	command: string;
	args: string[];
	/** Absolute, not yet checked against the workspace. */
	cwd: string;
	env: Record<string, string>;
	dependsOn?: string;
}

/** What a `docker-compose` task brings up. Paths are absolute, not yet checked against the workspace. */
export interface InfraTask {
	label: string;
	files: string[];
	envFile?: string;
	services?: string[];
	profiles?: string[];
	build: boolean;
}

/** An app task as the Launch menu lists it: ready, or refused with the reason. */
export interface TaskEntry {
	label: string;
	app?: AppTask;
	infra?: InfraTask;
	error?: string;
}

export interface ReadTasks {
	/** `shell` tasks, in file order. */
	apps: TaskEntry[];
	/** Tasks that are neither an app task nor the infrastructure of one. */
	hidden: number;
	/** `docker-compose` tasks, by label, read or refused. */
	infra: Map<string, { infra?: InfraTask; error?: string }>;
}

/** Fields VS Code uses for presentation and problem matching, which say nothing about what runs. */
const METADATA = ["dependsOrder", "isBackground", "problemMatcher", "presentation", "group", "detail", "icon", "runOptions", "hide", "promptOnClose"];
const ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PLATFORMS = ["windows", "osx", "linux"] as const;

export function platformKey(platform: NodeJS.Platform): (typeof PLATFORMS)[number] {
	return platform === "win32" ? "windows" : platform === "darwin" ? "osx" : "linux";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Refused extends Error {}

const refuse = (message: string): never => {
	throw new Refused(message);
};

/** `${workspaceFolder}` and nothing else, in a path or an environment value. */
function substitute(value: string, field: string, workspace: string): string {
	const replaced = value.replaceAll("${workspaceFolder}", workspace);
	if (replaced.includes("${")) refuse(`${field}: only \${workspaceFolder} can be substituted`);
	return replaced;
}

function absolute(path: string, workspace: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
}

function onlyKeys(object: Record<string, unknown>, allowed: string[], where: string, hints: Record<string, string> = {}): void {
	for (const key of Object.keys(object)) {
		if (allowed.includes(key)) continue;
		refuse(`${where}${key} is not supported${hints[key] ? `. ${hints[key]}` : ""}`);
	}
}

function stringList(value: unknown, field: string, pattern?: RegExp): string[] {
	if (!Array.isArray(value)) return refuse(`${field} must be a list of strings`);
	return value.map((item, index) => {
		if (typeof item !== "string" || !item) refuse(`${field}[${index}] must be a non-empty string`);
		if (pattern && !pattern.test(item as string)) refuse(`${field}[${index}] has characters Launch does not pass on: use letters, digits and _@%+=:,./-`);
		return item as string;
	});
}

const APP_OPTION_HINTS = { shell: "Remove it to use Trivium's shell (Git Bash on Windows, bash on macOS)." };

function readOptions(value: unknown, where: string, workspace: string): { cwd?: string; env?: Record<string, string> } {
	if (value === undefined) return {};
	if (!isObject(value)) return refuse(`${where}options must be an object`);
	onlyKeys(value, ["cwd", "env"], `${where}options.`, APP_OPTION_HINTS);
	const result: { cwd?: string; env?: Record<string, string> } = {};
	if (value.cwd !== undefined) {
		if (typeof value.cwd !== "string" || !value.cwd) refuse(`${where}options.cwd must be a string`);
		result.cwd = absolute(substitute(value.cwd as string, `${where}options.cwd`, workspace), workspace);
	}
	if (value.env !== undefined) {
		if (!isObject(value.env)) refuse(`${where}options.env must be an object of strings`);
		result.env = {};
		for (const [name, text] of Object.entries(value.env as Record<string, unknown>)) {
			if (typeof text !== "string") refuse(`${where}options.env.${name} must be a string`);
			result.env[name] = substitute(text as string, `${where}options.env.${name}`, workspace);
		}
	}
	return result;
}

function readCommand(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) return refuse(`${field} must be a non-empty string`);
	if (value.includes("${")) refuse(`${field}: variable substitutions are not supported in command`);
	return value;
}

function readApp(task: Record<string, unknown>, label: string, workspace: string, platform: NodeJS.Platform): AppTask {
	onlyKeys(task, ["label", "type", "command", "args", "options", "dependsOn", ...PLATFORMS, ...METADATA], "");
	let command: string | undefined;
	let args: string[] = [];
	let cwd = workspace;
	let env: Record<string, string> = {};
	const apply = (block: Record<string, unknown>, where: string) => {
		if (block.command !== undefined) command = readCommand(block.command, `${where}command`);
		if (block.args !== undefined) args = stringList(block.args, `${where}args`, ARG);
		const options = readOptions(block.options, where, workspace);
		if (options.cwd) cwd = options.cwd;
		if (options.env) env = { ...env, ...options.env };
	};
	apply(task, "");
	for (const key of PLATFORMS) {
		const block = task[key];
		if (block === undefined) continue;
		if (!isObject(block)) refuse(`${key} must be an object`);
		onlyKeys(block as Record<string, unknown>, ["command", "args", "options"], `${key}.`);
		// Every platform's block is checked; only this one's applies.
		if (key === platformKey(platform)) apply(block as Record<string, unknown>, `${key}.`);
		else readOptions((block as Record<string, unknown>).options, `${key}.`, workspace);
	}
	if (command === undefined) refuse("command is missing");
	let dependsOn: string | undefined;
	if (task.dependsOn !== undefined) {
		const list = Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn];
		if (list.length > 1) refuse("dependsOn can name one docker-compose task, not several");
		if (list.length === 1) {
			if (typeof list[0] !== "string" || !list[0]) refuse("dependsOn must be a task label");
			dependsOn = list[0] as string;
		}
	}
	return { label, command: command!, args, cwd, env, dependsOn };
}

function readInfra(task: Record<string, unknown>, label: string, workspace: string): InfraTask {
	onlyKeys(task, ["label", "type", "dockerCompose", ...METADATA], "", {
		options: "Set the environment in the Compose file or an env file instead.",
		dependsOn: "Launch runs one infrastructure task before an app, without chains.",
	});
	const compose = task.dockerCompose;
	if (!isObject(compose)) return refuse("dockerCompose is missing");
	onlyKeys(compose, ["files", "up", "envFile", "envFiles"], "dockerCompose.", {
		projectName: "Trivium names the project itself, to keep it apart from your own Compose projects.",
		down: "Stop it from the Services panel.",
	});
	const files = stringList(compose.files, "dockerCompose.files").map((file, index) =>
		absolute(substitute(file, `dockerCompose.files[${index}]`, workspace), workspace),
	);
	if (!files.length) refuse("dockerCompose.files must list at least one file");
	const up = compose.up;
	if (!isObject(up)) return refuse("dockerCompose.up is missing");
	onlyKeys(up, ["services", "profiles", "build", "customOptions", "detached"], "dockerCompose.up.", {
		scale: "Set replicas in the Compose file instead.",
	});
	if (up.detached !== undefined && up.detached !== true) refuse("dockerCompose.up.detached: false is not supported; Launch always runs detached");
	if (up.services !== undefined && up.profiles !== undefined) refuse("dockerCompose.up can set services or profiles, not both");
	const services = up.services === undefined ? undefined : stringList(up.services, "dockerCompose.up.services", NAME);
	const profiles = up.profiles === undefined ? undefined : stringList(up.profiles, "dockerCompose.up.profiles", NAME);
	if (up.build !== undefined && typeof up.build !== "boolean") refuse("dockerCompose.up.build must be true or false");
	if (up.customOptions !== undefined && (typeof up.customOptions !== "string" || !["", "--wait"].includes(up.customOptions.trim()))) {
		refuse('dockerCompose.up.customOptions can only be "--wait"');
	}
	let envFile: string | undefined;
	if (compose.envFiles !== undefined) envFile = stringList(compose.envFiles, "dockerCompose.envFiles").at(-1);
	if (compose.envFile !== undefined) {
		if (typeof compose.envFile !== "string" || !compose.envFile) refuse("dockerCompose.envFile must be a string");
		envFile = compose.envFile as string;
	}
	return {
		label,
		files,
		envFile: envFile === undefined ? undefined : absolute(substitute(envFile, "dockerCompose.envFile", workspace), workspace),
		services,
		profiles,
		build: up.build !== false,
	};
}

/** Reads a parsed tasks.json: the app tasks the Launch menu offers, each ready or with the reason it can't run. */
export function readTasks(json: unknown, workspace: string, platform: NodeJS.Platform = process.platform): ReadTasks {
	if (!isObject(json)) throw new TasksFileError("tasks.json must hold an object");
	if (json.version !== "2.0.0") throw new TasksFileError('tasks.json must have "version": "2.0.0"');
	for (const key of ["command", "args", "options", "type", ...PLATFORMS]) {
		if (key in json) throw new TasksFileError(`The file-level "${key}" is not supported; set it on each task instead`);
	}
	if (!Array.isArray(json.tasks)) throw new TasksFileError('tasks.json has no "tasks" list');
	const tasks = json.tasks.filter(isObject);
	const counts = new Map<string, number>();
	for (const task of tasks) if (typeof task.label === "string") counts.set(task.label, (counts.get(task.label) ?? 0) + 1);
	const attempt = <T>(read: () => T): { value?: T; error?: string } => {
		try {
			return { value: read() };
		} catch (error) {
			if (error instanceof Refused) return { error: error.message };
			throw error;
		}
	};
	const infra = new Map<string, { infra?: InfraTask; error?: string }>();
	for (const task of tasks) {
		if (task.type !== "docker-compose" || typeof task.label !== "string") continue;
		const label = task.label;
		if (counts.get(label)! > 1) infra.set(label, { error: `More than one task is labelled "${label}"` });
		else {
			const read = attempt(() => readInfra(task, label, workspace));
			infra.set(label, { infra: read.value, error: read.error });
		}
	}
	const byLabel = new Map(tasks.flatMap((task) => (typeof task.label === "string" ? [[task.label, task] as const] : [])));
	const apps: TaskEntry[] = [];
	const used = new Set<string>();
	for (const task of tasks) {
		if (task.type !== "shell") continue;
		if (typeof task.label !== "string" || !task.label) continue;
		const label = task.label;
		if (counts.get(label)! > 1) {
			apps.push({ label, error: `More than one task is labelled "${label}"` });
			continue;
		}
		const read = attempt(() => readApp(task, label, workspace, platform));
		if (!read.value) {
			apps.push({ label, error: read.error });
			continue;
		}
		const app = read.value;
		if (!app.dependsOn) {
			apps.push({ label, app });
			continue;
		}
		used.add(app.dependsOn);
		const target = byLabel.get(app.dependsOn);
		if (!target) apps.push({ label, app, error: `dependsOn names "${app.dependsOn}", which is not a task in this file` });
		else if (target.type !== "docker-compose") apps.push({ label, app, error: `dependsOn must name a docker-compose task; "${app.dependsOn}" is a ${String(target.type)} task` });
		else {
			const dependency = infra.get(app.dependsOn)!;
			apps.push(dependency.error ? { label, app, error: `${app.dependsOn}: ${dependency.error}` } : { label, app, infra: dependency.infra });
		}
	}
	const hidden = tasks.length - apps.length - [...infra.keys()].filter((label) => used.has(label)).length;
	return { apps, hidden: Math.max(0, hidden), infra };
}

/** The command line as the shell gets it: the command, then its arguments, which need no quoting. */
export function commandLine(app: AppTask): string {
	return [app.command, ...app.args].join(" ");
}
