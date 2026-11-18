import { useEffect, useMemo, useState } from "react";
import { type AppId, APP_IDS, type Run, type SubagentChild, type SubagentSession } from "../../shared/protocol.ts";
import { duration, tokens } from "../format.ts";
import { CloseIcon, ExternalIcon, ParentIcon, StopIcon } from "../icons.tsx";
import { attempt, closeSubagent, errorText, openSubagent, showSettings, trivium, useStore } from "../store.ts";
import { themeVars } from "../theme.ts";
import { t } from "../i18n.tsx";
import { RunBlock, useStickToBottom } from "./SessionPane.tsx";
import { AgentAvatar, type AgentStatus, firstLine, type SubagentOpener, SubagentOpenerContext, type SubagentTarget, statusWord } from "./Subagents.tsx";

const settled = (child: SubagentChild | undefined) => child?.status === "done" || child?.status === "error";

/** A writer's handed-back changes, as `+113 −12 · 3 files`, once there are any. */
function patchLine(child: SubagentChild | undefined): string {
	const handoff = child?.handoff;
	if (!handoff?.changed) return "";
	const files = handoff.filesChanged || handoff.files.length;
	return [`+${handoff.insertions} −${handoff.deletions}`, files ? t(files === 1 ? "{n} file" : "{n} files", { n: files }) : ""].filter(Boolean).join(" · ");
}

/** Its own session says it completed, where a row in the thread says done. */
const sessionWord = (status: AgentStatus) => (status === "done" ? t("Completed") : statusWord(status));

/**
 * Reads a subagent's session and keeps reading while it works: every second while it runs or hasn't
 * written its file yet, now and then when the parent isn't open to say. Once it has finished, one more
 * read picks up what it wrote last, and the reading stops.
 */
function useSubagentSession(parent: string, file: string): { session?: SubagentSession; error?: string } {
	const [state, setState] = useState<{ session?: SubagentSession; error?: string }>({});
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finalReads = 0;
		setState({});
		const read = async () => {
			try {
				const session = await trivium.subagentSession(parent, file);
				if (stopped) return;
				setState({ session });
				if (settled(session.child) && !session.missing && ++finalReads > 1) return;
				timer = setTimeout(read, session.child ? 1000 : 3000);
			} catch (error) {
				if (!stopped) setState({ error: errorText(error) });
			}
		};
		void read();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [parent, file]);
	return state;
}

/** A run that begins with the task the main agent gave. A forked child's earlier runs are the parent's own. */
function fromMainAgent(run: Run, task: string): boolean {
	const prompt = run.prompt.trim();
	const first = firstLine(task);
	return Boolean(first) && prompt.includes(first);
}

/**
 * A subagent's own session, shown like the main thread: what the main agent asked, the steps it took and
 * its answer. It is read-only; the bar at the bottom, where the message box would be, says how it is doing
 * and goes back to the main thread.
 */
