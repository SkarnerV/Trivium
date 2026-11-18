import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Run, SubagentChild } from "../../shared/protocol.ts";
import { duration } from "../format.ts";
import { Chevron, ExternalIcon } from "../icons.tsx";
import { t } from "../i18n.tsx";
import { agentSteps } from "../agents.ts";
import { type AgentStatus, agentStatus, AvatarStack, firstLine, type SubagentOpener, SubagentOpenerContext, SubagentRow, statusSummary, targetOf } from "./Subagents.tsx";

interface Entry {
	child: SubagentChild;
	background: boolean;
}

interface Group {
	id: string;
	title: string;
	time: string;
	entries: Entry[];
}

/**
 * Every subagent the session started, newest run first, with those in the background on top. A background
 * child's step ends at launch; how it ended comes from its result, or from the host's read of its run.
 */
export function sessionSubagents(runs: Run[], running: boolean): { groups: Group[]; all: { status: AgentStatus; agent: string }[] } {
	const resolved = new Map(agentSteps(runs).map((step) => [step.id, step]));
	const background: Entry[] = [];
	const groups: Group[] = [];
	runs.forEach((run, index) => {
		const entries: Entry[] = [];
		for (const step of run.steps) {
			if (!step.subagent) continue;
			const shown = resolved.get(step.id) ?? step;
			for (const child of shown.subagent!.children) {
				if (!step.subagent.background) entries.push({ child, background: false });
				// Nothing has said it ended, so it is still working on its own.
				else background.push({ child: shown === step ? { ...child, status: "running" } : child, background: true });
			}
		}
		if (!entries.length) return;
		const last = index === runs.length - 1;
		const end = last && running ? undefined : run.endedAt;
		groups.push({
			id: run.id,
			title: last && running ? t("This turn") : firstLine(run.prompt) || t("Earlier"),
			time: run.startedAt && end ? duration(end - run.startedAt) : "",
			entries,
		});
	});
	groups.reverse();
	if (background.length) groups.unshift({ id: "background", title: t("Background"), time: "", entries: background });
	const all = groups.flatMap((group) => group.entries.map((entry) => ({ status: agentStatus(entry.child), agent: entry.child.agent })));
	return { groups, all };
}

/** Background children by session file, with how they did as their results reported it. */
export function backgroundSubagents(runs: Run[], running: boolean): ReadonlyMap<string, SubagentChild> {
	const group = sessionSubagents(runs, running).groups.find((item) => item.id === "background");
	return new Map(group?.entries.flatMap((entry) => (entry.child.sessionFile ? [[entry.child.sessionFile, entry.child] as const] : [])));
}

/** The header button that lists every subagent in the session, and opens any of them. */
export function SubagentsMenu({ runs, running }: { runs: Run[]; running: boolean }) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState<"all" | "working">("all");
	const ref = useRef<HTMLDivElement>(null);
	const parent = useContext(SubagentOpenerContext);
	const { groups, all } = useMemo(() => sessionSubagents(runs, running), [runs, running]);
	useEffect(() => {
		if (!open) return;
		const away = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);
	// Opening one closes the menu.
	const opener = useMemo<SubagentOpener | null>(
		() =>
			parent && {
				current: parent.current,
				background: parent.background,
				open: (target, newWindow) => {
					setOpen(false);
					parent.open(target, newWindow);
				},
			},
		[parent],
	);
	if (!all.length || !opener) return null;
	const working = all.filter((child) => child.status === "running" || child.status === "pending").length;
	const shown = groups
		.map((group) => ({ ...group, entries: filter === "all" ? group.entries : group.entries.filter((entry) => entry.child.status === "running" || entry.child.status === "pending") }))
		.filter((group) => group.entries.length);
	return (
		<div className="subagents-menu" ref={ref}>
			<button
				type="button"
				className="changes-toggle subagents-toggle"
				aria-haspopup="menu"
				aria-expanded={open}
				title={t("Subagents in this session")}
				onClick={() => setOpen(!open)}
			>
				{/* The kinds of agent at work, not each one: the count beside it says how many. */}
				<AvatarStack agents={[...new Set(all.map((child) => child.agent))]} size={20} max={2} more={false} />
				<span>{t(all.length === 1 ? "{n} agent" : "{n} agents", { n: all.length })}</span>
				{working > 0 && (
					<span className="subagents-working" aria-label={t("{n} working", { n: working })}>
						<span className="live-dot" />
						{working}
					</span>
				)}
				<Chevron open={open} down />
			</button>
			{open && (
				<div className="subagents-popover" role="menu" aria-label={t("Subagents in this session")}>
					<div className="subagents-popover-head">
						<span className="subagents-popover-title">
							<strong>{t("Subagents in this session")}</strong>
							<span>{statusSummary(all)}</span>
						</span>
						<div className="segmented" role="group" aria-label={t("Show")}>
							<button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
								{t("All")}
							</button>
							<button type="button" aria-pressed={filter === "working"} onClick={() => setFilter("working")}>
								{t("Working")}
							</button>
						</div>
					</div>
					<div className="subagents-popover-list">
						<SubagentOpenerContext.Provider value={opener}>
							{shown.map((group) => (
								<div key={group.id} className="subagents-popover-group">
									<div className="subagents-popover-label">
										<span className="ellipsis">{group.title}</span>
										<span>{group.time}</span>
									</div>
									{group.entries.map((entry, index) => {
										const target = targetOf(entry.child);
										return (
											<div key={index} className="subagents-popover-row">
												<SubagentRow child={entry.child} background={entry.background} place="menu" />
												{target && (
													<button
														type="button"
														className="icon-btn subagents-popover-window"
														aria-label={t("Open in a new window")}
														title={t("Open in a new window")}
														onClick={() => opener.open(target, true)}
													>
														<ExternalIcon size={13} />
													</button>
												)}
											</div>
										);
									})}
								</div>
							))}
							{!shown.length && <p className="subagents-popover-empty">{t("No subagent is working now.")}</p>}
						</SubagentOpenerContext.Provider>
					</div>
					<div className="subagents-popover-foot">
						<span className="subagents-popover-hint">{t("Click opens the session beside the thread")}</span>
						<kbd>Shift</kbd>
						<span>{t("+ click: new window")}</span>
					</div>
				</div>
			)}
		</div>
	);
}
