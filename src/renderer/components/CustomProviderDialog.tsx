import { useEffect, useRef, useState } from "react";
import type { CustomApi, CustomProvider } from "../../shared/protocol.ts";
import { CloseIcon, TrashIcon } from "../icons.tsx";
import { askConfirm, notify, trivium } from "../store.ts";
import { Dropdown } from "./Dropdown.tsx";
import { ModelList, messageOf, type Row } from "./ModelList.tsx";

const APIS: { value: CustomApi; label: string; baseUrl: string }[] = [
	{ value: "openai-completions", label: "OpenAI-compatible (Chat Completions)", baseUrl: "http://localhost:11434/v1" },
	{ value: "openai-responses", label: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
	{ value: "anthropic-messages", label: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
	{ value: "google-generative-ai", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
];

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

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
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => first.current?.focus(), []);

	const apiInfo = APIS.find((entry) => entry.value === api)!;
	const providerId = idTouched ? id : slug(name);
	const chosen = rows.filter((row) => row.on);
	// Shown keys are pi's own syntax, which a password field would hide.
	const keyIsReference = /^[$!]/.test(apiKey.trim());

	const fetchModels = async () => {
		const models = await trivium.fetchModels({ baseUrl: baseUrl.trim() || apiInfo.baseUrl, api, apiKey });
		if (!baseUrl.trim()) setBaseUrl(apiInfo.baseUrl);
		return models;
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

				<ModelList
					rows={rows}
					setRows={setRows}
					fetchModels={fetchModels}
					manualPlaceholder="Add a model by ID, such as qwen3:8b"
					emptyText="Fetch the endpoint's models, or add one by its ID. Limits and abilities can be set per model."
				/>

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
