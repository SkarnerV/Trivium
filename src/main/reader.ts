import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ReaderFile, ReaderKind } from "../shared/protocol.ts";
import { t } from "../shared/i18n.ts";

/** The scheme the Preview panel's frames load files from, one token per open file. */
export const READER_SCHEME = "trivium-file";

/** Text past this is left out, with a note: a huge log would stall the panel. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Enough of the start of a file to tell text from binary. */
const SNIFF_BYTES = 8192;
/** Saving a file often writes it several times in a row; the panel reloads once. */
const WATCH_MS = 150;

const KINDS: [RegExp, ReaderKind][] = [
	[/\.(html?|xhtml)$/i, "html"],
	[/\.(md|markdown|mdx)$/i, "markdown"],
	// An SVG shows through <img>, where its scripts never run.
	[/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i, "image"],
	[/\.pdf$/i, "pdf"],
	[/\.(csv|tsv)$/i, "table"],
];

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".xhtml": "application/xhtml+xml",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".txt": "text/plain; charset=utf-8",
	".csv": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
};

/** How the panel shows a file: by its extension, else text unless its first bytes look binary. */
export function readerKind(name: string, head: Uint8Array): ReaderKind {
	const known = KINDS.find(([pattern]) => pattern.test(name));
	if (known) return known[1];
	return looksBinary(head) ? "binary" : "text";
}

/** A NUL byte, or bytes that are not UTF-8, mean the file is not text. */
export function looksBinary(head: Uint8Array): boolean {
	if (head.includes(0)) return true;
	try {
		// The sniffed bytes may end partway through a character.
		new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, trimPartial(head)));
		return false;
	} catch {
		return true;
	}
}