export function SubagentThread({ parent, target, place, app, crumb }: { parent: string; target: SubagentTarget; place: "drawer" | "window"; app: AppId; crumb?: string }) {
	const { session, error } = useSubagentSession(parent, target.file);
	const child = session?.child;
	const runs = session?.runs ?? [];
	const lastRun = runs.at(-1);
	const status: AgentStatus | undefined = child?.status ?? (session && !session.missing ? (lastRun?.status === "running" ? "running" : "done") : undefined);
	const working = status === "running" || status === "pending";
	const task = child?.task || target.task;
	const scroll = useStickToBottom(target.file, `${runs.length}:${lastRun?.answer.length}:${lastRun?.steps.length}`);
	// Its own subagents open in the same drawer, or in another window.
	const opener = useMemo<SubagentOpener>(
		() => ({
			current: target.file,
			open: (next, newWindow) => {
				if (place === "drawer") openSubagent(parent, next, newWindow);
				else void trivium.openSubagentWindow({ parent, file: next.file, title: [next.agent, next.label].filter(Boolean).join(" "), app, crumb });
			},
		}),
		[parent, target.file, place, app, crumb],
	);
	const time = child?.durationMs !== undefined ? duration(child.durationMs) : "";
	// Its own window says what it changed, as the main thread's summary does; the drawer sits beside that thread.
	const patch = place === "window" ? patchLine(child) : "";
	const spent = child?.tokens ?? ((child?.inputTokens ?? 0) + (child?.outputTokens ?? 0) || undefined);
	const name = [target.agent, target.label].filter(Boolean).join(" ");
	const back = () => (place === "drawer" ? closeSubagent(parent) : void trivium.showSession(parent));
	// Asked to stop: the button waits for its next read to say it stopped.
	const [stopping, setStopping] = useState(false);
	const stop = async () => {
		setStopping(true);
		const asked = await attempt(() => trivium.stopSubagent(parent, target.file).then(() => true));
		if (!asked) setStopping(false);
	};
	return (
		<section
			className={`subagent-session ${place}`}
			aria-label={t("Subagent session: {name}", { name })}
			onKeyDown={(event) => {
				if (event.key === "Escape" && place === "drawer") {
					event.stopPropagation();
					closeSubagent(parent);
				}
			}}
		>
			<header className="pane-head subagent-session-head">
				<AgentAvatar agent={target.agent} status={status} size={28} />
				<div className="subagent-session-title">
					{place === "drawer" ? (
						<span className="subagent-session-crumb">{t("Main thread")} ›</span>
					) : (
						crumb && <span className="subagent-session-crumb ellipsis">{crumb}</span>
					)}
					<span className="subagent-session-name">
						<strong>{target.agent}</strong>
						{target.label && <span className="agent-row-key">{target.label}</span>}
						{status && (
							<span className={`agent-status is-${status}`}>
								{sessionWord(status)}
								{time && ` · ${time}`}
							</span>
						)}
					</span>
				</div>
				{patch && <span className="subagent-session-patch">{patch}</span>}
				{place === "drawer" && (
					<>
						<button
							type="button"
							className="icon-btn"
							aria-label={t("Open in a new window")}
							title={t("Open in a new window")}
							onClick={() => openSubagent(parent, target, true)}
						>
							<ExternalIcon size={14} />
						</button>
						<button type="button" className="icon-btn" aria-label={t("Close")} title={t("Close")} onClick={() => closeSubagent(parent)}>
							<CloseIcon size={14} />
						</button>
					</>
				)}
			</header>
			<div className="thread-frame">
				<div className="scroller" ref={scroll.ref} onScroll={scroll.onScroll}>
					<div className="scroll-row">
						<div className="thread">
							<SubagentOpenerContext.Provider value={opener}>
								{runs.map((run, index) => (
									<RunBlock
										key={run.id}
										run={run}
										index={index}
										live={working && index === runs.length - 1}
										// Without the task to compare, a child's session still begins with what the main agent asked.
										from={fromMainAgent(run, task) || (!task && index === 0) ? t("From the main agent") : undefined}
									/>
								))}
							</SubagentOpenerContext.Provider>
							{!working && (spent || session?.context !== undefined) ? (
								<div className="subagent-chips">
									{session?.context !== undefined && <span>{t("{n}% context", { n: session.context })}</span>}
									{spent ? <span>{t("{n} tokens", { n: tokens(spent) })}</span> : null}
								</div>
							) : null}
							{error && <div className="run-error">{error}</div>}
							{!error && (!session || session.missing) && (
								<div className="run">
									{task && (
										<div className="prompt quoted">
											<span className="prompt-from">{t("From the main agent")}</span>
											<div className="bubble">{task}</div>
										</div>
									)}
									<p className="subagent-session-wait">{t(session ? "Its session starts once it begins working." : "Loading its session…")}</p>
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
			<div className="subagent-bar">
				<span className="subagent-bar-main">
					{child?.model && <strong>{child.model}</strong>}
					{session?.thinking && <span className="subagent-bar-thinking">{session.thinking}</span>}
					{status && (
						<span className={`agent-status is-${status} ellipsis`}>
							{[sessionWord(status), child?.tools ? t(child.tools === 1 ? "{n} tool" : "{n} tools", { n: child.tools }) : "", time].filter(Boolean).join(" · ")}
						</span>
					)}
				</span>
				<span className="subagent-bar-note">{t(working ? "Runs on its own" : status === "stopped" ? "Stopped before it finished" : "Its answer went back to the main agent")}</span>
				{working && session?.stoppable && (
					<button type="button" className="btn ghost subagent-bar-back" disabled={stopping} onClick={() => void stop()}>
						<StopIcon />
						{t(stopping ? "Stopping…" : "Stop")}
					</button>
				)}
				<button type="button" className="btn ghost subagent-bar-back" onClick={back}>
					<ParentIcon size={13} />
					{t(place === "drawer" ? "Main thread" : "Open main thread")}
				</button>
			</div>
		</section>
	);
}

/**
 * A window of its own for one subagent's session. The page is the app's, told by its hash which session to
 * show; the main process only lets it read that session and open links.
 */
export function SubagentWindow() {
	const params = new URLSearchParams(location.hash.slice(1));
	const file = params.get("subagent") ?? "";
	const parent = params.get("parent") ?? "";
	const title = params.get("title") ?? "";
	const crumb = params.get("crumb") || undefined;
	const app = (APP_IDS as readonly string[]).includes(params.get("app") ?? "") ? (params.get("app") as AppId) : "code";
	const [agent = "", ...label] = title.split(" ");
	const target = useMemo(() => ({ file, agent, label: label.join(" ") || undefined, task: "" }), [file, title]);
	const locale = useStore((s) => s.locale);
	useEffect(() => {
		document.title = `Trivium · ${title}`;
		void attempt(() => trivium.getSettings()).then((settings) => settings && showSettings(settings));
	}, [title]);
	return (
		<div className="subagent-window" style={themeVars(app)} key={locale}>
			<SubagentThread parent={parent} target={target} place="window" app={app} crumb={crumb} />
		</div>
	);
}

/** The subagent drawer beside a session's thread, while one is open. */
export function SubagentDrawer({ parent, target, app }: { parent: string; target: SubagentTarget; app: AppId }) {
	return (
		<aside className="subagent-drawer">
			<SubagentThread key={target.file} parent={parent} target={target} place="drawer" app={app} />
		</aside>
	);
}
