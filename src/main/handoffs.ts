import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ChildHandoff, ChildPatchFile, Run, Subagent } from "../shared/protocol.ts";
import { parseDiff } from "./git.ts";
import { t } from "../shared/i18n.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Split before parsing: parseDiff deliberately reads only the first file in its input. */
export function splitPatch(text: string): ChildPatchFile[] {
	return text.split(/(?=^diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((part) => {
		const header = /^\+\+\+ (.+)$/m.exec(part)?.[1]?.trim();
		const old = /^--- (.+)$/m.exec(part)?.[1]?.trim();
		const raw = header && header !== "/dev/null" ? header : old && old !== "/dev/null" ? old : /^diff --git (?:"a\/.*?"|a\/.*?) (.+)$/m.exec(part)?.[1] ?? "";
		let file = raw;
		if (raw.startsWith('"')) {
			try { file = JSON.parse(raw); } catch { /* Keep an unfamiliar git-quoted name readable. */ }
		}
		return { file: file.replace(/^[ab]\//, ""), ...parseDiff(part) };
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
	if ((await stat(path)).size > max) throw new Error("Handoff exceeds the display limit");
	const bytes = await readFile(path);
	if (bytes.length > max) throw new Error("Handoff exceeds the display limit");
	return bytes.toString("utf8");
}

/** Per-session authorization and immutable patch bytes, captured at completion, never on the 40ms render path. */
export class HandoffCache {
	private manifests = new Map<string, { children: Map<string, ChildHandoff>; kept: NonNullable<Subagent["keptWorktrees"]>; worktrees: string[] }>();
	private patches = new Map<string, ChildPatchFile[]>();
	private completed = new Map<string, string>();
	private reading = Promise.resolve();

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
		try {
			const manifest = manifestOf(JSON.parse(await boundedRead(path, 4 * 1024 * 1024)));
			if (!manifest) return;
			const children = new Map<string, ChildHandoff>();
			for (const { key, patch } of manifest.children) {
				const id = randomUUID();
				let files: ChildPatchFile[] = [];
				let error = patch.error;
				try { files = splitPatch(await boundedRead(patch.path, 8 * 1024 * 1024)); }
				catch (cause) { error ||= String(cause); }
				this.patches.set(id, files);
				children.set(key, { ...patch, error, id, files: files.map((file) => file.file) });
			}
			this.manifests.set(path, { children, kept: manifest.kept, worktrees: manifest.worktrees });
		} catch { /* Old or removed artifacts leave the ordinary subagent result intact. */ }
	}

	patch(id: string): ChildPatchFile[] {
		const patch = this.patches.get(id);
		if (!patch) throw new Error("Unknown child patch");
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
