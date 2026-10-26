import { useEffect, useRef, useState } from "react";
import type { AttachmentInfo } from "../../shared/protocol.ts";
import { CloseIcon, FileIcon } from "../icons.tsx";
import { attempt, trivium } from "../store.ts";

function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The message box's attachments. Files with a path on disk go to the main process by path;
 * pasted or dragged-in images without one are sent as data. Unsent attachments are released
 * when the message box goes away.
 */
export function useAttachments() {
	const [items, setItems] = useState<AttachmentInfo[]>([]);
	const [pending, setPending] = useState(0);
	const current = useRef(items);
	current.current = items;

	useEffect(
		() => () => {
			if (current.current.length) void trivium.dropAttachments(current.current.map((item) => item.id));
		},
		[],
	);

	const add = async (load: () => Promise<AttachmentInfo[] | undefined>) => {
		setPending((n) => n + 1);
		const added = await attempt(load);
		setPending((n) => n - 1);
		if (added?.length) setItems((list) => [...list, ...added]);
	};

	const addFiles = (files: File[]) => {
		const paths = files.map((file) => trivium.pathForFile(file)).filter(Boolean);
		if (paths.length) void add(() => trivium.attachPaths(paths));
		for (const file of files) {
			if (trivium.pathForFile(file) || !file.type.startsWith("image/")) continue;
			const name = file.name || `Pasted image.${file.type.split("/")[1] ?? "png"}`;
			void add(async () => [await trivium.attachImageData(name, file.type, await readAsBase64(file))]);
		}
	};

	const remove = (id: string) => {
		setItems((list) => list.filter((item) => item.id !== id));
		void trivium.dropAttachments([id]);
	};

	/** Hands the attachments over for sending; they are cleared from the box. */
	const takeIds = () => {
		const ids = items.map((item) => item.id);
		setItems([]);
		return ids;
	};

	/** Puts these in the box in place of what it holds, such as an earlier message's attachments. */
	const replace = (list: AttachmentInfo[]) => {
		const dropped = current.current.filter((item) => !list.some((next) => next.id === item.id));
		if (dropped.length) void trivium.dropAttachments(dropped.map((item) => item.id));
		setItems(list);
	};

	return { items, pending, pick: () => void add(() => trivium.pickAttachments()), addFiles, remove, takeIds, restore: setItems, replace };
}

export function AttachmentChips({
	items,
	pending,
	warning,
	onRemove,
}: {
	items: AttachmentInfo[];
	pending: number;
	warning?: string;
	onRemove: (id: string) => void;
}) {
	if (!items.length && !pending) return null;
	return (
		<div className="attach-row">
			{items.map((item) => (
				<div key={item.id} className={`attach-chip ${item.kind}`} title={item.note ? `${item.name} · ${item.note}` : item.name}>
					{item.preview ? <img src={item.preview} alt="" /> : <span className="attach-icon"><FileIcon size={14} /></span>}
					<span className="attach-text">
						<span className="ellipsis">{item.name}</span>
						<span className="attach-size">{formatSize(item.size)}</span>
					</span>
					<button type="button" className="attach-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}>
						<CloseIcon size={10} />
					</button>
				</div>
			))}
			{pending > 0 && <div className="attach-chip loading">Preparing…</div>}
			{warning && <div className="attach-warning">{warning}</div>}
		</div>
	);
}
