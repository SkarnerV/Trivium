import { Fragment, type ReactNode } from "react";
import { filePath, usePreviewOpener } from "../preview.ts";

// A small Markdown subset rendered straight to React elements, so model output
// never reaches the DOM as HTML. Covers what agents write most: paragraphs,
// headings, lists, quotes, fenced code, inline code, emphasis and links.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Opens a file path in the Preview panel, where the conversation has one. */
type Opener = ((file: string) => void) | undefined;

function inline(text: string, keyPrefix: string, open?: Opener): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let index = 0;
	for (const match of text.matchAll(INLINE)) {
		const start = match.index ?? 0;
		if (start > last) out.push(text.slice(last, start));
		const key = `${keyPrefix}-${index++}`;
		if (match[1]) out.push(code(match[1].slice(1, -1), key, open));
		else if (match[2]) out.push(<strong key={key}>{inline(match[2].slice(2, -2), key, open)}</strong>);
		else if (match[3]) out.push(<em key={key}>{match[3].slice(1, -1)}</em>);
		else if (match[4] && match[5])
			out.push(
				<a key={key} href={match[5]} target="_blank" rel="noreferrer">
					{match[4]}
				</a>,
			);
		last = start + match[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/** Inline code, as a link to the file when it names one and the conversation can preview it. */
function code(text: string, key: string, open: Opener): ReactNode {
	const file = open && filePath(text);
	if (!file) return <code key={key}>{text}</code>;
	return (
		<button key={key} type="button" className="path-link" title={`Preview ${file}`} onClick={() => open(file)}>
			<code>{text}</code>
		</button>
	);
}

function withBreaks(lines: string[], key: string, open?: Opener): ReactNode[] {
	return lines.flatMap((line, index) => {
		const parts = inline(line, `${key}-${index}`, open);
		return index === 0 ? parts : [<br key={`${key}-br-${index}`} />, ...parts];
	});
}

export function Markdown({ text }: { text: string }) {
	const open = usePreviewOpener();
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const key = `b${i}`;
		const fence = /^\s*(```|~~~)(.*)$/.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
			i++;
			blocks.push(
				<pre key={key}>
					<code>{body.join("\n")}</code>
				</pre>,
			);
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		// A pipe table: a header row, then a separator row like |---|:--:|.
		if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
			const cells = (row: string) =>
				row
					.trim()
					.replace(/^\|/, "")
					.replace(/\|$/, "")
					.split("|")
					.map((cell) => cell.trim());
			const head = cells(line);
			i += 2;
			const body: string[][] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i]!)) body.push(cells(lines[i++]!));
			blocks.push(
				<div key={key} className="md-table">
					<table>
						<thead>
							<tr>
								{head.map((cell, index) => (
									<th key={index}>{inline(cell, `${key}-h${index}`, open)}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{body.map((row, r) => (
								<tr key={r}>
									{row.map((cell, c) => (
										<td key={c}>{inline(cell, `${key}-${r}-${c}`, open)}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>,
			);
			continue;
		}
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			const Tag = `h${heading[1]!.length}` as "h1" | "h2" | "h3" | "h4";
			blocks.push(<Tag key={key}>{inline(heading[2]!, key, open)}</Tag>);
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
			blocks.push(<blockquote key={key}>{withBreaks(body, key, open)}</blockquote>);
			continue;
		}
		const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
		if (listMatch) {
			const ordered = /\d/.test(listMatch[1]!);
			const items: string[][] = [];
			while (i < lines.length) {
				const current = lines[i]!;
				const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(current);
				if (item) items.push([item[2]!]);
				else if (current.trim() && /^\s{2,}/.test(current) && items.length) items.at(-1)!.push(current.trim());
				else break;
				i++;
			}
			const children = items.map((item, index) => <li key={`${key}-${index}`}>{withBreaks(item, `${key}-${index}`, open)}</li>);
			// Keep the list's own first number, such as a citation list that continues at 4.
			const start = ordered ? Number.parseInt(listMatch[1]!, 10) : 1;
			blocks.push(
				ordered ? (
					<ol key={key} start={start}>
						{children}
					</ol>
				) : (
					<ul key={key}>{children}</ul>
				),
			);
			continue;
		}
		const body: string[] = [];
		while (
			i < lines.length &&
			lines[i]!.trim() &&
			!/^\s*(```|~~~|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i]!)
		) {
			body.push(lines[i++]!);
		}
		if (!body.length) body.push(lines[i++]!);
		blocks.push(<p key={key}>{withBreaks(body, key, open)}</p>);
	}
	return <Fragment>{blocks}</Fragment>;
}
