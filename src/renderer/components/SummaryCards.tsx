import type { ReactNode } from "react";
import type { SessionView } from "../../shared/protocol.ts";
import { BranchIcon, CheckIcon, Chevron, CloudDownIcon, CloudUpIcon, FileIcon, ServerIcon, ViewsIcon } from "../icons.tsx";
import { type CodeView, codeTab, codeViews, panelOpen } from "../panels.ts";
import { setState, showPanelView, useStore } from "../store.ts";
import { transition } from "../transition.ts";
import { t } from "../i18n.tsx";
import { ChangeCount } from "./ChangesPanel.tsx";
import { branchLabel, gitFileCount } from "./GitPanel.tsx";
import { serviceCount, useServices } from "./ServicesPanel.tsx";

function fileCount(n: number): string {
	return t(n === 1 ? "1 file" : "{n} files", { n });
}

/** The button in the session's header that shows or hides the summary cards under it. */
export function SummaryButton({ path }: { path: string }) {
	const shown = useStore((s) => Boolean(s.summaryShown[path]));
	return (
		<button
			type="button"
			className="changes-toggle views-toggle"
			aria-pressed={shown}
			aria-label={t(shown ? "Hide summary cards" : "Show summary cards")}
			title={t(shown ? "Hide summary cards" : "Show summary cards")}
			onClick={() => setState((s) => ({ summaryShown: { ...s.summaryShown, [path]: !shown } }))}
		>
			<ViewsIcon size={15} />
		</button>
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
 * The summary cards beside the conversation, under the header's button: a few facts about the services running,
 * the repository and this session's edits. Picking one opens its view, with the details, in a tab of the panel.
 */
export function SummaryCards({ view }: { view: SessionView }) {
	const git = useStore((s) => s.git[view.path]);
	const services = useServices(view.path);
	const showing = useStore((s) =>
		panelOpen(s.app, view, s.changesHidden[view.path]) ? codeTab(codeViews(view, s.git[view.path], s.panelTabs[view.path]), s.panelTab[view.path]) : undefined,
	);

	const open = (name: CodeView) => () => transition("tab", () => showPanelView(view.path, name));
	const changed = git ? gitFileCount(git) : 0;
	const ports = services.flatMap((service) => service.ports.map((port) => `:${port}`));
	return (
		<aside className="summary" aria-label={t("Session summary")}>
			<Card title={t("Services")} current={showing === "services"} onOpen={open("services")}>
				{services.length ? (
					<Row icon={<ServerIcon size={14} />} value={ports.length ? <span className="mono">{ports.join(" ")}</span> : undefined}>
						{serviceCount(services.length)}
					</Row>
				) : (
					<Row icon={<ServerIcon size={14} />}>{t("Nothing running")}</Row>
				)}
			</Card>
			{git && (
				<Card title={t("Git")} current={showing === "git"} onOpen={open("git")}>
					<Row icon={<BranchIcon size={14} />} value={git.upstream && <span className="mono">{git.upstream}</span>}>
						<span className="mono">{branchLabel(git)}</span>
					</Row>
					{git.ahead > 0 && (
						<Row icon={<CloudUpIcon size={14} />} tone="push">
							{t("{n} to push", { n: git.ahead })}
						</Row>
					)}
					{git.behind > 0 && (
						<Row icon={<CloudDownIcon size={14} />} tone="pull">
							{t("{n} to pull", { n: git.behind })}
						</Row>
					)}
					{changed ? (
						<Row icon={<FileIcon size={14} />}>{t(changed === 1 ? "1 file changed" : "{n} files changed", { n: changed })}</Row>
					) : (
						<Row icon={<CheckIcon size={14} width={2.2} />} tone="done">
							{t("Nothing to commit")}
						</Row>
					)}
				</Card>
			)}
			<Card title={t("Changes")} current={showing === "session"} onOpen={open("session")}>
				{view.changes.length ? (
					<Row icon={<FileIcon size={14} />} value={<ChangeCount changes={view.changes} />}>
						{fileCount(view.changes.length)}
					</Row>
				) : (
					<Row icon={<FileIcon size={14} />}>{t("No changes yet")}</Row>
				)}
			</Card>
		</aside>
	);
}
