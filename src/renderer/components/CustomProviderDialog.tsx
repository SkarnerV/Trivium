import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomApi, CustomModel, CustomProvider } from "../../shared/protocol.ts";
import { Chevron, CloseIcon, DownloadIcon, PlusIcon, SearchIcon, TrashIcon } from "../icons.tsx";
import { askConfirm, notify, trivium } from "../store.ts";
import { Dropdown } from "./Dropdown.tsx";

const APIS: { value: CustomApi; label: string; baseUrl: string }[] = [
	{ value: "openai-completions", label: "OpenAI-compatible (Chat Completions)", baseUrl: "http://localhost:11434/v1" },
	{ value: "openai-responses", label: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
	{ value: "anthropic-messages", label: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
	{ value: "google-generative-ai", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
];

/** pi's defaults for a model that doesn't give its own. */
const DEFAULT_CONTEXT = 128000;
const DEFAULT_OUTPUT = 16384;

/** A model in the list; only those turned on are saved. */
type Row = CustomModel & { on: boolean };

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

/** Electron prefixes errors from the main process with the channel name; show only the message. */
const messageOf = (thrown: unknown) =>
	(thrown instanceof Error ? thrown.message : String(thrown)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

function tokens(count: number | undefined): string {
	if (!count) return "";
	if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1000)}K`;
}

function NumberField({ label, value, placeholder, onChange }: { label: string; value?: number; placeholder: number; onChange: (value?: number) => void }) {
	return (
		<label className="cm-field">
			<span>{label}</span>
			<input
				className="cm-input mono"
				inputMode="numeric"
				value={value ?? ""}
				placeholder={String(placeholder)}
				onChange={(event) => {
					const digits = event.target.value.replace(/[^\d]/g, "");
					onChange(digits ? Number(digits) : undefined);
				}}
			/>
		</label>
	);
}

function Check({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
	return (
		<button type="button" role="checkbox" aria-checked={on} className="cm-check" onClick={() => onChange(!on)}>
			<span className="cm-box" />
			{label}
		</button>
	);
}

function ModelRow({
	row,
	open,
	onToggleOpen,
	onChange,
	onRemove,
}: {
	row: Row;
	open: boolean;
	onToggleOpen: () => void;
	onChange: (patch: Partial<Row>) => void;
	onRemove?: () => void;
}) {
	const facts = [
		`${tokens(row.contextWindow ?? DEFAULT_CONTEXT)} context`,
		`${tokens(row.maxTokens ?? DEFAULT_OUTPUT)} output`,
		row.images && "Vision",
		row.reasoning && "Thinking",
	].filter(Boolean);
	return (
		<li className={`cm-model${row.on ? " on" : ""}${open ? " open" : ""}`}>
			<div className="cm-model-head">
				<button
					type="button"
					role="checkbox"
					aria-checked={row.on}
					aria-label={`Use ${row.id}`}
					className="cm-check"
					onClick={() => onChange({ on: !row.on })}
				>
					<span className="cm-box" />
				</button>
				<button type="button" className="cm-model-text" aria-expanded={open} onClick={onToggleOpen}>
					<span className={`cm-model-id ellipsis${row.name ? "" : " mono"}`} title={row.id}>
						{row.name || row.id}
					</span>
					<span className="cm-model-facts ellipsis">
						{row.name && <span className="mono">{row.id}</span>}
						{row.name && " · "}
						{facts.join(" · ")}
					</span>
				</button>
				<button type="button" className="s-icon-btn" aria-label={open ? "Hide details" : "Edit details"} onClick={onToggleOpen}>
					<Chevron open={open} size={11} />
				</button>
			</div>
			{open && (
				<div className="cm-model-body">
					<label className="cm-field wide">
						<span>Display name</span>
						<input className="cm-input" value={row.name ?? ""} placeholder={row.id} onChange={(event) => onChange({ name: event.target.value || undefined })} />
					</label>
					<NumberField label="Context window" value={row.contextWindow} placeholder={DEFAULT_CONTEXT} onChange={(contextWindow) => onChange({ contextWindow })} />
					<NumberField label="Max output tokens" value={row.maxTokens} placeholder={DEFAULT_OUTPUT} onChange={(maxTokens) => onChange({ maxTokens })} />
					<div className="cm-checks">
						<Check on={row.images} label="Reads images" onChange={(images) => onChange({ images })} />
						<Check on={row.reasoning} label="Thinks" onChange={(reasoning) => onChange({ reasoning })} />
						{onRemove && (
							<button type="button" className="s-link cm-remove-model" onClick={onRemove}>
								Remove
							</button>
						)}
					</div>
				</div>
			)}
		</li>
	);
}

/** Adds or edits an endpoint in pi's models.json: where it is, how to authenticate, and the models to offer. */
export function CustomProviderDialog({
	provider,
	takenIds,
	onClose,
	onSaved,
}: {
	/** The provider to edit; a new one when unset. */
	provider?: CustomProvider;
	/** Provider IDs already in use, which a new ID can't take. */
	takenIds: string[];
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState(provider?.name ?? "");
	const [id, setId] = useState(provider?.id ?? "");
	const [idTouched, setIdTouched] = useState(Boolean(provider));
	const [api, setApi] = useState<CustomApi>(provider?.api ?? "openai-completions");
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");
	const [rows, setRows] = useState<Row[]>(() => provider?.models.map((model) => ({ ...model, on: true })) ?? []);
	/** IDs that came from a fetch rather than from the saved provider, which can be unticked but not removed. */
	const [fetched, setFetched] = useState<Set<string>>(() => new Set());
	const [open, setOpen] = useState<string>();
	const [query, setQuery] = useState("");
	const [manual, setManual] = useState("");
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => first.current?.focus(), []);

	const apiInfo = APIS.find((entry) => entry.value === api)!;
	const providerId = idTouched ? id : slug(name);
	const chosen = rows.filter((row) => row.on);
	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		return q ? rows.filter((row) => row.id.toLowerCase().includes(q) || row.name?.toLowerCase().includes(q)) : rows;
	}, [rows, query]);
	// Shown keys are pi's own syntax, which a password field would hide.
	const keyIsReference = /^[$!]/.test(apiKey.trim());

	const update = (modelId: string, patch: Partial<Row>) =>
		setRows((current) => current.map((row) => (row.id === modelId ? { ...row, ...patch } : row)));

	const fetchList = async () => {
		setFetching(true);
		setFetchError(undefined);
		try {
			const models = await trivium.fetchModels({ baseUrl: baseUrl.trim() || apiInfo.baseUrl, api, apiKey });
			// Models already listed keep what the user set; new ones join unticked, unless the list was empty.
			const known = new Set(rows.map((row) => row.id));
			const added = models.filter((model) => !known.has(model.id));
			const pick = rows.length === 0 && models.length <= 12;
			setRows((current) => [...current, ...added.map((model) => ({ ...model, on: pick }))]);
			setFetched((current) => new Set([...current, ...added.map((model) => model.id)]));
			if (!baseUrl.trim()) setBaseUrl(apiInfo.baseUrl);
			notify(added.length ? `Found ${models.length} models, ${added.length} new` : `Found ${models.length} models, all listed already`, "info");
		} catch (thrown) {
			setFetchError(messageOf(thrown));
		} finally {
			setFetching(false);
		}
	};

	const addManual = () => {
		const modelId = manual.trim();
		if (!modelId) return;
		if (rows.some((row) => row.id === modelId)) update(modelId, { on: true });
		else setRows((current) => [...current, { id: modelId, images: false, reasoning: false, on: true }]);
		setManual("");
		setOpen(modelId);
	};

	const save = async () => {
		setError(undefined);
		if (!providerId) return setError("Give the endpoint a name.");
		if (!provider && takenIds.includes(providerId)) return setError(`A provider called “${providerId}” exists already. Choose another ID.`);
		if (!chosen.length) return setError("Choose at least one model, or add one by its ID.");
		setSaving(true);
		try {
			await trivium.saveCustomProvider(
				{
					id: providerId,
					name: name.trim() || providerId,
					baseUrl: baseUrl.trim() || apiInfo.baseUrl,
					api,
					apiKey: apiKey.trim(),
					models: chosen.map(({ on: _on, ...model }) => model),
				},
				provider?.id,
			);
			notify(`Saved ${name.trim() || providerId}`, "info");
			onSaved();
			onClose();
		} catch (thrown) {
			setError(messageOf(thrown));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!provider) return;
		const ok = await askConfirm({
			title: `Remove ${provider.name}?`,
			message: "Its models disappear from Trivium and the pi CLI. Sessions that use them stay as they are.",
			confirmLabel: "Remove",
		});
		if (!ok) return;
		try {
			await trivium.removeCustomProvider(provider.id);
			onSaved();
			onClose();
		} catch (thrown) {
			setError(messageOf(thrown));
		}
	};

	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
			onKeyDown={(event) => event.key === "Escape" && !document.querySelector(".dd.open") && !saving && onClose()}
		>
			<div className="modal cm" role="dialog" aria-modal="true" aria-labelledby="cm-title" style={{ width: 640 }}>
				<div className="modal-head">
					<h2 id="cm-title">{provider ? `Edit ${provider.name}` : "Add a custom endpoint"}</h2>
					<button type="button" className="icon-btn" aria-label="Close" disabled={saving} onClick={onClose}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<p className="add-ext-intro">
					For Ollama, LM Studio, vLLM, a proxy or any server that speaks one of these APIs. Saved in pi's{" "}
					<span className="mono">models.json</span>, so the pi CLI offers the same models.
				</p>

				<div className="cm-grid">
					<label className="cm-field">
						<span>Name</span>
						<input ref={first} className="cm-input" value={name} placeholder="Ollama" onChange={(event) => setName(event.target.value)} />
					</label>
					<label className="cm-field">
						<span>ID</span>
						<input
							className="cm-input mono"
							value={providerId}
							placeholder="ollama"
							spellCheck={false}
							onChange={(event) => {
								setIdTouched(true);
								setId(event.target.value.trim());
							}}
						/>
					</label>
					<div className="cm-field wide">
						<span>API</span>
						<Dropdown label="API" value={api} options={APIS} onChange={(value) => setApi(value as CustomApi)} />
					</div>
					<label className="cm-field wide">
						<span>Base URL</span>
						<input
							className="cm-input mono"
							value={baseUrl}
							placeholder={apiInfo.baseUrl}
							spellCheck={false}
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					</label>
					<label className="cm-field wide">
						<span>API key</span>
						<input
							className="cm-input mono"
							type={keyIsReference ? "text" : "password"}
							autoComplete="off"
							spellCheck={false}
							value={apiKey}
							placeholder="Not needed for local servers"
							onChange={(event) => setApiKey(event.target.value)}
						/>
						<span className="cm-help">
							Written to models.json as typed. <span className="mono">$NAME</span> reads an environment variable instead,{" "}
							<span className="mono">!command</span> a command's output.
						</span>
					</label>
				</div>

				<section className="cm-models" aria-labelledby="cm-models-title">
					<div className="cm-models-head">
						<h3 id="cm-models-title">
							Models{rows.length ? <span className="cm-count"> · {chosen.length} of {rows.length} on</span> : null}
						</h3>
						{rows.length > 8 && (
							<label className="s-search">
								<SearchIcon size={13} />
								<span className="sr-only">Search models</span>
								<input value={query} placeholder="Search models" onChange={(event) => setQuery(event.target.value)} />
							</label>
						)}
						<button type="button" className="s-btn soft" disabled={fetching} onClick={() => void fetchList()}>
							<DownloadIcon size={13} />
							{fetching ? "Fetching…" : rows.length ? "Fetch again" : "Fetch models"}
						</button>
					</div>
					{fetchError && <div className="run-error">{fetchError}</div>}
					{rows.length ? (
						<>
							{shown.length > 1 && (
								<div className="cm-bulk">
									<button type="button" className="s-link" onClick={() => setRows((current) => current.map((row) => (shown.includes(row) ? { ...row, on: true } : row)))}>
										{query ? "Turn on all shown" : "Turn all on"}
									</button>
									<button type="button" className="s-link" onClick={() => setRows((current) => current.map((row) => (shown.includes(row) ? { ...row, on: false } : row)))}>
										{query ? "Turn off all shown" : "Turn all off"}
									</button>
								</div>
							)}
							<ul className="cm-list">
								{shown.map((row) => (
									<ModelRow
										key={row.id}
										row={row}
										open={open === row.id}
										onToggleOpen={() => setOpen(open === row.id ? undefined : row.id)}
										onChange={(patch) => update(row.id, patch)}
										onRemove={
											fetched.has(row.id) ? undefined : () => setRows((current) => current.filter((entry) => entry.id !== row.id))
										}
									/>
								))}
								{!shown.length && <li className="s-empty">No model matches “{query}”.</li>}
							</ul>
						</>
					) : (
						<div className="cm-empty">Fetch the endpoint's models, or add one by its ID. Limits and abilities can be set per model.</div>
					)}
					<span className="ask-field cm-manual">
						<input
							spellCheck={false}
							className="mono"
							value={manual}
							placeholder="Add a model by ID, such as qwen3:8b"
							onChange={(event) => setManual(event.target.value)}
							onKeyDown={(event) => event.key === "Enter" && addManual()}
						/>
						<button type="button" className="s-btn" disabled={!manual.trim()} onClick={addManual}>
							<PlusIcon size={11} width={2.6} />
							Add
						</button>
					</span>
				</section>

				{error && <div className="run-error">{error}</div>}
				<div className="modal-foot" style={{ justifyContent: provider ? "space-between" : "flex-end" }}>
					{provider && (
						<button type="button" className="btn ghost cm-delete" disabled={saving} onClick={() => void remove()}>
							<TrashIcon size={14} />
							Remove endpoint
						</button>
					)}
					<span className="btn-row">
						<button type="button" className="btn ghost" disabled={saving} onClick={onClose}>
							Cancel
						</button>
						<button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
							{saving ? "Saving…" : "Save"}
						</button>
					</span>
				</div>
			</div>
		</div>
	);
}
