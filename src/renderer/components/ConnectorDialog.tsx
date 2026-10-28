import { useEffect, useRef, useState } from "react";
import { formatPairs, joinCommand, parsePairs, splitCommand } from "../../shared/connectors.ts";
import type { ConnectorInfo, ConnectorsView } from "../../shared/protocol.ts";
import { CloseIcon, TrashIcon } from "../icons.tsx";
import { commandKey } from "../platform.ts";
import { askConfirm, errorText, notify, trivium } from "../store.ts";

type Mode = "stdio" | "http" | "json";

const MODES: { value: Mode; label: string }[] = [
	{ value: "stdio", label: "Command" },
	{ value: "http", label: "URL" },
	{ value: "json", label: "Paste JSON" },
];

/** Adds or edits an MCP server in pi's mcp.json: a program to run, a URL to reach, or entries pasted from another app. */
export function ConnectorDialog({
	server,
	onClose,
	onSaved,
}: {
	/** The server to edit; a new one when unset. */
	server?: ConnectorInfo;
	onClose: () => void;
	/** The servers now, and the names just added or saved. */
	onSaved: (view: ConnectorsView, names: string[]) => void;
}) {
	const [mode, setMode] = useState<Mode>(server?.transport ?? "stdio");
	const [name, setName] = useState(server?.name ?? "");
	const [command, setCommand] = useState(server?.command ? joinCommand([server.command, ...server.args]) : "");
	const [env, setEnv] = useState(formatPairs(server?.env ?? {}, "="));
	const [url, setUrl] = useState(server?.url ?? "");
	const [headers, setHeaders] = useState(formatPairs(server?.headers ?? {}, ":"));
	const [description, setDescription] = useState(server?.description ?? "");
	const [json, setJson] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const first = useRef<HTMLInputElement>(null);
	const pasted = useRef<HTMLTextAreaElement>(null);
	useEffect(() => (mode === "json" ? pasted.current : first.current)?.focus(), [mode]);

	const save = async () => {
		setError(undefined);
		setSaving(true);
		try {
			if (mode === "json") {
				const { view, added } = await trivium.importConnectors(json, name.trim() || undefined);
				notify(`Added ${added.join(", ")}`, "info");
				onSaved(view, added);
			} else {
				const [program = "", ...args] = splitCommand(command);
				const input = {
					name: name.trim(),
					transport: mode,
					command: program,
					args,
					env: parsePairs(env, "="),
					url: url.trim(),
					headers: parsePairs(headers, ":"),
					description: description.trim(),
				};
				onSaved(await trivium.saveConnector(input, server?.name), [input.name]);
				notify(`Saved ${input.name}`, "info");
			}
			onClose();
		} catch (thrown) {
			setError(errorText(thrown));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!server) return;
		const ok = await askConfirm({
			title: `Remove ${server.name}?`,
			message: "Its tools disappear from new sessions here and in the pi CLI. A sign-in stays saved in case you add it again.",
			confirmLabel: "Remove",
		});
		if (!ok) return;
		try {
			onSaved(await trivium.removeConnector(server.name), []);
			onClose();
		} catch (thrown) {
			setError(errorText(thrown));
		}
	};

	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !saving) onClose();
				if (event.key === "Enter" && commandKey(event) && !saving) void save();
			}}
		>
			<div className="modal cm" role="dialog" aria-modal="true" aria-labelledby="cn-title" style={{ width: 600 }}>
				<div className="modal-head">
					<h2 id="cn-title">{server ? `Edit ${server.name}` : "Add an MCP server"}</h2>
					<button type="button" className="icon-btn" aria-label="Close" disabled={saving} onClick={onClose}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<p className="add-ext-intro">
					Saved in pi's <span className="mono">mcp.json</span>, so the pi CLI connects to the same servers.
				</p>

				{!server && (
					<div className="seg cn-modes" role="tablist" aria-label="How to add it">
						{MODES.map((option) => (
							<button key={option.value} type="button" role="tab" aria-selected={mode === option.value} onClick={() => setMode(option.value)}>
								{option.label}
							</button>
						))}
					</div>
				)}

				<div className="cm-grid">
					<label className="cm-field wide">
						<span>{mode === "json" ? "Name, for a single entry" : "Name"}</span>
						<input
							ref={first}
							className="cm-input mono"
							value={name}
							placeholder={mode === "http" ? "docs" : "filesystem"}
							spellCheck={false}
							onChange={(event) => setName(event.target.value)}
						/>
						<span className="cm-help">
							Letters, digits, - and _. Its tools are named <span className="mono">mcp__{name.trim() || "name"}__tool</span>.
						</span>
					</label>

					{mode === "stdio" && (
						<>
							<label className="cm-field wide">
								<span>Command</span>
								<input
									className="cm-input mono"
									value={command}
									placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents"
									spellCheck={false}
									onChange={(event) => setCommand(event.target.value)}
								/>
								<span className="cm-help">
									A program and its arguments, run without a shell. Quote an argument with spaces; <span className="mono">~/</span> is your
									home folder.
								</span>
							</label>
							<label className="cm-field wide">
								<span>Environment</span>
								<textarea
									className="cm-input cm-textarea"
									value={env}
									placeholder="API_KEY=${MY_API_KEY}"
									spellCheck={false}
									onChange={(event) => setEnv(event.target.value)}
								/>
								<span className="cm-help">
									One <span className="mono">NAME=value</span> per line. <span className="mono">{"${NAME}"}</span> reads your environment,{" "}
									<span className="mono">!command</span> a command's output.
								</span>
							</label>
						</>
					)}

					{mode === "http" && (
						<>
							<label className="cm-field wide">
								<span>URL</span>
								<input
									className="cm-input mono"
									value={url}
									placeholder="https://mcp.example.com/mcp"
									spellCheck={false}
									onChange={(event) => setUrl(event.target.value)}
								/>
								<span className="cm-help">Streamable HTTP. For a server that lists an /sse address, try /mcp instead.</span>
							</label>
							<label className="cm-field wide">
								<span>Headers</span>
								<textarea
									className="cm-input cm-textarea"
									value={headers}
									placeholder="Authorization: Bearer ${DOCS_TOKEN}"
									spellCheck={false}
									onChange={(event) => setHeaders(event.target.value)}
								/>
								<span className="cm-help">
									One <span className="mono">Name: value</span> per line. Without an Authorization header, you sign in through the browser
									when the server asks.
								</span>
							</label>
						</>
					)}

					{mode === "json" ? (
						<label className="cm-field wide">
							<span>JSON</span>
							<textarea
								ref={pasted}
								className="cm-input cm-textarea cn-json"
								value={json}
								placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n  }\n}'}
								spellCheck={false}
								onChange={(event) => setJson(event.target.value)}
							/>
							<span className="cm-help">
								From Claude Desktop, Claude Code, Cursor or VS Code: the whole <span className="mono">mcpServers</span> block, or one server's entry.
							</span>
						</label>
					) : (
						<label className="cm-field wide">
							<span>Description</span>
							<input
								className="cm-input"
								value={description}
								placeholder="Optional"
								onChange={(event) => setDescription(event.target.value)}
							/>
							<span className="cm-help">What it offers, in a sentence. The agent reads it to decide when to look at its tools.</span>
						</label>
					)}
				</div>

				{error && <div className="run-error">{error}</div>}
				<div className="modal-foot" style={{ justifyContent: server ? "space-between" : "flex-end" }}>
					{server && (
						<button type="button" className="btn ghost cm-delete" disabled={saving} onClick={() => void remove()}>
							<TrashIcon size={14} />
							Remove server
						</button>
					)}
					<span className="btn-row">
						<button type="button" className="btn ghost" disabled={saving} onClick={onClose}>
							Cancel
						</button>
						<button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
							{saving ? "Saving…" : server ? "Save" : "Add"}
						</button>
					</span>
				</div>
			</div>
		</div>
	);
}
