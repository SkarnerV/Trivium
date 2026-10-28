import type { DiffLine } from "../../shared/protocol.ts";
import { t } from "../i18n.tsx";

/** Diff lines with line numbers; `empty` is what to say when there are none. */
export function DiffView({ lines, tooLarge, empty }: { lines: DiffLine[]; tooLarge: boolean; empty: string }) {
	if (tooLarge) return <p className="diff-note">{t("This file is too large to show a diff.")}</p>;
	if (!lines.length) return <p className="diff-note">{empty}</p>;
	return (
		<>
			{lines.map((line, index) =>
				line.kind === "hunk" ? (
					<div key={index} className="diff-hunk">
						{line.text}
					</div>
				) : (
					<div key={index} className={`diff-line is-${line.kind}`}>
						<span className="no">{line.kind === "del" ? line.oldNo : line.newNo}</span>
						<span className="text">{line.text || " "}</span>
					</div>
				),
			)}
		</>
	);
}
