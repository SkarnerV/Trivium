import { useEffect, useState } from "react";
import { errorText, trivium } from "../store.ts";
import { t } from "../i18n.tsx";

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
	if (current?.image) {
		return (
			<figure className="md-diagram">
				<img src={current.image} alt={t("{name} diagram", { name })} />
			</figure>
		);
	}
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
