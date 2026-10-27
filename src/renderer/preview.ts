import { createContext, useContext } from "react";

/**
 * Opens a file in the Preview panel of the session on screen. Unset where nothing can be previewed, so file
 * paths in the conversation stay plain text there.
 */
export const PreviewOpener = createContext<((file: string) => void) | undefined>(undefined);

export function usePreviewOpener(): ((file: string) => void) | undefined {
	return useContext(PreviewOpener);
}

/**
 * Text that reads as a path to a file, such as `src/main.ts`, `./report/index.html` or `README.md:12`: no
 * spaces, and a name with an extension. A trailing line number is dropped.
 */
export function filePath(text: string): string | undefined {
	const match = /^((?:\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|\/)?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+(?::\d+)?)?$/.exec(text.trim());
	if (!match || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return undefined;
	return match[1];
}

/** A table this long is still quick to show; past it, the rest stays in the file. */
const MAX_ROWS = 2000;

/** Rows of a CSV or TSV file, with quoted cells that may hold separators, quotes and line breaks. */
export function parseTable(text: string, separator: "," | "\t", limit = MAX_ROWS): { rows: string[][]; more: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (quoted) {
			if (char !== '"') cell += char;
			else if (text[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
		} else if (char === '"' && cell === "") quoted = true;
		else if (char === separator) {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			// The header row and `limit` more.
			if (rows.length > limit) return { rows, more: i < text.length - 1 };
		} else cell += char;
	}
	if (cell || row.length) rows.push([...row, cell]);
	return { rows, more: false };
}
