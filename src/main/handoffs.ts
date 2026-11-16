import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

/** Validate the bounded projection we display; malformed children cannot authorize a patch read. */
export function manifestOf(value: unknown): { children: { key: string; patch: Omit<ChildHandoff, "id" | "files"> }[]; kept: NonNullable<Subagent["keptWorktrees"]>; worktrees: string[] } | undefined {
	const manifest = object(value);
	if (manifest.version !== 1 || typeof manifest.runId !== "string" || !Array.isArray(manifest.groups)) return undefined;
	const children: { key: string; patch: Omit<ChildHandoff, "id" | "files"> }[] = [];
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
			children.push({ key, patch: { path: string(patch.path), branch: patch.branch, changed: patch.changed, filesChanged: count(patch.filesChanged)!, insertions: count(patch.insertions)!, deletions: count(patch.deletions)!, error: string(patch.error) || undefined } });
		}
		for (const task of objects(object(group.cleanup).tasks)) {
			if (objects(group.children).length && (task.preserved === true || task.worktreeRemoved === false) && string(task.path)) {
				kept.push({ path: string(task.path), branch: string(task.branch), reason: string(task.reason) || (Array.isArray(task.errors) ? task.errors.filter((error) => typeof error === "string").join("; ") : "") });
			}
		}
	}
	return { children, kept, worktrees };
}

async function boundedRead(path: string, max: number): Promise<string> {
	if ((await stat(path)).size > max) throw new Error(t("Handoff exceeds the display limit"));
	const bytes = await readFile(path);
	if (bytes.length > max) throw new Error(t("Handoff exceeds the display limit"));
	return bytes.toString("utf8");
}

/**
 * Per-session authorization and immutable patch bytes, captured at completion, never on the 40ms render path.
 * Only files under the extension's own roots are read (see extension-paths.ts): a manifest or patch path elsewhere,
 * a link out of them, or a UNC or device path is ignored, and the step shows the ordinary subagent result.
 */
export class HandoffCache {
	private manifests = new Map<string, { children: Map<string, ChildHandoff>; kept: NonNullable<Subagent["keptWorktrees"]>; worktrees: string[] }>();
	private patches = new Map<string, ChildPatchFile[]>();
	private completed = new Map<string, string>();
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
	}

	capture(details: unknown): Promise<void> {
		this.reading = this.reading.catch(() => {}).then(() => this.read(details));
		return this.reading;
	}

	private async read(details: unknown): Promise<void> {
		for (const run of objects(object(details).runs)) {
			if (typeof run.handoffPath === "string") {
				await this.read({ parallelHandoff: { path: run.handoffPath } });
				if (typeof run.runId === "string") this.completed.set(run.runId, run.handoffPath);
			}
		}
		const path = string(object(object(details).parallelHandoff).path);
		if (!isAbsolute(path)) return;
		const file = await trustedPath(path, this.roots);
		if (!file) return;
		try {
			const manifest = manifestOf(JSON.parse(await boundedRead(file, 4 * 1024 * 1024)));
			if (!manifest) return;
			const children = new Map<string, ChildHandoff>();
			for (const { key, patch } of manifest.children) {
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
				children.set(key, { ...patch, error, id, files: files.map((file) => file.file) });
			}
			this.manifests.set(path, { children, kept: manifest.kept, worktrees: manifest.worktrees });
		} catch { /* Old or removed artifacts leave the ordinary subagent result intact. */ }
	}

	patch(id: string): ChildPatchFile[] {
		const patch = this.patches.get(id);
		if (!patch) throw new Error(t("Unknown child patch"));
		return structuredClone(patch);
	}

	attach(runs: Run[]): Run[] {
		for (const run of runs) for (const step of run.steps) {
			const subagent = step.subagent;
			const path = subagent?.handoffPath || (subagent?.asyncId && this.completed.get(subagent.asyncId));
			const manifest = path && this.manifests.get(path);
			if (!subagent || !manifest) continue;
			subagent.keptWorktrees = manifest.kept;
			subagent.children.forEach((child, index) => {
				child.handoff = manifest.children.get(child.label ?? String(index));
				if (child.handoff?.branch || manifest.worktrees.includes(child.label ?? String(index))) child.worktree = true;
			});
			const patches = subagent.children.flatMap((child) => child.handoff ? [child.handoff] : []);
			if (patches.length && !subagent.children.some((child) => child.status === "error")) step.meta = t("+{adds} −{dels} · {n} files", { adds: patches.reduce((sum, patch) => sum + patch.insertions, 0), dels: patches.reduce((sum, patch) => sum + patch.deletions, 0), n: patches.reduce((sum, patch) => sum + patch.filesChanged, 0) });
		}
		return runs;
	}
}
