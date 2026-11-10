import { pathToFileURL } from "node:url";

const lineOf = (line?: number) => (line && Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined);

/**
 * The link that opens a file in VS Code, at a line when one is given: `vscode://file/<path>:<line>`. The path is
 * written as in a file URL, with forward slashes, a Windows drive after a slash (`/C:/work/app.ts`), a network
 * share's server first (`//server/share/app.ts`), and spaces, # and % escaped. VS Code asks the user to allow
 * such a link before it opens the file, so it is the fallback when VS Code itself can't be started.
 */
export function editorUrl(file: string, line?: number): string {
	const { host, pathname } = pathToFileURL(file);
	const at = lineOf(line);
	return `vscode://file${host ? `//${host}` : ""}${pathname}${at ? `:${at}` : ""}`;
}

/** What VS Code's own executable takes to open a file, at a line when one is given. */
export function editorArgs(file: string, line?: number): string[] {
	const at = lineOf(line);
	return at ? ["--goto", `${file}:${at}`] : [file];
}
