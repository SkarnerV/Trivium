import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	convertToPng,
	detectSupportedImageMimeTypeFromFile,
	formatDimensionNote,
	resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { AttachmentInfo } from "../shared/protocol.ts";
import type { MessageFile } from "./transcript.ts";

/** Larger text files are refused: they would crowd out the conversation. */
const MAX_TEXT_BYTES = 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const CONVERTIBLE_IMAGE = /\.(heic|heif|bmp|tiff?|avif)$/i;

interface Prepared {
	info: AttachmentInfo;
	/** The name pi sees in the <file> tag: the absolute path for files from disk. */
	label: string;
	image?: ImageContent;
	hints: string[];
	text?: string;
}

/**
 * Prepares attachments in the main process the way pi's CLI prepares file arguments:
 * images converted to a supported type and resized to provider limits, text files read whole.
 * The renderer only keeps the summary and a preview; the content stays here until sent.
 */
export class AttachmentStore {
	private items = new Map<string, Prepared>();

	async fromPaths(paths: string[]): Promise<AttachmentInfo[]> {
		const infos: AttachmentInfo[] = [];
		for (const path of paths) {
			const stats = await stat(path);
			if (stats.isDirectory()) throw new Error(`${basename(path)} is a folder. Attach files instead.`);
			const mimeType = await detectSupportedImageMimeTypeFromFile(path);
			if (mimeType || CONVERTIBLE_IMAGE.test(path)) {
				const bytes = await readFile(path);
				infos.push(await this.addImage(basename(path), path, bytes, mimeType ?? imageTypeFromExtension(path), stats.size));
				continue;
			}
			if (stats.size > MAX_TEXT_BYTES) throw new Error(`${basename(path)} is larger than 1 MB. Attach a smaller file.`);
			const bytes = await readFile(path);
			if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${basename(path)} is not a text file or a supported image.`);
			const text = bytes.toString("utf8").replace(/^﻿/, "");
			const info: AttachmentInfo = { id: randomUUID(), name: basename(path), kind: "file", size: stats.size };
			this.items.set(info.id, { info, label: path, hints: [], text });
			infos.push(info);
		}
		return infos;
	}

	/** A pasted or dragged image that has no file on disk. */
	fromImageData(name: string, mimeType: string, base64: string): Promise<AttachmentInfo> {
		const bytes = Buffer.from(base64, "base64");
		return this.addImage(name, name, bytes, mimeType, bytes.length);
	}

	private async addImage(name: string, label: string, bytes: Buffer, mimeType: string, size: number): Promise<AttachmentInfo> {
		let data = bytes;
		let type = mimeType;
		const hints: string[] = [];
		if (!INLINE_IMAGE_TYPES.has(type)) {
			const png = await convertToPng(bytes.toString("base64"), type);
			if (!png) throw new Error(`${name} could not be converted to an image the model can read.`);
			hints.push(`[Image converted from ${type} to ${png.mimeType}.]`);
			data = Buffer.from(png.data, "base64");
			type = png.mimeType;
		}
		const resized = await resizeImage(new Uint8Array(data), type);
		if (!resized) throw new Error(`${name} is too large to send, even after resizing.`);
		const note = formatDimensionNote(resized);
		if (note) hints.push(note);
		const image: ImageContent = { type: "image", data: resized.data, mimeType: resized.mimeType };
		const info: AttachmentInfo = {
			id: randomUUID(),
			name,
			kind: "image",
			size,
			preview: `data:${resized.mimeType};base64,${resized.data}`,
			note: resized.wasResized ? `Resized to ${resized.width}×${resized.height}` : undefined,
		};
		this.items.set(info.id, { info, label, image, hints });
		return info;
	}

	/** Files a sent message carried, ready to send again as they were. Images whose data is gone are left out. */
	fromMessage(files: MessageFile[]): AttachmentInfo[] {
		const infos: AttachmentInfo[] = [];
		for (const file of files) {
			const name = basename(file.label);
			if (file.text !== undefined) {
				const info: AttachmentInfo = { id: randomUUID(), name, kind: "file", size: Buffer.byteLength(file.text) };
				this.items.set(info.id, { info, label: file.label, hints: [], text: file.text });
				infos.push(info);
			} else if (file.image) {
				const { data, mimeType } = file.image;
				const info: AttachmentInfo = {
					id: randomUUID(),
					name,
					kind: "image",
					size: Math.floor((data.length * 3) / 4),
					preview: `data:${mimeType};base64,${data}`,
				};
				const image: ImageContent = { type: "image", data, mimeType };
				this.items.set(info.id, { info, label: file.label, image, hints: file.note ? [file.note] : [] });
				infos.push(info);
			}
		}
		return infos;
	}

	drop(ids: string[]): void {
		for (const id of ids) this.items.delete(id);
	}

	/**
	 * What to send for these attachments: `<file>` tags in front of the message, as pi's CLI
	 * writes them, and the images. They stay stored until dropped, so a failed send keeps them.
	 */
	build(ids: string[]): { prefix: string; images: ImageContent[] } {
		let prefix = "";
		const images: ImageContent[] = [];
		for (const id of ids) {
			const item = this.items.get(id);
			if (!item) throw new Error("An attachment expired. Attach it again.");
			if (item.image) {
				images.push(item.image);
				prefix += `<file name="${item.label}">${item.hints.join("\n")}</file>\n`;
			} else {
				prefix += `<file name="${item.label}">\n${item.text}\n</file>\n`;
			}
		}
		return { prefix, images };
	}
}

function imageTypeFromExtension(path: string): string {
	const ext = extname(path).slice(1).toLowerCase();
	return ext === "tif" ? "image/tiff" : ext === "heif" ? "image/heic" : `image/${ext}`;
}
