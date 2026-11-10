import { useEffect, useRef, useState } from "react";
import { DownloadIcon, ExpandIcon, ImageIcon, PanelRightIcon } from "../icons.tsx";
import { attempt, errorText, notify, openDiagramPreview, setState as setStore, trivium } from "../store.ts";
import { type DrawnDiagram, usePreviewSession } from "../preview.ts";
import { t } from "../i18n.tsx";
import { ContextMenu } from "./ContextMenu.tsx";

export type DiagramLanguage = "mermaid" | "plantuml";

/** The diagram language a fenced block's info string names, if any. */
export function diagramLanguage(info: string): DiagramLanguage | undefined {
	const name = info.trim().split(/\s+/)[0]?.toLowerCase();
	if (name === "mermaid") return "mermaid";
	if (name === "plantuml" || name === "puml" || name === "uml") return "plantuml";
	return undefined;
}

// Mermaid is large, so it loads the first time a document has a Mermaid diagram.
let mermaid: Promise<typeof import("mermaid").default> | undefined;
let renders = 0;

function loadMermaid() {
	mermaid ??= import("mermaid").then(({ default: api }) => {
		// Strict: no scripts or click handlers in the diagram, and labels sanitized.
		api.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "default" });
		return api;
	});
	return mermaid;
}

async function renderMermaid(code: string): Promise<string> {
	const api = await loadMermaid();
	const id = `mermaid-${++renders}`;
	try {
		return (await api.render(id, code)).svg;
	} finally {
		// Mermaid measures in a hidden element of its own, which a failed render can leave behind.
		document.getElementById(`d${id}`)?.remove();
	}
}

/**
 * The diagram as a standalone SVG image: well-formed XML, with a pixel size from its viewBox. It shows through
 * <img>, so it never runs script or reaches the page.
 */
