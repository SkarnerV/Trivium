import { type ReactNode, useEffect, useRef, useState } from "react";
import type { SessionView } from "../../shared/protocol.ts";
import { BranchIcon, CheckIcon, Chevron, CloudDownIcon, CloudUpIcon, FileIcon, FolderIcon, ServerIcon, ViewsIcon } from "../icons.tsx";
import { type PanelView, panelOpen, panelViews, shownView } from "../panels.ts";
import { showPanelView, useStore } from "../store.ts";
import { transition } from "../transition.ts";
import { t } from "../i18n.tsx";
import { branchLabel, ChangeCount, changedCount } from "./SourceControl.tsx";
import { serviceCount, useServices } from "./ServicesPanel.tsx";

function fileCount(n: number): string {
	return t(n === 1 ? "1 file" : "{n} files", { n });
}

/**
 * The button in the session's header and the summary cards that hang from it: one list over the thread, which
 * takes no room from it and closes when a card is picked, on a click elsewhere or on Escape.
 */
export function SummaryButton({ view }: { view: SessionView }) {
	const [shown, setShown] = useState(false);
	const anchor = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!shown) return;
		const away = (event: MouseEvent) => {
			if (!anchor.current?.contains(event.target as Node)) setShown(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setShown(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", escape);
		};
	}, [shown]);
	return (
		<span className="views-anchor" ref={anchor}>
			<button
				type="button"
				className="changes-toggle views-toggle"
				aria-pressed={shown}
				aria-expanded={shown}
				aria-label={t(shown ? "Hide summary cards" : "Show summary cards")}
				title={t(shown ? "Hide summary cards" : "Show summary cards")}
				onClick={() => setShown(!shown)}
			>
				<ViewsIcon size={15} />
			</button>
			{shown && <SummaryCards view={view} onPicked={() => setShown(false)} />}
		</span>
	);
}

/** One card: a title and a few lines. A click opens its view, in full, in a tab of the panel. */
function Card({ title, current, onOpen, children }: { title: string; current: boolean; onOpen: () => void; children: ReactNode }) {
	return (
		<button type="button" className="summary-card" aria-current={current} onClick={onOpen}>
			<span className="summary-card-title">
				{title}
				<Chevron open={false} size={11} />
			</span>
			{children}
		</button>
	);
}

function Row({ icon, children, value, tone }: { icon: ReactNode; children: ReactNode; value?: ReactNode; tone?: "push" | "pull" | "done" }) {
	return (
		<span className={`summary-row${tone ? ` is-${tone}` : ""}`}>
			{icon}
			<span className="summary-row-text ellipsis">{children}</span>
			{value !== undefined && <span className="summary-row-value">{value}</span>}
		</span>
	);
}

/**
 * The summary cards under the header's button: a few facts about the services running,
 * the branch and what is uncommitted, and the project's files. Picking one opens its view, with the details, in a
 * tab of the panel.
 */
function SummaryCards({ view, onPicked }: { view: SessionView; onPicked: () => void }) {
	const git = useStore((s) => s.git[view.path]);
	const services = useServices(view.path);
	const showing = useStore((s) =>
		panelOpen(s.app, view, s.changesHidden[view.path]) ? shownView(panelViews(view, s.panelTabs[view.path]), s.panelTab[view.path]) : undefined,
	);

	const open = (name: PanelView) => () => {
		onPicked();
		transition("tab", () => showPanelView(view.path, name));
	};
	const changed = changedCount(git);
	const staged = new Set(git?.files.filter((file) => file.area === "staged").map((file) => file.rel)).size;
	const ports = services.flatMap((service) => service.ports.map((port) => `:${port}`));
	return (
		<div className="views-menu" role="dialog" aria-label={t("Session summary")}>
			<Card title={t("Services")} current={showing === "services"} onOpen={open("services")}>
				{services.length ? (
					<Row icon={<ServerIcon size={14} />} value={ports.length ? <span className="mono">{ports.join(" ")}</span> : undefined}>
						{serviceCount(services.length)}
					</Row>
				) : (
					<Row icon={<ServerIcon size={14} />}>{t("Nothing running")}</Row>
				)}
			</Card>
			<Card title={t("Source Control")} current={showing === "git"} onOpen={open("git")}>
				{git && (
					<Row icon={<BranchIcon size={14} />} value={git.upstream && <span className="mono">{git.upstream}</span>}>
						<span className="mono">{branchLabel(git)}</span>
					</Row>
				)}
				{git && git.ahead > 0 && (
					<Row icon={<CloudUpIcon size={14} />} tone="push">
						{t("{n} to push", { n: git.ahead })}
					</Row>
				)}
				{git && git.behind > 0 && (
					<Row icon={<CloudDownIcon size={14} />} tone="pull">
						{t("{n} to pull", { n: git.behind })}
					</Row>
				)}
				{git && changed > 0 && (
					<Row icon={<FileIcon size={14} />} value={staged ? t("{n} staged", { n: staged }) : undefined}>
						{t("{files} changed", { files: fileCount(changed) })}
					</Row>
				)}
				{!git && view.changes.length > 0 && (
					<Row icon={<FileIcon size={14} />} value={<ChangeCount changes={view.changes} />}>
						{t("{files} this session", { files: fileCount(view.changes.length) })}
					</Row>
				)}
				{git && !changed && (
					<Row icon={<CheckIcon size={14} width={2.2} />} tone="done">
						{t("Nothing to commit")}
					</Row>
				)}
				{git === null && !view.changes.length && <Row icon={<FileIcon size={14} />}>{t("No changes yet")}</Row>}
			</Card>
			{!view.chat && (
				<Card title={t("Files")} current={showing === "files"} onOpen={open("files")}>
					<Row icon={<FolderIcon size={14} />}>{t("Every file in the project")}</Row>
				</Card>
			)}
		</div>
	);
}
