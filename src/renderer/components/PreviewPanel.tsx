import { useMemo, useState } from "react";
import type { ReaderFile } from "../../shared/protocol.ts";
import { fileSize, relativeTime } from "../format.ts";
import { CloseIcon, CodeIcon, CopyIcon, ExternalIcon, EyeIcon, FileIcon, ShieldIcon, UndoIcon } from "../icons.tsx";
import { attempt, closePreview, pickPreview, reloadPreview, selectPreview, setPreviewScripts, trivium } from "../store.ts";
import type { MenuEntry } from "./ContextMenu.tsx";
import { parseTable } from "../preview.ts";
import { Markdown } from "./Markdown.tsx";

/** Pages and Markdown have a rendered view and their source to switch between. */
export function hasSource(file: ReaderFile): boolean {
	return (file.kind === "html" || file.kind === "markdown") && file.text !== undefined;
}

/** The open files, as tabs in the panel's head. */
export function PreviewTabs({ path, files, active }: { path: string; files: ReaderFile[]; active: string | undefined }) {
	return (
		<div className="preview-tabs" role="tablist" aria-label="Open files">
			{files.map((file) => (
				<div key={file.id} className="preview-tab" aria-current={file.id === active} title={file.rel}>
					<button type="button" role="tab" aria-selected={file.id === active} className="preview-tab-name" onClick={() => selectPreview(path, file.id)}>
						{file.name}
					</button>
					<button type="button" className="preview-tab-close" aria-label={`Close ${file.name}`} title="Close" onClick={() => closePreview(path, file.id)}>
						<CloseIcon size={10} width={2.4} />
					</button>
				</div>
			))}
		</div>
	);
}

/** What the "More" button offers for the file showing. */
export function previewMenu(path: string, file: ReaderFile | undefined): MenuEntry[] {
	const entries: MenuEntry[] = [];
	if (file) {
		entries.push(
			{ label: "Open in VS Code", icon: <CodeIcon size={14} />, onSelect: () => void attempt(() => trivium.openInEditor(file.path)) },
			{ label: "Open with default app", icon: <ExternalIcon size={14} />, onSelect: () => void attempt(() => trivium.openFile(file.path)) },
			{ label: "Copy path", icon: <CopyIcon size={14} />, onSelect: () => void attempt(() => trivium.copyText(file.path)) },
			{ label: "Reload", icon: <UndoIcon size={14} />, onSelect: () => void reloadPreview(file.id) },
		);
		if (file.kind === "html" && file.scripts) {
			entries.push({ label: "Turn scripts off", icon: <ShieldIcon size={14} />, onSelect: () => void setPreviewScripts(file.id, false) });
		}
		entries.push("separator");
	}
	entries.push({ label: "Choose a file to preview", icon: <FileIcon size={14} />, onSelect: () => void pickPreview(path) });
	return entries;
}

/** The Preview view's body: the file showing, edge to edge, or how to open one. */
export function PreviewBody({ path, file, source }: { path: string; file: ReaderFile | undefined; source: boolean }) {
	if (!file) {
		return (
			<div className="preview-empty">
				<span className="panel-empty-icon">
					<EyeIcon size={18} />
				</span>
				<h3>Preview a file</h3>
				<p>Click a file path in the conversation, or the eye on a changed file. HTML, Markdown, images, PDFs and text open here.</p>
				<button type="button" className="btn" onClick={() => void pickPreview(path)}>
					Choose a file
				</button>
			</div>
		);
	}
	return (
		<div className="preview-body" role="tabpanel" aria-label={file.rel}>
			{file.kind === "html" && !file.scripts && !source && (
				<div className="preview-strip" role="status">
					<ShieldIcon size={14} />
					<span>Scripts are off for this page.</span>
					<button type="button" className="btn" onClick={() => void setPreviewScripts(file.id, true)}>
						Run scripts
					</button>
				</div>
			)}
			<FileView file={file} source={source} />
			{file.truncated && <p className="preview-note">Showing the start of this {fileSize(file.size)} file. Open it to read the rest.</p>}
		</div>
	);
}

