import type { ReactNode } from "react";
import type { GitFile } from "../../shared/protocol.ts";
import { baseName } from "../format.ts";
import { t } from "../i18n.tsx";
import { transition } from "../transition.ts";

const MARK: Record<GitFile["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	untracked: "U",
	conflicted: "!",
};

export function dirName(rel: string): string {
	const slash = rel.replaceAll("\\", "/").lastIndexOf("/");
	return slash > 0 ? rel.slice(0, slash) : "";
}

/** What a diff says when it has no lines to show. */
export function emptyNote(status: GitFile["status"], binary = false): string {
	if (binary) return t("Binary file.");
	if (status === "deleted") return t("File deleted.");
	if (status === "renamed" || status === "copied" || status === "typechange") return t("No changes to the content.");
	return t("Empty file.");
}

/** A changed file in a list, with what happened to it and where it is. */
export function FileRow({ status, rel, title, current, tag, onSelect, children }: {
	status: GitFile["status"];
	rel: string;
	title?: string;
	current: boolean;
	tag?: string;
	onSelect: () => void;
	children?: ReactNode;
}) {
	return (
		<button type="button" className="change-file" aria-current={current} title={title ?? rel} onClick={() => transition("tab", onSelect)}>
			<span className={`change-mark is-${status}`} aria-label={status}>
				{MARK[status]}
			</span>
			<span className="change-name ellipsis">{baseName(rel)}</span>
			<span className="change-dir ellipsis">{dirName(rel)}</span>
			<span className="change-meta">
				{tag && <span className="tag">{tag}</span>}
				{children}
			</span>
		</button>
	);
}
