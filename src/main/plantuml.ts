import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { t } from "../shared/i18n.ts";

/** Starting Java takes a second or two; a large diagram can take a while longer. */
const TIMEOUT_MS = 30_000;
/** Each diagram starts its own Java, so a document with many waits for a few at a time. */
const AT_ONCE = 3;
/** Rendered diagrams kept, so reopening or reloading a document doesn't start Java again. */
const CACHE = 64;
export interface PlantUmlCommand {
	command: string;
	args: string[];
	/** A .cmd or .bat, which only a shell runs on Windows. */
	shell: boolean;
}

/** How to run PlantUML: the jar PLANTUML_JAR names, with Java, or else a plantuml command on the PATH. */
export function plantUmlCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (file: string) => boolean = existsSync,
): PlantUmlCommand | undefined {
	const args = ["-tsvg", "-pipe", "-charset", "UTF-8"];
	if (env.PLANTUML_JAR) {
		const java = env.JAVA_HOME ? join(env.JAVA_HOME, "bin", "java") : "java";
		return { command: java, args: ["-Djava.awt.headless=true", "-jar", env.PLANTUML_JAR, ...args], shell: false };
	}
	const windows = platform === "win32";
	const path = windows ? win32 : posix;
	// Windows names the variable Path, and other platforms run a file without an extension.
	const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
	const extensions = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	for (const dir of dirs) {
		for (const extension of extensions) {
			const file = path.join(dir, `plantuml${extension.toLowerCase()}`);
			if (exists(file)) return { command: file, args, shell: windows && /\.(bat|cmd)$/i.test(file) };
		}
	}
	return undefined;
}

/** A diagram as PlantUML reads it: the fenced code may leave out @startuml and @enduml. */
export function plantUmlSource(code: string): string {
	return /^\s*@start\w+/.test(code) ? code : `@startuml\n${code}\n@enduml\n`;
}

const cache = new Map<string, Promise<string>>();
const waiting: (() => void)[] = [];
let running = 0;

/** Draws a PlantUML diagram as SVG. A diagram with a mistake comes back as PlantUML's picture of the error. */
export function renderPlantUml(code: string): Promise<string> {
	const key = createHash("sha256").update(code).digest("hex");
	const cached = cache.get(key);
	if (cached) return cached;
	const result = queued(() => run(plantUmlSource(code)));
	cache.set(key, result);
	if (cache.size > CACHE) cache.delete(cache.keys().next().value!);
	// A failure, such as PlantUML not being installed yet, is tried again next time.
	result.catch(() => cache.delete(key));
	return result;
}

async function queued<T>(task: () => Promise<T>): Promise<T> {
	if (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
	running++;
	try {
		return await task();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

function run(source: string): Promise<string> {
	const missing = () =>
		new Error(t("PlantUML isn't installed or isn't on your PATH. Install it, or set PLANTUML_JAR to a plantuml.jar and have Java installed."));
	const found = plantUmlCommand();
	if (!found) return Promise.reject(missing());
	const { command, args, shell } = found;
	return new Promise((resolve, reject) => {
		const options = {
			windowsHide: true,
			// Its own standard library still loads, but no other files and no network: the document may come from anywhere.
			env: { ...process.env, PLANTUML_SECURITY_PROFILE: "SANDBOX" },
		};
		// A shell takes one command line; the arguments are fixed, and the path is quoted.
		const child = shell ? spawn(`"${command}" ${args.join(" ")}`, { ...options, shell: true }) : spawn(command, args, options);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(t("PlantUML took too long to draw this diagram.")));
		}, TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			reject(error.code === "ENOENT" ? missing() : error);
		});
		child.on("close", () => {
			clearTimeout(timer);
			const svg = Buffer.concat(out).toString("utf8");
			// PlantUML exits with an error for a diagram with a mistake, but still draws the mistake.
			const start = svg.indexOf("<svg");
			if (start >= 0) return resolve(svg.slice(start));
			const detail = Buffer.concat(err).toString("utf8").trim().split("\n")[0];
			reject(new Error(detail || t("PlantUML couldn't draw this diagram.")));
		});
		child.stdin.end(source);
	});
}
