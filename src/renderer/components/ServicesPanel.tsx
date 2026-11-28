import { useEffect, useMemo, useRef, useState } from "react";
import type { AppLaunchInfo, InfraInfo, ServiceInfo, SessionView } from "../../shared/protocol.ts";
import { baseName, relativeTime } from "../format.ts";
import { Chevron, CopyIcon, DatabaseIcon, ExternalIcon, EyeIcon, PlayIcon, ServerIcon } from "../icons.tsx";
import { attempt, checkInfra, dismissLaunch, openWebPreview, prepareLaunch, stopInfra, stopService, trivium, useStore } from "../store.ts";
import { t, tx } from "../i18n.tsx";

const NONE: ServiceInfo[] = [];

/** A session's running services, for the header and the panel. */
export function useServices(path: string): ServiceInfo[] {
	return useStore((s) => s.services[path] ?? NONE);
}

/** The Compose projects a session's launches hold. */
export function useSessionInfra(path: string): InfraInfo[] {
	const all = useStore((s) => s.launch.infra);
	return useMemo(() => all.filter((info) => info.holders.includes(path)), [all, path]);
}

/** A session's launched apps on their way up, or that ended in a way to tell. */
function useLaunchApps(path: string): AppLaunchInfo[] {
	const all = useStore((s) => s.launch.apps);
	return useMemo(() => all.filter((app) => app.sessionPath === path && app.state !== "running"), [all, path]);
}

export function serviceCount(count: number): string {
	return t(count === 1 ? "1 service" : "{n} services", { n: count });
}

/** What the service is, in a word or two: its task's label, or its main program. */
function serviceName(service: ServiceInfo): string {
	if (service.launch) return service.launch;
	const main = service.processes.find((process) => !/^(bash|sh|conhost|cmd)$/i.test(process.name)) ?? service.processes[0];
	return main?.name || t("Process");
}

function startedText(startedAt: number): string {
	return Date.now() - startedAt < 60_000 ? t("just now") : t("{time} ago", { time: relativeTime(startedAt) });
}

/** The Code panel's Services view: what this session launched, and what its commands left running, to open or stop. */
export function ServicesBody({ view }: { view: SessionView }) {
	const services = useServices(view.path);
	const infra = useSessionInfra(view.path);
	const apps = useLaunchApps(view.path);
	if (!services.length && !infra.length && !apps.length) {
		return (
			<div className="side-body panel-empty">
				<span className="panel-empty-icon">
					<ServerIcon size={18} />
				</span>
				<h3>{t("Nothing running")}</h3>
				<p>{t("Tasks you launch, and dev servers and watchers this session's commands leave running, show up here, to open or stop.")}</p>
			</div>
		);
	}
	return (
		<div className="services">
			{infra.map((info) => (
				<InfraEntry key={info.project} path={view.path} info={info} />
			))}
			{apps.map((app) => (
				<LaunchEntry key={app.label} app={app} />
			))}
			{services.map((service) => (
				<ServiceCard key={service.id} path={view.path} service={service} />
			))}
			<p className="services-note">
				{t(infra.length ? "Quitting Trivium stops these. Saved data is kept." : "Quitting Trivium stops these. Stop one here to free its port sooner.")}
			</p>
		</div>
	);
}

/** A Compose project an app launched with: its state, and what went wrong when it did not come up. */
function InfraEntry({ path, info }: { path: string; info: InfraInfo }) {
	const [show, setShow] = useState<"output" | "logs" | undefined>(info.state === "failed" ? "output" : undefined);
	useEffect(() => {
		if (info.state === "failed") setShow("output");
	}, [info.state]);
	const shared = info.holders.length - 1;
	const state = {
		starting: t("Starting"),
		running: t("Running"),
		failed: t("Failed"),
		unknown: t("Unknown"),
		stopping: t("Stopping…"),
	}[info.state];
	const targets = (info.services ?? info.profiles ?? []).join(", ");
	return (
		<section className={`service infra ${info.state}`} aria-label={info.label}>
			<div className="service-head">
				{info.state === "starting" || info.state === "stopping" ? <span className="launch-spin" aria-hidden="true" /> : <DatabaseIcon size={14} />}
				<span className="service-name ellipsis">{info.label}</span>
				<span className="service-kind">Docker</span>
				<span className="service-state">· {state}</span>
				{info.state === "unknown" ? (
					<button type="button" className="service-action" onClick={() => void checkInfra(info.project)}>
						{t("Check again")}
					</button>
				) : (
					<button
						type="button"
						className="service-action stop"
						disabled={info.state === "stopping"}
						title={t("Stops its containers. Data in its volumes is kept.")}
						onClick={() => void stopInfra(info, path)}
					>
						{info.state === "failed" ? t("Clean up") : t("Stop")}
					</button>
				)}
			</div>
			{targets && <div className="service-line mono">{targets}</div>}
			{info.state === "starting" && <div className="service-meta">{t("Waiting for it to be healthy. You can keep working.")}</div>}
			{info.error && info.state !== "starting" && <div className={`service-error${info.state === "unknown" ? " soft" : ""}`}>{info.error}</div>}
			<div className="service-meta">
				{shared > 0 ? t(shared === 1 ? "Shared by 2 sessions" : "Shared by {n} sessions", { n: shared + 1 }) : t("Started {when}", { when: startedText(info.startedAt) })}
			</div>
			{(info.output.trim() || info.logs.trim()) && (
				<>
					<div className="service-tabs" role="tablist" aria-label={t("Output")}>
						{info.output.trim() && (
							<button type="button" role="tab" aria-selected={show === "output"} className={show === "output" ? "on" : ""} onClick={() => setShow(show === "output" ? undefined : "output")}>
								{t("Startup output")}
							</button>
						)}
						{info.logs.trim() && (
							<button type="button" role="tab" aria-selected={show === "logs"} className={show === "logs" ? "on" : ""} onClick={() => setShow(show === "logs" ? undefined : "logs")}>
								{t("Container logs")}
							</button>
						)}
					</div>
					{show && <Output text={show === "output" ? info.output : info.logs} />}
				</>
			)}
		</section>
	);
}

