import { useCallback, useEffect, useRef, useState } from "react";
import type { LaunchTaskList, SessionView } from "../../shared/protocol.ts";
import { PlayIcon } from "../icons.tsx";
import { attempt, cancelLaunch, confirmLaunch, errorText, prepareLaunch, showPanelView, trivium, useStore } from "../store.ts";
import { t } from "../i18n.tsx";
import { useServices } from "./ServicesPanel.tsx";

const Caret = () => (
	<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M4 6l4 4 4-4" />
	</svg>
);

/**
 * Starts an app from the project's .vscode/tasks.json, with the Docker Compose infrastructure it depends on. The
 * main half repeats the last task, or the only one; the caret lists them all. Every launch is confirmed first.
 * Only in Code sessions with a project folder.
 */
export function LaunchButton({ view }: { view: SessionView }) {
	const last = useStore((s) => s.lastLaunch[view.path]);
	const apps = useStore((s) => s.launch.apps);
	const infra = useStore((s) => s.launch.infra);
	const shuttingDown = useStore((s) => s.launch.shuttingDown);
	const services = useServices(view.path);
	const [list, setList] = useState<LaunchTaskList>();
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const load = useCallback(async () => {
		try {
			setList(await trivium.launchTasks(view.path));
		} catch (error) {
			setList({ file: ".vscode/tasks.json", tasks: [], hidden: 0, error: { message: errorText(error) } });
		}
	}, [view.path]);
	// Load again whenever the agent finishes a turn, which is when it may have set launching up, and when the window
	// comes back, after the file may have been edited elsewhere.
	useEffect(() => {
		if (!view.running) void load();
	}, [load, view.running]);
	useEffect(() => {
		const onFocus = () => void load();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [load]);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const ready = list?.tasks.filter((task) => !task.error) ?? [];
	const known = (label: string | undefined) => label !== undefined && ready.some((task) => task.label === label);
	const current = known(last) ? last : list?.tasks.length === 1 && ready.length === 1 ? ready[0]!.label : undefined;
	const app = current ? apps.find((entry) => entry.sessionPath === view.path && entry.label === current) : undefined;
	const running = current ? services.some((service) => service.launch === current) : false;
	const busy = !running && (app?.state === "waiting" || app?.state === "starting");
	const failed = !running && !busy && (app?.state === "exited" || app?.state === "not_started");
	const blocked = shuttingDown ? t("Trivium is quitting.") : list?.blocked;

	const toggle = () => {
		if (!open) void load();
		setOpen(!open);
	};
	const launch = (label: string) => {
		setOpen(false);
		if (services.some((service) => service.launch === label)) showPanelView(view.path, "services");
		else void prepareLaunch(view.path, label);
	};
	const main = () => {
		if (running) showPanelView(view.path, "services");
		else if (current) launch(current);
		else toggle();
	};

	let label = t("Launch");
	if (current) {
		if (busy) label = t("Starting {name}…", { name: current });
		else if (running) label = t("{name} running", { name: current });
		else if (app?.state === "exited") label = t("{name} exited ({code})", { name: current, code: String(app.exitCode ?? "?") });
		else if (app?.state === "not_started") label = t("{name} didn't start", { name: current });
		else label = t("Launch {name}", { name: current });
	}
	const tone = running ? " running" : failed ? " failed" : "";
	// Nothing set up to launch: no button at all, unless something it launched is still around. A setup with a
	// mistake keeps the button, so the mistake can be found.
	const active = services.some((service) => service.launch) || apps.some((entry) => entry.sessionPath === view.path);
	if (!list || (!list.error && !list.tasks.length && !active)) return null;
	const fileOf = (line?: number) => () => {
		setOpen(false);
		void attempt(() => trivium.openInEditor(`${view.cwd}/${list?.file ?? ".vscode/tasks.json"}`, line));
	};

	return (
		<div className="launch" ref={box}>
			<div className={`launch-split${tone}`} aria-disabled={blocked ? true : undefined} title={blocked}>
				<button
					type="button"
					className="launch-main"
					disabled={busy || !!blocked}
					title={blocked ?? (running ? t("Show it in Services") : current ? t("Launch {name} again", { name: current }) : t("Choose what to launch"))}
					onClick={main}
				>
					{busy ? <span className="launch-spin" aria-hidden="true" /> : running || failed ? <span className="launch-dot" aria-hidden="true" /> : <PlayIcon size={12} />}
					<span>{label}</span>
				</button>
				<button type="button" className="launch-caret" disabled={!!blocked} aria-label={t("Choose a task to launch")} aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
					<Caret />
				</button>
			</div>
			{open && list && (
				<div className="launch-menu" role="menu" aria-label={t("Launch a task")}>
					{list.error ? (
						<div className="launch-state">
							<span className="launch-state-title bad">{t("The launch setup has a mistake")}</span>
							<p className="launch-state-code mono">{list.error.message}</p>
							<div className="launch-links">
								<button type="button" className="launch-link" onClick={fileOf(list.error.line)}>
									{t("Show it")}
								</button>
								<button type="button" className="launch-link" onClick={() => void load()}>
									{t("Reload")}
								</button>
							</div>
						</div>
					) : !list.tasks.length ? (
						<div className="launch-state">
							<span className="launch-state-title">{t("Nothing to launch yet")}</span>
							<p className="launch-state-text">{t("Ask in the chat to set up launching, such as “set up Launch for the app and its database”.")}</p>
						</div>
					) : (
						list.tasks.map((task) => {
							const up = task.dependsOn && infra.some((entry) => entry.label === task.dependsOn && entry.holders.includes(view.path) && entry.state === "running");
							const isRunning = services.some((service) => service.launch === task.label);
							return (
								<button key={task.label} type="button" role="menuitem" className="launch-item" disabled={!!task.error} onClick={() => launch(task.label)}>
									<span className="launch-item-head">
										<span className="launch-item-name">{task.label}</span>
										{task.label === last && !isRunning && <span className="launch-item-note">{t("Last used")}</span>}
										{isRunning && <span className="launch-item-ok">{t("Running")}</span>}
										{!isRunning && up && <span className="launch-item-ok">{t("· {name} up", { name: task.dependsOn! })}</span>}
									</span>
									{task.command && <span className="launch-item-cmd mono">{task.command}</span>}
									{task.dependsOn && !task.error && (
										<span className="launch-item-dep">{t("Starts {name} first", { name: task.dependsOn })}</span>
									)}
									{task.error && <span className="launch-item-error" title={task.error}>{t("Can't launch: its setup uses something Trivium doesn't support.")}</span>}
								</button>
							);
						})
					)}
					<div className="launch-menu-foot">
						{!list.missing && !list.error && (
							<button type="button" className="launch-link" onClick={fileOf()}>
								{t("Edit setup")}
							</button>
						)}
						<button type="button" className="launch-link" onClick={() => void load()}>
							{t("Reload")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * Shows everything a launch will run before it runs: Compose files, env file, services or profiles and build for
 * the infrastructure; shell, command, folder and the names of the environment variables for the app. Asked every
 * time, in trusted projects too, and remembers nothing.
 */
export function LaunchConfirm() {
	const plan = useStore((s) => s.launchPlan);
	const confirm = useRef<HTMLButtonElement>(null);
	useEffect(() => confirm.current?.focus(), [plan]);
	if (!plan) return null;
	const infra = plan.infra;
	return (
		<div
			className="scrim top"
			onMouseDown={(event) => event.target === event.currentTarget && cancelLaunch()}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					cancelLaunch();
				}
			}}
		>
			<div className="modal launch-confirm" role="dialog" aria-modal="true" aria-labelledby="launch-title">
				<div className="launch-confirm-head">
					<h2 id="launch-title">{t("Launch {name}?", { name: plan.label })}</h2>
				</div>
				{infra && (
					<section className="launch-section">
						<div className="launch-section-title">{t("1 · {name} · Docker", { name: infra.label })}</div>
						<dl className="launch-kv">
							<dt>{t("Compose files")}</dt>
							<dd className="mono">{infra.files.join(", ")}</dd>
							{infra.envFile && (
								<>
									<dt>{t("Env file")}</dt>
									<dd className="mono">{infra.envFile}</dd>
								</>
							)}
							{infra.services?.length ? (
								<>
									<dt>{t("Services")}</dt>
									<dd className="mono">{infra.services.join(", ")}</dd>
								</>
							) : infra.profiles?.length ? (
								<>
									<dt>{t("Profiles")}</dt>
									<dd className="mono">{infra.profiles.join(", ")}</dd>
								</>
							) : (
								<>
									<dt>{t("Services")}</dt>
									<dd className="launch-none">{t("All in the files")}</dd>
								</>
							)}
							<dt>{t("Build images")}</dt>
							<dd>{t(infra.build ? "Yes" : "No")}</dd>
						</dl>
						{infra.sharedWith.length > 0 && (
							<p className="launch-warn">
								{t("Shared with {sessions}. Stopping it in any of them stops it for all.", { sessions: infra.sharedWith.join(", ") })}
							</p>
						)}
						{infra.running && <p className="launch-ok">{t("Already running. Trivium checks it is healthy and reuses it.")}</p>}
					</section>
				)}
				<section className="launch-section">
					<div className="launch-section-title">{infra ? t("2 · {name}", { name: plan.label }) : plan.label}</div>
					<dl className="launch-kv">
						<dt>{t("Command")}</dt>
						<dd className="mono strong">{plan.command}</dd>
						<dt>{t("Shell")}</dt>
						<dd>{plan.shell}</dd>
						<dt>{t("Folder")}</dt>
						{plan.cwd === "." ? <dd>{t("Project folder")}</dd> : <dd className="mono">{plan.cwd}</dd>}
						<dt>{t("Environment")}</dt>
						<dd>
							{plan.envNames.length ? (
								<>
									<span className="mono">{plan.envNames.join(", ")}</span> <span className="launch-none">{t("values hidden")}</span>
								</>
							) : (
								<span className="launch-none">{t("Nothing added")}</span>
							)}
						</dd>
					</dl>
				</section>
				<div className="launch-confirm-foot">
					<span>{t("Asked before every launch.")}</span>
					<button type="button" className="btn ghost" onClick={cancelLaunch}>
						{t("Cancel")}
					</button>
					<button ref={confirm} type="button" className="btn primary" onClick={() => void confirmLaunch()}>
						{t("Launch")}
					</button>
				</div>
			</div>
		</div>
	);
}
