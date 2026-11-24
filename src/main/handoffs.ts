import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ChildHandoff, ChildPatchFile, Run, Subagent } from "../shared/protocol.ts";
import { parseDiff } from "./git.ts";
import { t } from "../shared/i18n.ts";
import { type ExtensionRoots, trustedPath } from "./extension-paths.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Git quotes UTF-8 bytes with octal escapes, which JSON.parse does not accept. */
function patchName(raw: string): string {
	if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
	const text = raw.slice(1, -1);
	const parts: Buffer[] = [];
	let start = 0;
	for (const match of text.matchAll(/\\([0-7]{3}|.)/g)) {
		parts.push(Buffer.from(text.slice(start, match.index)));
		const escape = match[1]!;
		parts.push(/^[0-7]{3}$/.test(escape) ? Buffer.from([parseInt(escape, 8)]) : Buffer.from(({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" } as Record<string, string>)[escape] ?? escape));
		start = match.index + match[0].length;
	}
	parts.push(Buffer.from(text.slice(start)));
	return Buffer.concat(parts).toString("utf8");
}

/** Split before parsing: parseDiff deliberately reads only the first file in its input. */
export function splitPatch(text: string): ChildPatchFile[] {
	return text.split(/(?=^diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((part) => {
		const header = /^\+\+\+ (.+)$/m.exec(part)?.[1]?.trim();
		const old = /^--- (.+)$/m.exec(part)?.[1]?.trim();
		const raw = header && header !== "/dev/null" ? header : old && old !== "/dev/null" ? old : /^diff --git (?:"a\/.*?"|a\/.*?) (.+)$/m.exec(part)?.[1] ?? "";
		const file = patchName(raw);
		const diff = parseDiff(part);
		return { file: file.replace(/^[ab]\//, ""), ...diff, binary: diff.binary || /^GIT binary patch$/m.test(part) };
	});
}

export interface Manifest {
	/** The run the manifest belongs to: for a workflow's child, the child's own run. */
	runId: string;
	children: { key: string; runId?: string; patch: Omit<ChildHandoff, "id" | "files"> }[];
	kept: NonNullable<Subagent["keptWorktrees"]>;
	worktrees: string[];
}

/** Validate the bounded projection we display; malformed children cannot authorize a patch read. */
export function manifestOf(value: unknown): Manifest | undefined {
	const manifest = object(value);
	if (manifest.version !== 1 || typeof manifest.runId !== "string" || !Array.isArray(manifest.groups)) return undefined;
	const children: Manifest["children"] = [];
	const kept: NonNullable<Subagent["keptWorktrees"]> = [];
	const worktrees: string[] = [];
	for (const group of objects(manifest.groups)) {
		for (const binding of objects(group.laneBindings)) {
			if (string(binding.workflowKey) && objects(object(group.cleanup).tasks).some((task) => task.index === binding.taskIndex && string(task.branch))) worktrees.push(string(binding.workflowKey));
		}
		for (const child of objects(group.children)) {
			const patch = object(child.patch);
			if (!string(patch.path) || !isAbsolute(string(patch.path)) || typeof patch.branch !== "string" || typeof patch.changed !== "boolean") continue;
			if ([patch.filesChanged, patch.insertions, patch.deletions].some((value) => count(value) === undefined)) continue;
			const key = string(child.workflowKey) || string(object(child.lane).key) || String(child.index);
			if (patch.branch) worktrees.push(key);
			children.push({ key, ...(string(child.runId) ? { runId: string(child.runId) } : {}), patch: { path: string(patch.path), branch: patch.branch, changed: patch.changed, filesChanged: count(patch.filesChanged)!, insertions: count(patch.insertions)!, deletions: count(patch.deletions)!, error: string(patch.error) || undefined } });
		}
		for (const task of objects(object(group.cleanup).tasks)) {
			if (objects(group.children).length && (task.preserved === true || task.worktreeRemoved === false) && string(task.path)) {
				kept.push({ path: string(task.path), branch: string(task.branch), reason: string(task.reason) || (Array.isArray(task.errors) ? task.errors.filter((error) => typeof error === "string").join("; ") : "") });
			}
		}
	}
	return { runId: manifest.runId, children, kept, worktrees };
}

/** A child of a workflow, as its receipt names it. Its run, not its place in the list, says which manifest is its own. */
interface Writer {
	key: string;
	runId: string;
	agent: string;
	/** The workflow's own run, which a background workflow's launch step is known by. */
	workflow?: string;
	/** Paths the receipt gives for this child alone. */
	paths: string[];
	/** The call or its script started this child in a worktree, so it must have left a manifest. */
	expected: boolean;
}

/** What a workflow's script says of its children's worktrees, by the key each is started under. */
export function worktreeKeys(script: string): string[] {
	return [...script.matchAll(/\{[^{}]*\}/g)].flatMap(([entry]) => {
		const key = /\bkey\s*:\s*["']([\w.-]+)["']/.exec(entry)?.[1];
		return key && /\bworktree\s*:\s*true\b|\bisolation\s*:\s*["']worktree["']/.test(entry) ? [key] : [];
	});
}

const isRunId = (value: string) => /^[\w.-]+$/.test(value) && !/^\.+$/.test(value);

/** Every object in extension-owned JSON, to a depth no receipt needs. */
function* nested(value: unknown, depth = 0): Generator<Record<string, unknown>> {
	if (!value || typeof value !== "object" || depth > 6) return;
	if (!Array.isArray(value)) yield value as Record<string, unknown>;
	for (const child of Object.values(value).slice(0, 500)) yield* nested(child, depth + 1);
}

const strings = (value: unknown): string[] =>
	(Array.isArray(value) ? value : Object.values(object(value))).filter((item): item is string => typeof item === "string" && isAbsolute(item));

/**
 * The children a receipt reports, with the paths it gives each of them.
 *
 * A pi-subagents 0.82.1 workflow reports no manifest of its own. Each child is a run with a manifest of its own:
 * `<async run folder>/handoff.json` for a child run in the background, which is how a workflow starts them unless the
 * script says `async: false`, and `<artifacts folder>/handoffs/<run id>.json` for one run in this process
 * (`parallelHandoffPath` in `src/runs/shared/parallel-handoff.js`). What names them, seen in real receipts:
 *
 * - `results[].artifactPaths`: a record of the child's files in the artifacts folder, never the manifest itself;
 * - the child results a script returns, in `workflow.value`: an array with the run folder or the manifest
 *   (`workflowChildResult` in `src/runs/foreground/subagent-executor.js`);
 * - `mission.workflowChildren[].artifactPaths`: the same array, when the call has a mission;
 * - a background workflow's notice: `runs[].childOutputs[]`, the child's run and its output file.
 */
function writersOf(details: unknown, expected: { all: boolean; keys: string[] }): Writer[] {
	const info = object(details);
	const writers = new Map<string, Writer>();
	const add = (entry: Record<string, unknown>, key: string, paths: string[], workflow?: string) => {
		const runId = string(entry.runId);
		if (!runId || !isRunId(runId) || !key) return;
		const known = writers.get(runId);
		if (known) {
			if (known.key === key) known.paths.push(...paths);
			return;
		}
		writers.set(runId, { key, runId, agent: string(entry.agent), ...(workflow ? { workflow } : {}), paths, expected: expected.all || expected.keys.includes(key) });
	};
	for (const result of objects(info.results)) add(result, string(result.workflowKey), strings(result.artifactPaths));
	for (const run of objects(info.runs)) {
		for (const output of objects(run.childOutputs)) add(output, string(output.workflowKey), strings([output.outputArtifactPath, output.savedOutputPath]), string(run.runId));
	}
	for (const entry of nested(object(info.workflow).value)) {
		if (writers.has(string(entry.runId))) add(entry, string(entry.key), strings(entry.artifactPaths));
	}
	for (const entry of objects(object(info.mission).workflowChildren)) {
		if (writers.has(string(entry.runId))) add(entry, string(entry.key), strings(entry.artifactPaths));
	}
	return [...writers.values()];
}

const isManifestPath = (path: string, runId: string) => basename(path) === "handoff.json" || (basename(path) === `${runId}.json` && basename(dirname(path)) === "handoffs");
const isRunFolder = (path: string, runId: string) => basename(path) === runId && basename(dirname(path)) === "async-subagent-runs";

async function boundedRead(path: string, max: number): Promise<string> {
	if ((await stat(path)).size > max) throw new Error(t("Handoff exceeds the display limit"));
	const bytes = await readFile(path);
	if (bytes.length > max) throw new Error(t("Handoff exceeds the display limit"));
	return bytes.toString("utf8");
}

interface Captured {
	children: Map<string, ChildHandoff>;
	kept: NonNullable<Subagent["keptWorktrees"]>;
	worktrees: string[];
	/** The manifest is not this run's, or not there: nothing may be taken from it. */
	refused?: ChildHandoff;
}

/** A `subagent` call's input, and the folder it ran in. */
export interface CapturedCall {
	input: Record<string, unknown>;
	cwd: string;
}

/** Which of a workflow's children the call started in worktrees: all of them by a default, or those its script says. */
async function expectedOf(call: CapturedCall | undefined): Promise<{ all: boolean; keys: string[] }> {
	if (!call) return { all: false, keys: [] };
	const { input, cwd } = call;
	const options = object(input.options);
	const all = [input.worktree, options.worktree].includes(true) || [input.isolation, options.isolation].includes("worktree");
	if (typeof input.workflow !== "string" || !/[\\/]/.test(input.workflow)) return { all, keys: [] };
	const base = typeof input.cwd === "string" ? resolve(cwd, input.cwd) : cwd;
	const script = await boundedRead(resolve(base, input.workflow), 256 * 1024).catch(() => "");
	return { all, keys: worktreeKeys(script) };
}

/**
 * Per-session authorization and immutable patch bytes, captured at completion, never on the 40ms render path.
 * Only files under the extension's own roots are read (see extension-paths.ts): a manifest or patch path elsewhere,
 * a link out of them, or a UNC or device path is ignored, and the step shows the ordinary subagent result.
 */
export class HandoffCache {
	private manifests = new Map<string, Captured>();
	/** A workflow child's own manifest, by its run; also by its workflow's run and its key, for a background launch. */
	private writers = new Map<string, { handoff: ChildHandoff; kept: NonNullable<Subagent["keptWorktrees"]> }>();
	private patches = new Map<string, ChildPatchFile[]>();
	private completed = new Map<string, string>();
	/** Writers whose manifest is missing or another run's, by run id: nothing of theirs may be applied. */
	private refused = new Map<string, string>();
	private reading = Promise.resolve();

	private readonly roots: ExtensionRoots;

	constructor(roots: ExtensionRoots) {
		this.roots = roots;
	}

	/** Forgets every manifest and patch, for a session that is unloaded or deleted. */
	clear(): void {
		this.manifests.clear();
		this.patches.clear();
		this.completed.clear();
		this.writers.clear();
		this.refused.clear();
	}

	/**
	 * Reads the manifests a subagent result or notice names. `call` is given as the result arrives: with the script it
	 * names, it says which children must have left one, and then a manifest that is not there is a writer's work lost.
	 * One read back from the session's history may simply have been cleaned up since.
	 */
	capture(details: unknown, call?: CapturedCall): Promise<void> {
		this.reading = this.reading.catch(() => {}).then(() => this.read(details, call));
		return this.reading;
	}

	private async read(details: unknown, call?: CapturedCall): Promise<void> {
		const info = object(details);
		for (const run of objects(info.runs)) {
			if (typeof run.handoffPath !== "string") continue;
			await this.manifest(run.handoffPath, string(run.runId), call !== undefined);
			if (typeof run.runId === "string") this.completed.set(run.runId, run.handoffPath);
		}
		const path = string(object(info.parallelHandoff).path);
		if (path) await this.manifest(path, string(info.runId), call !== undefined);
		const writers = writersOf(details, await expectedOf(call));
		if (!writers.length) return;
		const runFolders = await this.runFolders();
		for (const writer of writers) await this.writer(writer, runFolders);
	}

	/** The manifest at a path the extension gave for a whole run, whose id it must carry. */
	private async manifest(path: string, runId: string, live: boolean): Promise<void> {
		const refuse = (reason: string, shown: string) => {
			if (runId) this.refused.set(runId, reason);
			this.manifests.set(path, { children: new Map(), kept: [], worktrees: [], refused: this.refusedHandoff(shown) });
		};
		const file = await trustedPath(path, this.roots);
		if (!file) {
			if (live) refuse("its patch manifest is missing", t("the patch manifest is missing."));
			return;
		}
		try {
			const manifest = manifestOf(JSON.parse(await boundedRead(file, 4 * 1024 * 1024)));
			if (!manifest) return;
			if (runId && manifest.runId !== runId) {
				refuse(`its patch manifest belongs to run ${manifest.runId}`, t("the patch manifest isn't this agent's."));
				return;
			}
			const children = new Map<string, ChildHandoff>();
			for (const { key, patch } of manifest.children) children.set(key, await this.handoff(patch));
			this.manifests.set(path, { children, kept: manifest.kept, worktrees: manifest.worktrees });
		} catch { /* Old or removed artifacts leave the ordinary subagent result intact. */ }
	}

	/** One child's patch, read and kept: the bytes shown are the ones captured, whatever happens to the file later. */
	private async handoff(patch: Omit<ChildHandoff, "id" | "files">): Promise<ChildHandoff> {
		const id = randomUUID();
		let files: ChildPatchFile[] = [];
		let error = patch.error;
		const source = await trustedPath(patch.path, this.roots);
		if (!source) error ||= t("The patch is not where subagents keep their files.");
		else {
			try { files = splitPatch(await boundedRead(source, 8 * 1024 * 1024)); }
			catch (cause) { error ||= String(cause); }
		}
		this.patches.set(id, files);
		return { ...patch, error, id, files: files.map((file) => file.file) };
	}

	private refusedHandoff(reason: string): ChildHandoff {
		const id = randomUUID();
		this.patches.set(id, []);
		return { id, path: "", branch: "", changed: true, filesChanged: 0, insertions: 0, deletions: 0, error: t("Changes not captured: {reason}", { reason }), files: [] };
	}

	/** The folders that may hold background runs: under the configured temp root, or the OS temp folder's own. */
	private async runFolders(): Promise<string[]> {
		const folders = this.roots.trees.map((tree) => join(tree, "async-subagent-runs"));
		for (const temp of this.roots.temp) {
			const names = await readdir(temp).catch(() => []);
			folders.push(...names.filter((name) => name.startsWith("pi-subagents-")).map((name) => join(temp, name, "async-subagent-runs")));
		}
		return folders;
	}

	/**
	 * Finds one workflow child's manifest by the child's own run, and keeps its patch under that run. Nothing else
	 * tells children apart: the receipt lists them in the script's order, and their manifests know nothing of it.
	 */
	private async writer(writer: Writer, runFolders: string[]): Promise<void> {
		const { key, runId } = writer;
		const named = writer.paths.filter((path) => isManifestPath(path, runId));
		const folders = [...writer.paths.filter((path) => isRunFolder(path, runId)), ...runFolders.map((folder) => join(folder, runId))];
		const beside = writer.paths.map((path) => join(dirname(path), "handoffs", `${runId}.json`));
		let expected = writer.expected || named.length > 0;
		let wrong: string | undefined;
		for (const path of new Set([...named, ...folders.map((folder) => join(folder, "handoff.json")), ...beside])) {
			const file = await trustedPath(path, this.roots);
			if (!file) continue;
			let manifest: Manifest | undefined;
			try {
				manifest = manifestOf(JSON.parse(await boundedRead(file, 4 * 1024 * 1024)));
			} catch { /* Unreadable reads as malformed. */ }
			if (!manifest) {
				wrong ??= "its patch manifest can't be read";
				continue;
			}
			if (manifest.runId !== runId) {
				wrong ??= `its patch manifest belongs to run ${manifest.runId}`;
				continue;
			}
			const own = manifest.children.filter((child) => (child.runId === undefined || child.runId === runId) && (child.key === key || child.runId === runId));
			if (own.length !== 1) {
				// A child still working has only its worktree recorded.
				if (!manifest.children.length && manifest.worktrees.length) return;
				wrong ??= "its patch manifest doesn't list it";
				continue;
			}
			this.refused.delete(runId);
			this.keep(writer, await this.handoff(own[0]!.patch), manifest.kept);
			return;
		}
		// No manifest. Only a child that ran in a worktree has to have one.
		for (const folder of expected || wrong ? [] : folders) {
			const file = await trustedPath(join(folder, "status.json"), this.roots);
			if (!file) continue;
			try {
				const status = object(JSON.parse(await boundedRead(file, 1024 * 1024)));
				expected ||= Boolean(string(object(status.parallelHandoff).path)) || objects(status.steps).some((step) => string(step.worktreePath));
			} catch { /* No status, no claim. */ }
		}
		if (!expected && !wrong) return;
		const reason = wrong ?? "its patch manifest is missing";
		this.refused.set(runId, reason);
		this.keep(writer, this.refusedHandoff(t(wrong ? "the patch manifest isn't this agent's." : "the patch manifest is missing.")), []);
	}

	private keep(writer: Writer, handoff: ChildHandoff, kept: NonNullable<Subagent["keptWorktrees"]>): void {
		const entry = { handoff, kept };
		this.writers.set(writer.runId, entry);
		if (writer.workflow) this.writers.set(`${writer.workflow}\0${writer.key}`, entry);
	}

	/**
	 * What the main agent is told of a result's patches: where each validated one is, and which writer's work it must
	 * not take in. Undefined when the result handed nothing back.
	 */
	report(details: unknown): string | undefined {
		const info = object(details);
		const lines: string[] = [];
		const line = (name: string, handoff: ChildHandoff) =>
			handoff.error || !handoff.path
				? `- ${name}: BLOCKED, do not integrate. ${handoff.error ?? ""}`.trim()
				: handoff.changed
					? `- ${name}: ${handoff.path} (${handoff.filesChanged} files, +${handoff.insertions} -${handoff.deletions})`
					: `- ${name}: no changes`;
		for (const writer of writersOf(details, { all: false, keys: [] })) {
			const name = writer.agent ? `${writer.key} (${writer.agent})` : writer.key;
			const refused = this.refused.get(writer.runId);
			if (refused) lines.push(`- ${name}: BLOCKED, do not integrate: ${refused} (run ${writer.runId}).`);
			else {
				const entry = this.writers.get(writer.runId);
				if (entry) lines.push(line(name, entry.handoff));
			}
		}
		const named = this.manifests.get(string(object(info.parallelHandoff).path));
		const whole = named?.refused ? undefined : named;
		for (const [key, handoff] of whole?.children ?? []) lines.push(line(/^\d+$/.test(key) ? string(objects(info.results)[Number(key)]?.agent) || key : key, handoff));
		const run = string(info.runId);
		if (!whole && this.refused.has(run)) lines.push(`- run ${run}: BLOCKED, do not integrate: ${this.refused.get(run)}.`);
		return lines.length ? `Patches checked by Trivium, each matched to its writer's own run:\n${lines.join("\n")}` : undefined;
	}

	/** Why a command may not run: it names the work of a writer whose manifest is missing or not its own. */
	refusal(command: string): string | undefined {
		for (const [runId, reason] of this.refused) {
			if (command.includes(runId)) return `Blocked: run ${runId} must not be integrated, because ${reason}. Start that piece of work again, or tell the user.`;
		}
		return undefined;
	}

	patch(id: string): ChildPatchFile[] {
		const patch = this.patches.get(id);
		if (!patch) throw new Error(t("Unknown child patch"));
		return structuredClone(patch);
	}

	attach(runs: Run[]): Run[] {
		for (const run of runs) for (const step of run.steps) {
			const subagent = step.subagent;
			if (!subagent) continue;
			const path = subagent.handoffPath || (subagent.asyncId && this.completed.get(subagent.asyncId));
			const manifest = path ? this.manifests.get(path) : undefined;
			const kept = [...(manifest?.kept ?? [])];
			let found = Boolean(manifest);
			subagent.children.forEach((child, index) => {
				const own = (child.runId && this.writers.get(child.runId)) || (subagent.asyncId && child.label && this.writers.get(`${subagent.asyncId}\0${child.label}`));
				if (own) {
					found = true;
					child.handoff = own.handoff;
					child.worktree = true;
					kept.push(...own.kept);
					return;
				}
				if (!manifest) return;
				child.handoff = manifest.refused ?? manifest.children.get(child.label ?? String(index));
				if (child.handoff?.branch || manifest.worktrees.includes(child.label ?? String(index))) child.worktree = true;
			});
			if (!found) continue;
			subagent.keptWorktrees = kept;
			const patches = subagent.children.flatMap((child) => child.handoff?.path ? [child.handoff] : []);
			if (patches.length && !subagent.children.some((child) => child.status === "error")) {
				const files = patches.reduce((sum, patch) => sum + patch.filesChanged, 0);
				step.meta = t(files === 1 ? "+{adds} −{dels} · {n} file" : "+{adds} −{dels} · {n} files", {
					adds: patches.reduce((sum, patch) => sum + patch.insertions, 0),
					dels: patches.reduce((sum, patch) => sum + patch.deletions, 0),
					n: files,
				});
			}
		}
		return runs;
	}
}
