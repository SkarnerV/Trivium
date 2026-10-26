import { useEffect, useMemo, useState } from "react";
import type { FileChange, SessionView } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { CloseIcon, ExternalIcon, PenIcon } from "../icons.tsx";
import { attempt, setState, startSession, trivium } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { Resizer } from "./Resizer.tsx";

const isNote = (change: FileChange) => /\.(md|markdown|mdx|txt)$/i.test(change.path) && change.status !== "deleted";

interface Source {
	url: string;
	title: string;
	host: string;
}

/** Every link in the note, in order of first appearance. Numbered citations like [1] take the URL as their title. */
function sourcesOf(text: string): Source[] {
	const seen = new Map<string, Source>();
	const add = (url: string, label?: string) => {
		const clean = url.replace(/[.,;:]+$/, "");
		if (seen.has(clean)) return;
		let host = clean;
		try {
			const parsed = new URL(clean);
			host = parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
		} catch {
			// Not a URL after all; keep the raw text.
		}
		const title = label && !/^\d+$/.test(label.trim()) ? label.trim() : host;
		seen.set(clean, { url: clean, title, host });
	};
	for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|<?(https?:\/\/[^\s)>\]]+)/g)) {
		if (match[2]) add(match[2], match[1]);
		else if (match[3]) add(match[3]);
	}
	return [...seen.values()];
}

/** The Research app's side panel: the notes this session wrote, rendered, with their sources. */
export function NotePanel({ view }: { view: SessionView }) {
	const notes = view.changes.filter(isNote);
	const [selected, setSelected] = useState<string>();
	const [tab, setTab] = useState<"preview" | "sources">("preview");
	const [content, setContent] = useState("");
	const note = notes.find((n) => n.path === selected) ?? notes[0];
	// Reload when the note changes on disk; the diff counts change with every edit.
	const version = note ? `${note.path}:${note.adds}:${note.dels}:${note.lines.length}` : "";

	useEffect(() => {
		if (!note) return;
		let current = true;
		void attempt(() => trivium.readChangedFile(view.path, note.path)).then((text) => current && text !== undefined && setContent(text));
		return () => {
			current = false;
		};
	}, [view.path, version]);

	const sources = useMemo(() => sourcesOf(content), [content]);
	if (!note) return null;

	const openInWrite = async () => {
		await startSession({ app: "write", cwd: view.cwd }, `Revise ${note.rel}: `);
	};

	return (
		<aside className="side-panel note-panel" aria-label="Note preview">
			<Resizer target="panel" />
			<div className="side-head">
				<h2 className="mono">{baseName(note.rel)}</h2>
				<div className="seg" role="tablist" aria-label="Note view">
					<button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>
						Preview
					</button>
					<button type="button" role="tab" aria-selected={tab === "sources"} onClick={() => setTab("sources")}>
						Sources {sources.length}
					</button>
				</div>
				<button
					type="button"
					className="icon-btn"
					aria-label="Hide note"
					title="Hide note"
					onClick={() => setState((s) => ({ changesHidden: { ...s.changesHidden, [view.path]: true } }))}
				>
					<CloseIcon size={13} />
				</button>
			</div>
			{notes.length > 1 && (
				<div className="chips" role="tablist" aria-label="Notes">
					{notes.map((n) => (
						<button key={n.path} type="button" role="tab" className="chip" aria-selected={n === note} title={n.rel} onClick={() => setSelected(n.path)}>
							{baseName(n.rel)}
						</button>
					))}
				</div>
			)}
			<div className="side-body">
				{tab === "preview" ? (
					<article className="doc answer">
						<Markdown text={content} />
					</article>
				) : sources.length ? (
					<ol className="sources">
						{sources.map((source) => (
							<li key={source.url}>
								<a href={source.url} target="_blank" rel="noreferrer">
									{source.title}
								</a>
								<div className="mono host">{source.host}</div>
							</li>
						))}
					</ol>
				) : (
					<p className="side-empty">This note has no links yet. Ask the agent to cite its sources.</p>
				)}
			</div>
			<div className="side-foot">
				<button type="button" className="btn primary" style={{ flex: 1 }} onClick={() => void openInWrite()}>
					<PenIcon size={13} />
					Open in Write
				</button>
				<button type="button" className="btn" onClick={() => void attempt(() => trivium.openFile(note.path))} title="Open with its default app">
					<ExternalIcon size={13} />
					Open file
				</button>
			</div>
		</aside>
	);
}
