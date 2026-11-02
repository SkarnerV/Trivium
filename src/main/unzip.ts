import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { t } from "../shared/i18n.ts";

/** Enough for any skill; an archive past these is refused rather than filling the disk. */
const MAX_ENTRIES = 2000;
const MAX_BYTES = 100 * 1024 * 1024;

/**
 * Extracts a zip archive into `dir`: stored and deflated entries, which is what every zip tool writes for a
 * skill. Entries that would land outside `dir` are refused.
 */
export async function unzip(file: string, dir: string): Promise<void> {
	const zip = await readFile(file);
	// The end-of-central-directory record sits in the last 22 bytes, plus a comment of up to 64 KiB.
	let end = -1;
	for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
		if (zip.readUInt32LE(at) === 0x06054b50) {
			end = at;
			break;
		}
	}
	if (end < 0) throw new Error(t("That file isn't a zip archive."));
	const count = zip.readUInt16LE(end + 10);
	if (count > MAX_ENTRIES) throw new Error(t("That archive has too many files for a skill."));
	let at = zip.readUInt32LE(end + 16);
	let total = 0;
	const root = resolve(dir);
	for (let index = 0; index < count; index++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(t("That zip archive is damaged."));
		const method = zip.readUInt16LE(at + 10);
		const compressed = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLength).replace(/\\/g, "/");
		at += 46 + nameLength + extraLength + commentLength;
		// macOS adds resource forks under __MACOSX; they are not part of the skill.
		if (name.startsWith("__MACOSX/")) continue;
		const target = resolve(root, name);
		if (target !== root && !target.startsWith(root + sep)) throw new Error(t("That archive has files that point outside it."));
		if (name.endsWith("/")) {
			await mkdir(target, { recursive: true });
			continue;
		}
		total += size;
		if (total > MAX_BYTES) throw new Error(t("That archive is too large for a skill."));
		const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const data = zip.subarray(start, start + compressed);
		let contents: Buffer;
		if (method === 0) contents = data;
		else if (method === 8) contents = inflateRawSync(data, { maxOutputLength: MAX_BYTES });
		else throw new Error(t("That zip archive uses a compression Trivium can't read."));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
}