function asImage(svg: string): string {
	const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
	if (!root) throw new Error(t("The diagram came back empty."));
	const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
	if (box?.length === 4 && box.every(Number.isFinite)) {
		root.setAttribute("width", String(box[2]));
		root.setAttribute("height", String(box[3]));
		root.style.removeProperty("max-width");
	}
	root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

/** Rendered diagrams by language and code, so a reload or another view of the same document draws at once. */
const drawn = new Map<string, Promise<string>>();

function draw(language: DiagramLanguage, code: string): Promise<string> {
	const key = `${language}\n${code}`;
	let result = drawn.get(key);
	if (!result) {
		result = (language === "mermaid" ? renderMermaid(code) : trivium.renderPlantUml(code)).then(asImage);
		drawn.set(key, result);
		if (drawn.size > 64) drawn.delete(drawn.keys().next().value!);
		// PlantUML may be installed by the next try.
		result.catch(() => drawn.delete(key));
	}
	return result;
}

/** The diagram's SVG text, from the image URL `asImage` made. */
function svgText(src: string): string {
	return decodeURIComponent(src.slice(src.indexOf(",") + 1));
}

/** Room around the diagram in a PNG, as it has in the thread. */
const PNG_MARGIN = 16;
/** Chromium draws nothing on a canvas wider or taller than this. */
const MAX_CANVAS = 8192;

/** The diagram as PNG bytes in base64: twice its size so it stays sharp on a slide, on white. */
async function pngData(src: string): Promise<string> {
	const image = new Image();
	image.src = src;
	await image.decode();
	const width = image.naturalWidth + PNG_MARGIN * 2;
	const height = image.naturalHeight + PNG_MARGIN * 2;
	const scale = Math.min(2, MAX_CANVAS / Math.max(width, height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	const context = canvas.getContext("2d");
	if (!context) throw new Error(t("Couldn't make a PNG of this diagram."));
	context.fillStyle = "#fff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(image, PNG_MARGIN * scale, PNG_MARGIN * scale, image.naturalWidth * scale, image.naturalHeight * scale);
	const url = canvas.toDataURL("image/png");
	return url.slice(url.indexOf(",") + 1);
}

/** Asks where to save a drawn diagram, as an SVG or a PNG, and says where it went. */
export async function saveDiagram(diagram: Pick<DrawnDiagram, "src" | "name">, format: "svg" | "png"): Promise<void> {
	const saved = await attempt(async () =>
		trivium.saveDiagram(diagram.name, format, format === "png" ? await pngData(diagram.src) : svgText(diagram.src)),
	);
	if (saved) notify(t("Saved {name}", { name: saved.split(/[\\/]/).pop()! }), "info");
}

/** The two ways to download a diagram, for a menu. */
export function downloadEntries(diagram: Pick<DrawnDiagram, "src" | "name">) {
	return [
		{ label: t("Download SVG"), icon: <DownloadIcon size={14} />, onSelect: () => void saveDiagram(diagram, "svg") },
		{ label: t("Download PNG"), icon: <ImageIcon size={14} />, onSelect: () => void saveDiagram(diagram, "png") },
	];
}

/** A drawn diagram in the conversation or a document: a click opens it large; hovering shows what else it can do. */
function DrawnFigure({ diagram }: { diagram: DrawnDiagram }) {
	// In the conversation, the session whose Preview panel it can open in beside it.
	const session = usePreviewSession();
	const [menu, setMenu] = useState<{ x: number; y: number }>();
	// A click on Download closes its menu on mousedown; the click that follows must not open it again.
	const closed = useRef(0);
	const expand = () => setStore({ diagram: { ...diagram, path: session } });
	return (
		<figure className={`md-diagram is-drawn${menu ? " is-active" : ""}`}>
			<button type="button" className="md-diagram-open" title={t("Expand diagram")} onClick={expand}>
				<img src={diagram.src} alt={diagram.name} />
			</button>
			<div className="md-diagram-actions">
				<button
					type="button"
					aria-label={t("Download diagram")}
					title={t("Download")}
					aria-haspopup="menu"
					aria-expanded={Boolean(menu)}
					onClick={(event) => {
						if (Date.now() - closed.current < 300) return;
						const rect = event.currentTarget.getBoundingClientRect();
						setMenu({ x: rect.right, y: rect.bottom + 6 });
					}}
				>
					<DownloadIcon size={13} />
				</button>
				{session && (
					<button type="button" aria-label={t("Open in side panel")} title={t("Open in side panel")} onClick={() => openDiagramPreview(session, diagram)}>
						<PanelRightIcon size={13} />
					</button>
				)}
				<button type="button" aria-label={t("Expand diagram")} title={t("Expand")} onClick={expand}>
					<ExpandIcon size={13} />
				</button>
			</div>
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					align="right"
					label={t("Download")}
					entries={downloadEntries(diagram)}
					onClose={() => {
						closed.current = Date.now();
						setMenu(undefined);
					}}
				/>
			)}
		</figure>
	);
}

/** A fenced Mermaid or PlantUML block, drawn. While it draws, or when it can't be, the code shows instead. */
export function Diagram({ language, code }: { language: DiagramLanguage; code: string }) {
	const [state, setState] = useState<{ code: string; image?: string; error?: string }>();
	useEffect(() => {
		let live = true;
		draw(language, code).then(
			(image) => live && setState({ code, image }),
			(error: unknown) => live && setState({ code, error: errorText(error) }),
		);
		return () => {
			live = false;
		};
	}, [language, code]);
	const current = state?.code === code ? state : undefined;
	const name = language === "mermaid" ? "Mermaid" : "PlantUML";
	if (current?.image) return <DrawnFigure diagram={{ src: current.image, name: t("{name} diagram", { name }), code }} />;
	return (
		<div className="md-diagram-source">
			<pre>
				<code>{code}</code>
			</pre>
			<p className="md-diagram-note" role={current?.error ? "alert" : "status"}>
				{current?.error ? t("Couldn't draw this {name} diagram: {error}", { name, error: current.error }) : t("Drawing diagram…")}
			</p>
		</div>
	);
}
