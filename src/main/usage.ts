import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SessionSummary, SessionUsage, UsageBucket, UsageReport } from "../shared/protocol.ts";
import { dayOf } from "../shared/usage.ts";

/**
 * Counts tokens and cost from pi's session files, where pi saves the usage of each assistant reply. A session's
 * subagents keep their own files in a folder named after it, beside it, and count toward it. What each session adds
 * up to is kept in a cache file and counted again only when one of its files changes.
 */

const CACHE_VERSION = 1;
/** Session files read at once. */
const CONCURRENT = 8;

interface Counted {
	/** Each file's path, size and modified time, so a change to any of them shows. */
	signature: string;
	buckets: UsageBucket[];
}

interface FileStamp {
	path: string;
	size: number;
	mtimeMs: number;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" && value ? value : "unknown");

/**
 * Adds the replies in one session file to `into`, keyed by day, provider and model. A fork starts with a copy of the
 * conversation it came from; replies older than the fork were counted in that session, so they are skipped here.
 */
export function countReplies(text: string, into: Map<string, UsageBucket>): void {
	let since = Number.NEGATIVE_INFINITY;
	for (const line of text.split("\n")) {
		if (!line.includes('"usage"') && !line.includes('"parentSession"')) continue;
		let entry: { type?: unknown; timestamp?: unknown; parentSession?: unknown; message?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			if (entry.parentSession) since = Date.parse(String(entry.timestamp)) || since;
			continue;
		}
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant" || typeof message.usage !== "object" || !message.usage) continue;
		const usage = message.usage as Record<string, unknown>;
		const input = num(usage.input);
		const output = num(usage.output);
		const cacheRead = num(usage.cacheRead);
		const cacheWrite = num(usage.cacheWrite);
		// Aborted and failed replies carry empty usage.
		if (!input && !output && !cacheRead && !cacheWrite) continue;
		const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp));
		if (!Number.isFinite(time) || time < since) continue;
		const day = dayOf(time);
		const provider = str(message.provider);
		const model = str(message.model);
		const key = `${day}\n${provider}\n${model}`;
		const bucket = into.get(key) ?? { day, provider, model, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		bucket.responses += 1;
		bucket.input += input;
		bucket.output += output;
		bucket.cacheRead += cacheRead;
		bucket.cacheWrite += cacheWrite;
		bucket.cost += num((usage.cost as Record<string, unknown> | undefined)?.total);
		into.set(key, bucket);
	}
}

async function stamp(path: string): Promise<FileStamp | undefined> {
	try {
		const { size, mtimeMs } = await stat(path);
		return { path, size, mtimeMs };
	} catch {
		return undefined;
	}
}

/** Every .jsonl file under a folder, at any depth; none when there is no folder. */
async function filesUnder(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return filesUnder(path);
			return Promise.resolve(entry.name.endsWith(".jsonl") ? [path] : []);
		}),
	);
	return nested.flat().sort();
}

/** The session's own file and its subagents' files, or none when the session hasn't been saved. */
async function sessionFiles(path: string): Promise<FileStamp[]> {
	const own = await stamp(path);
	if (!own) return [];
	const children = await filesUnder(join(dirname(path), basename(path, ".jsonl")));
	const stamps = await Promise.all(children.map(stamp));
	return [own, ...stamps.filter((file) => file !== undefined)];
}

async function count(files: FileStamp[]): Promise<UsageBucket[]> {
	const buckets = new Map<string, UsageBucket>();
	for (const file of files) {
		try {
			countReplies(await readFile(file.path, "utf8"), buckets);
		} catch {
			// A file removed while counting adds nothing.
		}
	}
	return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await run(items[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class UsageCounter {
	private cache?: Map<string, Counted>;
	private readonly cacheFile: string;

	constructor(cacheFile: string) {
		this.cacheFile = cacheFile;
	}

	/** Usage for the sessions given; `isPlan` tells which providers are logged in through a subscription. */
	async report(sessions: SessionSummary[], isPlan: (provider: string) => boolean, now = new Date()): Promise<UsageReport> {
		const cache = await this.load();
		const counted = new Map<string, Counted>();
		let changed = false;
		await eachLimited(sessions, CONCURRENT, async (session) => {
			const files = await sessionFiles(session.path);
			if (!files.length) return;
			const signature = files.map((file) => `${file.path}\t${file.size}\t${file.mtimeMs}`).join("\n");
			let entry = cache.get(session.path);
			if (entry?.signature !== signature) {
				entry = { signature, buckets: await count(files) };
				changed = true;
			}
			counted.set(session.path, entry);
		});
		// Deleted sessions drop out of the cache, and so out of the totals.
		if (changed || [...cache.keys()].some((path) => !counted.has(path))) await this.save(counted);
		this.cache = counted;
		const used: SessionUsage[] = sessions.flatMap(({ path, title, app, cwd, chat }) => {
			const buckets = counted.get(path)?.buckets;
			return buckets?.length ? [{ path, title, app, cwd, chat, buckets }] : [];
		});
		const providers = new Set(used.flatMap((session) => session.buckets.map((bucket) => bucket.provider)));
		return { sessions: used, plans: [...providers].filter(isPlan), today: dayOf(now) };
	}

	private async load(): Promise<Map<string, Counted>> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(await readFile(this.cacheFile, "utf8")) as { version?: number; sessions?: Record<string, Counted> };
			if (parsed.version === CACHE_VERSION && parsed.sessions) return (this.cache = new Map(Object.entries(parsed.sessions)));
		} catch {
			// No cache yet, or a damaged one: everything is counted again.
		}
		return (this.cache = new Map());
	}

	private async save(counted: Map<string, Counted>): Promise<void> {
		try {
			await mkdir(dirname(this.cacheFile), { recursive: true });
			const tmp = `${this.cacheFile}.tmp`;
			await writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, sessions: Object.fromEntries(counted) }));
			await rename(tmp, this.cacheFile);
		} catch {
			// The cache only saves time; without it the next visit counts again.
		}
	}
}