/** The length of the bytes without a multi-byte character cut off at the end. */
function trimPartial(bytes: Uint8Array): number {
	let end = bytes.length;
	for (let back = 1; back <= 3 && back <= bytes.length; back++) {
		const byte = bytes[bytes.length - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (width > back) end = bytes.length - back;
		break;
	}
	return end;
}

export function contentType(name: string): string {
	return TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * What a previewed page may load: files beside it, never the network. Scripts only when the user turns them
 * on for that page, and even then they cannot fetch or post anything.
 */
export function readerCsp(scripts: boolean): string {
	const self = `${READER_SCHEME}:`;
	return [
		`default-src ${self} data: blob:`,
		`script-src ${scripts ? `${self} 'unsafe-inline'` : "'none'"}`,
		`style-src ${self} data: 'unsafe-inline'`,
		`img-src ${self} data: blob:`,
		`font-src ${self} data:`,
		`media-src ${self} data: blob:`,
		"connect-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
	].join("; ");
}

/** Whether `target` is `root` or inside it. Both must already be resolved; Windows paths compare without case. */
export function isInside(root: string, target: string): boolean {
	const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
	const rel = relative(fold(root), fold(target));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The file a request asks for, if it is inside the root after following links. */
export async function resolveRequest(root: string, pathname: string): Promise<string | undefined> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
	// A NUL or a backslash has no business in a URL path, and would be read differently on disk.
	if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
	const target = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
	if (!isInside(root, target)) return undefined;
	try {
		const real = await realpath(target);
		return isInside(root, real) ? real : undefined;
	} catch {
		return undefined;
	}
}

interface Entry {
	id: string;
	file: string;
	/** The folder this file's page may load from: its project, or its own folder. */
	root: string;
	/** How the panel names it: relative to the project when inside it. */
	rel: string;
	scripts: boolean;
	watcher?: FSWatcher;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Files open in the Preview panel. Each has a random token that its URLs carry, so a page can only ever load
 * from the folder it was opened with, and closing it stops its URLs from working.
 */
export class ReaderStore {
	private entries = new Map<string, Entry>();
	private onChange: (id: string) => void;

	/** `onChange` hears of a file that changed on disk, by its id. */
	constructor(onChange: (id: string) => void) {
		this.onChange = onChange;
	}

	/** Opens a file the caller has already allowed, serving pages from `root`. */
	async open(file: string, root: string, rel: string): Promise<ReaderFile> {
		return this.describe(this.add({ id: newId(), file, root, rel, scripts: false }));
	}

	async reload(id: string): Promise<ReaderFile> {
		return this.describe(this.require(id));
	}

	/** Reissues the file under a new token, so the frame loads again with the new rules. */
	async setScripts(id: string, scripts: boolean): Promise<ReaderFile> {
		const entry = this.require(id);
		this.close(id);
		return this.describe(this.add({ id: newId(), file: entry.file, root: entry.root, rel: entry.rel, scripts }));
	}

	close(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		entry.watcher?.close();
		this.entries.delete(id);
	}

	dispose(): void {
		for (const id of [...this.entries.keys()]) this.close(id);
	}

	/** Serves a trivium-file request: only files inside the token's root, never a listing. */
	async respond(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const entry = this.entries.get(url.host);
		const file = entry && (await resolveRequest(entry.root, url.pathname));
		if (!entry || !file) return new Response("Not found", { status: 404 });
		try {
			const info = await stat(file);
			if (!info.isFile()) return new Response("Not found", { status: 404 });
			return new Response(await readFile(file), {
				headers: {
					"Content-Type": contentType(file),
					"Content-Security-Policy": readerCsp(entry.scripts),
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "no-store",
				},
			});
		} catch {
			return new Response("Not found", { status: 404 });
		}
	}

	private add(entry: Entry): Entry {
		this.entries.set(entry.id, entry);
		// Watch the folder, not the file: editors and the agent often save by replacing it.
		try {
			const name = basename(entry.file);
			entry.watcher = watch(dirname(entry.file), (_event, changed) => {
				if (changed && changed.toString() !== name) return;
				clearTimeout(entry.timer);
				entry.timer = setTimeout(() => this.entries.has(entry.id) && this.onChange(entry.id), WATCH_MS);
			});
			entry.watcher.on("error", () => entry.watcher?.close());
		} catch {
			// Without a watcher, the panel still reloads when asked.
		}
		return entry;
	}

	private require(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(t("That file is no longer open."));
		return entry;
	}

	private async describe(entry: Entry): Promise<ReaderFile> {
		const info = await stat(entry.file).catch(() => undefined);
		if (!info?.isFile()) throw new Error(t("{file} is gone.", { file: entry.rel }));
		const head = await readHead(entry.file, Math.min(info.size, SNIFF_BYTES));
		const kind = readerKind(entry.file, head);
		const base: ReaderFile = {
			id: entry.id,
			path: entry.file,
			rel: entry.rel,
			name: basename(entry.file),
			kind,
			size: info.size,
			mtime: info.mtimeMs,
			scripts: entry.scripts,
		};
		if (kind === "html" || kind === "image" || kind === "pdf") {
			const path = relative(entry.root, entry.file).split(sep).map(encodeURIComponent).join("/");
			// The modified time keeps the frame from showing an old copy after the file changes.
			base.url = `${READER_SCHEME}://${entry.id}/${path}?v=${Math.round(info.mtimeMs)}`;
		}
		// A page's text is its source view.
		if (kind === "binary" || kind === "image" || kind === "pdf") return base;
		const { text, truncated } = await readText(entry.file, info.size);
		return { ...base, text, truncated };
	}
}

/** Lower-case hex: a standard scheme's host is case-insensitive. */
function newId(): string {
	return randomUUID().replaceAll("-", "");
}

async function readHead(file: string, length: number): Promise<Uint8Array> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** The file's text, cut at the last whole line before the limit. */
async function readText(file: string, size: number): Promise<{ text: string; truncated: boolean }> {
	if (size <= MAX_TEXT_BYTES) return { text: await readFile(file, "utf8"), truncated: false };
	const head = await readHead(file, MAX_TEXT_BYTES);
	const text = new TextDecoder().decode(head.subarray(0, trimPartial(head)));
	const cut = text.lastIndexOf("\n");
	return { text: cut > 0 ? text.slice(0, cut) : text, truncated: true };
}
