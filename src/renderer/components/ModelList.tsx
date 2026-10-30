import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import type { CustomModel } from "../../shared/protocol.ts";
import { Chevron, DownloadIcon, PlusIcon, SearchIcon } from "../icons.tsx";
import { notify } from "../store.ts";
import { t } from "../i18n.tsx";

/** pi's defaults for a model that doesn't give its own. */
const DEFAULT_CONTEXT = 128000;
const DEFAULT_OUTPUT = 16384;

/** A model in the list; only those turned on are saved. */
export type Row = CustomModel & {
	on: boolean;
	/** In a built-in provider's catalog: it can be changed and turned off, but not removed. */
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
		tokens(row.contextWindow ?? fallback(DEFAULT_CONTEXT)) && t("{context} context", { context: tokens(row.contextWindow ?? DEFAULT_CONTEXT) }),
		tokens(row.maxTokens ?? fallback(DEFAULT_OUTPUT)) && t("{n} output", { n: tokens(row.maxTokens ?? DEFAULT_OUTPUT) }),
		row.images && t("Vision"),
		row.reasoning && t("Thinking"),
		row.edited && !row.reset && t("Changed"),
	].filter(Boolean);
	return (
		<li className={`cm-model${row.on ? " on" : ""}${open ? " open" : ""}`}>
			<div className="cm-model-head">
				<button
					type="button"
					role="checkbox"
					aria-checked={row.on}
					aria-label={t("Use {model}", { model: row.id })}
					className="cm-check"
					title={row.builtIn ? t("Turned off, it stays out of Trivium's model picker. The pi CLI still lists it.") : undefined}
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
				<button type="button" className="s-icon-btn" aria-label={t(open ? "Hide details" : "Edit details")} onClick={onToggleOpen}>
					<Chevron open={open} size={11} />
				</button>
			</div>
			{open && (
				<div className="cm-model-body">
					<label className="cm-field wide">
						<span>{t("Display name")}</span>
						<input className="cm-input" value={row.name ?? ""} placeholder={row.id} onChange={(event) => onChange({ name: event.target.value || undefined })} />
					</label>
					<NumberField label={t("Context window")} value={row.contextWindow} placeholder={row.builtIn ? t("Catalog value") : String(DEFAULT_CONTEXT)} onChange={(contextWindow) => onChange({ contextWindow })} />
					<NumberField label={t("Max output tokens")} value={row.maxTokens} placeholder={row.builtIn ? t("Catalog value") : String(DEFAULT_OUTPUT)} onChange={(maxTokens) => onChange({ maxTokens })} />
					<div className="cm-checks">
						<Check on={row.images} label={t("Reads images")} onChange={(images) => onChange({ images })} />
						<Check on={row.reasoning} label={t("Thinks")} onChange={(reasoning) => onChange({ reasoning })} />
						{onRemove && (
							<button type="button" className="s-link cm-remove-model" onClick={onRemove}>
								{t("Remove")}
							</button>
						)}
						{row.builtIn && row.edited && !row.reset && (
							<button type="button" className="s-link cm-reset-model" title={t("Drop the changes in models.json")} onClick={() => onChange({ reset: true })}>
								{t("Use pi's values")}
							</button>
						)}
						{row.reset && <span className="cm-reset-note">{t("pi's values return on save")}</span>}
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

	const update = (modelId: string, patch: Partial<Row>) =>
		setRows((current) => current.map((row) => (row.id === modelId ? { ...row, ...patch } : row)));
	const turnShown = (on: boolean) =>
		setRows((current) => current.map((row) => (shown.includes(row) ? { ...row, on } : row)));

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
			// A catalog lists models this login may not be served, so the server's answer decides which are on. When
			// it names none of them, its IDs are likely spelled differently (a proxy's, say), and the catalog stays.
			const listed = new Set(models.map((model) => model.id));
			const sync = rows.some((row) => row.builtIn && listed.has(row.id));
			const off = sync ? rows.filter((row) => row.builtIn && row.on && !listed.has(row.id)).length : 0;
			setRows((current) => [
				...current.map((row) => (sync && row.builtIn ? { ...row, on: listed.has(row.id) } : row)),
				...added.map((model) => ({ ...model, on: pick })),
			]);
			setFetched((current) => new Set([...current, ...added.map((model) => model.id)]));
			// The list can hold more than the server names, such as a provider's whole catalog, so say whose count it is.
			const counts = { n: models.length, added: added.length, off };
			notify(
				added.length
					? t(off ? "The server lists {n} models, {added} of them new; turned off the {off} it doesn't list" : "The server lists {n} models, {added} of them new", counts)
					: t(off ? "The server lists {n} models; turned off the {off} it doesn't list" : "The server lists {n} models, all already in the list", counts),
				"info",
			);
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
					{t("Models")}
					{rows.length ? <span className="cm-count"> · {t("{on} of {total} on", { on: chosen.length, total: rows.length })}</span> : null}
				</h3>
				{rows.length > 8 && (
					<label className="s-search">
						<SearchIcon size={13} />
						<span className="sr-only">{t("Search models")}</span>
						<input value={query} placeholder={t("Search models")} onChange={(event) => setQuery(event.target.value)} />
					</label>
				)}
				{fetchModels && (
					<button type="button" className="s-btn soft" disabled={fetching} onClick={() => void fetchList()}>
						<DownloadIcon size={13} />
						{t(fetching ? "Fetching…" : rows.length ? "Fetch again" : "Fetch models")}
					</button>
				)}
			</div>
			{fetchError && <div className="run-error">{fetchError}</div>}
			{rows.length ? (
				<>
					{shown.length > 1 && (
						<div className="cm-bulk">
							<button type="button" className="s-link" onClick={() => turnShown(true)}>
								{t(query ? "Turn on all shown" : "Turn all on")}
							</button>
							<button type="button" className="s-link" onClick={() => turnShown(false)}>
								{t(query ? "Turn off all shown" : "Turn all off")}
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
						{!shown.length && <li className="s-empty">{t("No model matches “{query}”.", { query })}</li>}
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
					{t("Add")}
				</button>
			</span>
		</section>
	);
}
