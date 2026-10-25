import { Fragment, type ReactNode } from "react";

// A small Markdown subset rendered straight to React elements, so model output
// never reaches the DOM as HTML. Covers what agents write most: paragraphs,
// headings, lists, quotes, fenced code, inline code, emphasis and links.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let index = 0;
	for (const match of text.matchAll(INLINE)) {
		const start = match.index ?? 0;
		if (start > last) out.push(text.slice(last, start));
		const key = `${keyPrefix}-${index++}`;
		if (match[1]) out.push(<code key={key}>{match[1].slice(1, -1)}</code>);
		else if (match[2]) out.push(<strong key={key}>{inline(match[2].slice(2, -2), key)}</strong>);
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

function withBreaks(lines: string[], key: string): ReactNode[] {
	return lines.flatMap((line, index) => {
		const parts = inline(line, `${key}-${index}`);
		return index === 0 ? parts : [<br key={`${key}-br-${index}`} />, ...parts];
	});
}

export function Markdown({ text }: { text: string }) {
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
		const heading = /^(#{1,4})\s+(.*)$/.exec(line);
		if (heading) {
			const Tag = `h${heading[1]!.length}` as "h1" | "h2" | "h3" | "h4";
			blocks.push(<Tag key={key}>{inline(heading[2]!, key)}</Tag>);
			i++;
			continue;
		}
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
			blocks.push(<blockquote key={key}>{withBreaks(body, key)}</blockquote>);
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
			const children = items.map((item, index) => <li key={`${key}-${index}`}>{withBreaks(item, `${key}-${index}`)}</li>);
			blocks.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
			continue;
		}
		const body: string[] = [];
		while (
			i < lines.length &&
			lines[i]!.trim() &&
			!/^\s*(```|~~~|#{1,4}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]!)
		) {
			body.push(lines[i++]!);
		}
		if (!body.length) body.push(lines[i++]!);
		blocks.push(<p key={key}>{withBreaks(body, key)}</p>);
	}
	return <Fragment>{blocks}</Fragment>;
}
