import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import type { CustomModel } from "../../shared/protocol.ts";
import { Chevron, DownloadIcon, PlusIcon, SearchIcon } from "../icons.tsx";
import { notify } from "../store.ts";

/** pi's defaults for a model that doesn't give its own. */
const DEFAULT_CONTEXT = 128000;
const DEFAULT_OUTPUT = 16384;

/** A model in the list; only those turned on are saved. */
export type Row = CustomModel & {
	on: boolean;
	/** In a built-in provider's catalog, so always offered: it can be changed but not turned off or removed. */
	builtIn?: boolean;
	/** models.json changes it already. */
	edited?: boolean;
	/** Its changes are dropped on save. */
	reset?: boolean;
};

/** Electron prefixes errors from the main process with the channel name; show only the message. */
export const messageOf = (thrown: unknown) =>
	(thrown instanceof Error ? thrown.message : String(thrown)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

function tokens(count: number | undefined): string {
	if (!count) return "";
	if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1000)}K`;
}

function NumberField({ label, value, placeholder, onChange }: { label: string; value?: number; placeholder: string; onChange: (value?: number) => void }) {
	return (
		<label className="cm-field">
			<span>{label}</span>
			<input
				className="cm-input mono"
				inputMode="numeric"
				value={value ?? ""}
				placeholder={placeholder}
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
	// A catalog model left blank keeps the catalog's value, which isn't known here.
	const fallback = (count: number) => (row.builtIn ? undefined : count);
	const facts = [
		tokens(row.contextWindow ?? fallback(DEFAULT_CONTEXT)) && `${tokens(row.contextWindow ?? DEFAULT_CONTEXT)} context`,
		tokens(row.maxTokens ?? fallback(DEFAULT_OUTPUT)) && `${tokens(row.maxTokens ?? DEFAULT_OUTPUT)} output`,
		row.images && "Vision",
		row.reasoning && "Thinking",
		row.edited && !row.reset && "Changed",
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
					disabled={row.builtIn}
					title={row.builtIn ? "Part of the provider's catalog, so always offered" : undefined}
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
					<NumberField label="Context window" value={row.contextWindow} placeholder={row.builtIn ? "Catalog value" : String(DEFAULT_CONTEXT)} onChange={(contextWindow) => onChange({ contextWindow })} />
					<NumberField label="Max output tokens" value={row.maxTokens} placeholder={row.builtIn ? "Catalog value" : String(DEFAULT_OUTPUT)} onChange={(maxTokens) => onChange({ maxTokens })} />
					<div className="cm-checks">
						<Check on={row.images} label="Reads images" onChange={(images) => onChange({ images })} />
						<Check on={row.reasoning} label="Thinks" onChange={(reasoning) => onChange({ reasoning })} />
						{onRemove && (
							<button type="button" className="s-link cm-remove-model" onClick={onRemove}>
								Remove
							</button>
						)}
						{row.builtIn && row.edited && !row.reset && (
							<button type="button" className="s-link cm-reset-model" title="Drop the changes in models.json" onClick={() => onChange({ reset: true })}>
								Use pi's values
							</button>
						)}
						{row.reset && <span className="cm-reset-note">pi's values return on save</span>}
					</div>
				</div>
			)}
		</li>
	);
}

/**
 * The models of an endpoint or provider: fetched from it, added by ID, turned on and off, and described one by
 * one. `fetchModels` is unset when Trivium can't ask the server.
 */
export function ModelList({
	rows,
	setRows,
	fetchModels,
	manualPlaceholder,
	emptyText,
}: {
	rows: Row[];
	setRows: Dispatch<SetStateAction<Row[]>>;
	fetchModels?: () => Promise<CustomModel[]>;
	manualPlaceholder: string;
	emptyText: string;
}) {
	/** IDs that came from a fetch rather than from what is saved, which can be unticked but not removed. */
	const [fetched, setFetched] = useState<Set<string>>(() => new Set());
	const [open, setOpen] = useState<string>();
	const [query, setQuery] = useState("");
	const [manual, setManual] = useState("");
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string>();

	const chosen = rows.filter((row) => row.on);
	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		return q ? rows.filter((row) => row.id.toLowerCase().includes(q) || row.name?.toLowerCase().includes(q)) : rows;
	}, [rows, query]);
	const switchable = shown.filter((row) => !row.builtIn);

	const update = (modelId: string, patch: Partial<Row>) =>
		setRows((current) => current.map((row) => (row.id === modelId ? { ...row, ...patch } : row)));
	const turnShown = (on: boolean) =>
		setRows((current) => current.map((row) => (switchable.includes(row) ? { ...row, on } : row)));

	const fetchList = async () => {
		if (!fetchModels) return;
		setFetching(true);
		setFetchError(undefined);
		try {
			const models = await fetchModels();
			// Models already listed keep what the user set; new ones join unticked, unless the list was empty.
			const known = new Set(rows.map((row) => row.id));
			const added = models.filter((model) => !known.has(model.id));
			const pick = rows.length === 0 && models.length <= 12;
			setRows((current) => [...current, ...added.map((model) => ({ ...model, on: pick }))]);
			setFetched((current) => new Set([...current, ...added.map((model) => model.id)]));
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

	return (
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
				{fetchModels && (
					<button type="button" className="s-btn soft" disabled={fetching} onClick={() => void fetchList()}>
						<DownloadIcon size={13} />
						{fetching ? "Fetching…" : rows.length ? "Fetch again" : "Fetch models"}
					</button>
				)}
			</div>
			{fetchError && <div className="run-error">{fetchError}</div>}
			{rows.length ? (
				<>
					{switchable.length > 1 && (
						<div className="cm-bulk">
							<button type="button" className="s-link" onClick={() => turnShown(true)}>
								{query ? "Turn on all shown" : "Turn all on"}
							</button>
							<button type="button" className="s-link" onClick={() => turnShown(false)}>
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
									row.builtIn || fetched.has(row.id)
										? undefined
										: () => setRows((current) => current.filter((entry) => entry.id !== row.id))
								}
							/>
						))}
						{!shown.length && <li className="s-empty">No model matches “{query}”.</li>}
					</ul>
				</>
			) : (
				<div className="cm-empty">{emptyText}</div>
			)}
			<span className="ask-field cm-manual">
				<input
					spellCheck={false}
					className="mono"
					value={manual}
					placeholder={manualPlaceholder}
					onChange={(event) => setManual(event.target.value)}
					onKeyDown={(event) => event.key === "Enter" && addManual()}
				/>
				<button type="button" className="s-btn" disabled={!manual.trim()} onClick={addManual}>
					<PlusIcon size={11} width={2.6} />
					Add
				</button>
			</span>
		</section>
	);
}