function FileView({ file, source }: { file: ReaderFile; source: boolean }) {
	if (source && file.text !== undefined) return <TextView text={file.text} />;
	switch (file.kind) {
		case "html":
			// No allow-same-origin: the page gets an opaque origin and cannot reach Trivium. Links that open a
			// new window go to the browser.
			return (
				<iframe
					key={file.url}
					className="preview-frame"
					src={file.url}
					title={file.name}
					sandbox={`${file.scripts ? "allow-scripts " : ""}allow-popups allow-popups-to-escape-sandbox`}
				/>
			);
		case "pdf":
			// Chromium's PDF viewer is a plugin, which a sandboxed frame would block. It runs no page script.
			return <iframe key={file.url} className="preview-frame" src={file.url} title={file.name} />;
		case "markdown":
			return (
				<div className="preview-scroll">
					<article className="doc answer">
						<Markdown text={file.text ?? ""} />
					</article>
				</div>
			);
		case "image":
			return <ImageView file={file} />;
		case "table":
			return <TableView text={file.text ?? ""} tabs={/\.tsv$/i.test(file.name)} />;
		case "text":
			return <TextView text={file.text ?? ""} />;
		default:
			return (
				<div className="preview-empty">
					<span className="panel-empty-icon">
						<FileIcon size={18} />
					</span>
					<h3>Can't preview this file</h3>
					<p>
						{fileSize(file.size)}, changed {relativeTime(file.mtime) === "now" ? "just now" : `${relativeTime(file.mtime)} ago`}.
					</p>
					<button type="button" className="btn" onClick={() => void attempt(() => trivium.openFile(file.path))}>
						Open with default app
					</button>
				</div>
			);
	}
}

function ImageView({ file }: { file: ReaderFile }) {
	const [size, setSize] = useState<{ url?: string; text: string }>();
	return (
		<>
			<div className="preview-image">
				<img
					key={file.url}
					src={file.url}
					alt={file.name}
					onLoad={(event) => setSize({ url: file.url, text: `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}` })}
				/>
			</div>
			<p className="preview-note">
				{size && size.url === file.url ? `${size.text} · ` : ""}
				{fileSize(file.size)}
			</p>
		</>
	);
}

/** Text with line numbers: two columns of preformatted text, quick even for a long log. */
function TextView({ text }: { text: string }) {
	const numbers = useMemo(() => {
		const lines = text.split("\n");
		const count = Math.max(1, lines.length - (lines.at(-1) === "" ? 1 : 0));
		return Array.from({ length: count }, (_, index) => index + 1).join("\n");
	}, [text]);
	return (
		<div className="preview-scroll">
			<div className="preview-text">
				<pre className="preview-gutter" aria-hidden="true">
					{numbers}
				</pre>
				<pre className="preview-code">{text}</pre>
			</div>
		</div>
	);
}

function TableView({ text, tabs }: { text: string; tabs: boolean }) {
	const { rows, more } = useMemo(() => parseTable(text, tabs ? "\t" : ","), [text, tabs]);
	const [head = [], ...body] = rows;
	const columns = Math.max(0, ...rows.map((row) => row.length));
	return (
		<div className="preview-scroll">
			<table className="preview-table">
				<thead>
					<tr>
						{Array.from({ length: columns }, (_, index) => (
							<th key={index}>{head[index] ?? ""}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((row, r) => (
						<tr key={r}>
							{Array.from({ length: columns }, (_, c) => (
								<td key={c}>{row[c] ?? ""}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			<p className="preview-note">
				{more ? `Showing the first ${body.length.toLocaleString()} rows` : `${body.length.toLocaleString()} ${body.length === 1 ? "row" : "rows"}`} ·{" "}
				{columns} {columns === 1 ? "column" : "columns"}
			</p>
		</div>
	);
}