/** A launched app on its way up, or one that exited on its own or never started. */
function LaunchEntry({ app }: { app: AppLaunchInfo }) {
	const waiting = app.state === "waiting" || app.state === "starting";
	return (
		<section className={`service${waiting ? "" : " failed"}`} aria-label={app.label}>
			<div className="service-head">
				{waiting ? <span className="launch-spin" aria-hidden="true" /> : <span className="service-dot bad" aria-hidden="true" />}
				<span className="service-name ellipsis">{app.label}</span>
				<span className="service-state">
					·{" "}
					{app.state === "waiting"
						? t("Waits for its infrastructure")
						: app.state === "starting"
							? t("Starting…")
							: app.state === "not_started"
								? t("Not started")
								: app.exitCode === null || app.exitCode === undefined
									? t("Couldn't start")
									: t("Exited with code {code}", { code: app.exitCode })}
				</span>
				{!waiting && (
					<button type="button" className="service-action muted" onClick={() => void dismissLaunch(app.sessionPath, app.label)}>
						{t("Dismiss")}
					</button>
				)}
			</div>
			{app.reason && <div className="service-error">{app.reason}</div>}
			{app.tail?.trim() && <Output text={app.tail} />}
			{!waiting && (
				<div className="service-links">
					<button type="button" className="service-action" onClick={() => void prepareLaunch(app.sessionPath, app.label)}>
						<PlayIcon size={10} />
						{t("Launch {name} again", { name: app.label })}
					</button>
				</div>
			)}
		</section>
	);
}

function Output({ text }: { text: string }) {
	const output = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const element = output.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [text]);
	return (
		<pre ref={output} className="service-output">
			{text.trimEnd()}
		</pre>
	);
}

function ServiceCard({ path, service }: { path: string; service: ServiceInfo }) {
	const [showOutput, setShowOutput] = useState(!!service.launch);
	const pids = service.processes.map((process) => process.pid).join(", ");
	return (
		<section className="service" aria-label={serviceName(service)}>
			<div className="service-head">
				<span className={`service-dot${service.stopping ? " stopping" : ""}`} aria-hidden="true" />
				<span className="service-name ellipsis">{serviceName(service)}</span>
				{service.ports.map((port) => (
					<span key={port} className="service-port mono">
						:{port}
					</span>
				))}
				<button
					type="button"
					className="service-action stop"
					disabled={service.stopping}
					title={t("Stop it and everything it started")}
					onClick={() => void stopService(service.id)}
				>
					{t(service.stopping ? "Stopping…" : "Stop")}
				</button>
			</div>
			<code className="service-line mono" title={service.command}>
				{service.command}
			</code>
			<div className="service-meta">
				{tx("Started {when} in {folder}", {
					when: startedText(service.startedAt),
					folder: <span title={service.cwd}>{baseName(service.cwd)}</span>,
				})}
				{!service.launch && <> · {t(service.processes.length === 1 ? "process {pids}" : "processes {pids}", { pids })}</>}
			</div>
			{service.url && (
				<div className="service-url">
					<a className="mono ellipsis" href={service.url} target="_blank" rel="noreferrer" title={t("Open in browser")}>
						{service.url}
					</a>
					<button type="button" className="icon-btn" aria-label={t("Open in Preview")} title={t("Open in Preview")} onClick={() => openWebPreview(path, service.url!)}>
						<EyeIcon size={14} />
					</button>
					<button type="button" className="icon-btn" aria-label={t("Open in browser")} title={t("Open in browser")} onClick={() => void attempt(() => trivium.openExternal(service.url!))}>
						<ExternalIcon size={14} />
					</button>
					<button type="button" className="icon-btn" aria-label={t("Copy address")} title={t("Copy address")} onClick={() => void attempt(() => trivium.copyText(service.url!))}>
						<CopyIcon size={14} />
					</button>
				</div>
			)}
			{service.output.trim() ? (
				<>
					<button type="button" className="service-output-toggle" aria-expanded={showOutput} onClick={() => setShowOutput(!showOutput)}>
						<Chevron open={showOutput} down size={11} />
						{t("Output")}
					</button>
					{showOutput && <Output text={service.output} />}
				</>
			) : (
				<div className="service-meta">{t(service.launch ? "No output yet." : "No output to show. It may write to a log file instead.")}</div>
			)}
		</section>
	);
}
