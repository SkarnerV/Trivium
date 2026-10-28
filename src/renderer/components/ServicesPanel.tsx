import { useEffect, useRef, useState } from "react";
import type { ServiceInfo, SessionView } from "../../shared/protocol.ts";
import { baseName, relativeTime } from "../format.ts";
import { Chevron, CopyIcon, ExternalIcon, EyeIcon, ServerIcon } from "../icons.tsx";
import { attempt, openWebPreview, stopService, trivium, useStore } from "../store.ts";

const NONE: ServiceInfo[] = [];

/** A session's running services, for the header and the panel. */
export function useServices(path: string): ServiceInfo[] {
	return useStore((s) => s.services[path] ?? NONE);
}

export function serviceCount(count: number): string {
	return count === 1 ? "1 service" : `${count} services`;
}

/** What the service is, in a word or two: its main program, and the port it listens on. */
function serviceName(service: ServiceInfo): string {
	const main = service.processes.find((process) => !/^(bash|sh|conhost|cmd)$/i.test(process.name)) ?? service.processes[0];
	return main?.name || "Process";
}

/** The Code panel's Services view: what this session's commands left running, to open or stop. */
export function ServicesBody({ view }: { view: SessionView }) {
	const services = useServices(view.path);
	if (!services.length) {
		return (
			<div className="side-body panel-empty">
				<span className="panel-empty-icon">
					<ServerIcon size={18} />
				</span>
				<h3>Nothing running</h3>
				<p>Dev servers, watchers and other processes this session's commands leave running show up here, to open or stop.</p>
			</div>
		);
	}
	return (
		<div className="services">
			{services.map((service) => (
				<ServiceCard key={service.id} path={view.path} service={service} />
			))}
			<p className="services-note">Quitting Trivium stops these. Stop one here to free its port sooner.</p>
		</div>
	);
}

function ServiceCard({ path, service }: { path: string; service: ServiceInfo }) {
	const [showOutput, setShowOutput] = useState(false);
	const output = useRef<HTMLPreElement>(null);
	const pids = service.processes.map((process) => process.pid).join(", ");
	useEffect(() => {
		const element = output.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [showOutput, service.output]);
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
					className="btn service-stop"
					disabled={service.stopping}
					title="Stop it and everything it started"
					onClick={() => void stopService(service.id)}
				>
					{service.stopping ? "Stopping…" : "Stop"}
				</button>
			</div>
			<code className="service-command" title={service.command}>
				{service.command}
			</code>
			<div className="service-meta">
				Started {relativeTime(service.startedAt) === "now" ? "just now" : `${relativeTime(service.startedAt)} ago`} in{" "}
				<span title={service.cwd}>{baseName(service.cwd)}</span> · {service.processes.length === 1 ? "process" : "processes"} {pids}
			</div>
			{service.url && (
				<div className="service-url">
					<a className="mono ellipsis" href={service.url} target="_blank" rel="noreferrer" title="Open in browser">
						{service.url}
					</a>
					<button type="button" className="icon-btn" aria-label="Open in Preview" title="Open in Preview" onClick={() => openWebPreview(path, service.url!)}>
						<EyeIcon size={14} />
					</button>
					<button type="button" className="icon-btn" aria-label="Open in browser" title="Open in browser" onClick={() => void attempt(() => trivium.openExternal(service.url!))}>
						<ExternalIcon size={14} />
					</button>
					<button type="button" className="icon-btn" aria-label="Copy address" title="Copy address" onClick={() => void attempt(() => trivium.copyText(service.url!))}>
						<CopyIcon size={14} />
					</button>
				</div>
			)}
			{service.output.trim() ? (
				<>
					<button type="button" className="service-output-toggle" aria-expanded={showOutput} onClick={() => setShowOutput(!showOutput)}>
						<Chevron open={showOutput} down size={11} />
						Output
					</button>
					{showOutput && (
						<pre ref={output} className="service-output">
							{service.output.trimEnd()}
						</pre>
					)}
				</>
			) : (
				<div className="service-meta">No output to show. It may write to a log file instead.</div>
			)}
		</section>
	);
}
