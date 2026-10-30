import { useEffect, useMemo, useState } from "react";
import type { CustomModel, PresetModelField, PresetProvider, PresetProviderChanges } from "../../shared/protocol.ts";
import { CloseIcon } from "../icons.tsx";
import { notify, trivium } from "../store.ts";
import { ModelList, messageOf, type Row } from "./ModelList.tsx";
import { t, tx } from "../i18n.tsx";

const FIELDS: PresetModelField[] = ["name", "contextWindow", "maxTokens", "images", "reasoning"];

/** The fields of a catalog model the user changed since it loaded, as models.json changes to make. */
function changedFields(row: Row, loaded: Row): PresetProviderChanges["edits"][number]["fields"] {
	const fields: Record<string, unknown> = {};
	for (const field of FIELDS) if (row[field] !== loaded[field]) fields[field] = row[field] ?? null;
	return fields;
}

/**
 * Changes a built-in provider's models through pi's models.json, as a custom endpoint's are edited: its base URL,
 * each catalog model's limits and abilities, and models its catalog doesn't list yet.
 */
export function PresetModelsDialog({ providerId, onClose, onSaved }: { providerId: string; onClose: () => void; onSaved: () => void }) {
	const [preset, setPreset] = useState<PresetProvider>();
	const [baseUrl, setBaseUrl] = useState("");
	const [rows, setRows] = useState<Row[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		trivium.presetProvider(providerId).then(
			(loaded) => {
				setPreset(loaded);
				setBaseUrl(loaded.baseUrl);
				setRows([
					...loaded.builtIn.map((model) => ({ ...model, on: !loaded.hidden.includes(model.id), builtIn: true })),
					...loaded.added.map((model) => ({ ...model, on: true })),
				]);
			},
			(thrown) => setError(messageOf(thrown)),
		);
	}, [providerId]);

	const loaded = useMemo(
		() => new Map(preset?.builtIn.map((model) => [model.id, { ...model, on: true, builtIn: true } as Row])),
		[preset],
	);

	const save = async () => {
		if (!preset) return;
		setError(undefined);
		const edits = rows.flatMap((row) => {
			const before = loaded.get(row.id);
			if (!before) return [];
			const fields = changedFields(row, before);
			return row.reset || Object.keys(fields).length ? [{ id: row.id, reset: row.reset, fields }] : [];
		});
		const added = rows
			.filter((row) => !row.builtIn && row.on)
			.map(({ id, name, contextWindow, maxTokens, images, reasoning }): CustomModel => ({ id, name, contextWindow, maxTokens, images, reasoning }));
		const hidden = rows.filter((row) => row.builtIn && !row.on).map((row) => row.id);
		setSaving(true);
		try {
			await trivium.savePresetProvider(preset.id, { baseUrl: baseUrl.trim(), edits, added, hidden });
			notify(t("Saved {name}'s models", { name: preset.name }), "info");
			onSaved();
			onClose();
		} catch (thrown) {
			setError(messageOf(thrown));
		} finally {
			setSaving(false);
		}
	};

	const name = preset?.name ?? providerId;
	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
			onKeyDown={(event) => event.key === "Escape" && !saving && onClose()}
		>
			<div className="modal cm" role="dialog" aria-modal="true" aria-labelledby="cm-title" style={{ width: 640 }}>
				<div className="modal-head">
					<h2 id="cm-title">{t("{name} models", { name })}</h2>
					<button type="button" className="icon-btn" aria-label={t("Close")} disabled={saving} onClick={onClose}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<p className="add-ext-intro">
					{tx("Change what pi knows of {name}'s models, or add ones its catalog doesn't list yet. Saved in pi's {file}, so the pi CLI sees the same.", {
						name,
						file: <span className="mono">models.json</span>,
					})}
				</p>

				{preset && (
					<>
						<div className="cm-grid">
							<label className="cm-field wide">
								<span>{t("Base URL")}</span>
								<input
									className="cm-input mono"
									value={baseUrl}
									placeholder={preset.defaultBaseUrl}
									spellCheck={false}
									onChange={(event) => setBaseUrl(event.target.value)}
								/>
								<span className="cm-help">
									{t("Leave empty for {name}'s own. A proxy's URL here applies to every model, and the login stays as it is.", { name })}
								</span>
							</label>
						</div>
						<ModelList
							rows={rows}
							setRows={setRows}
							fetchModels={preset.api ? () => trivium.fetchPresetModels(preset.id, baseUrl) : undefined}
							manualPlaceholder={t("Add a model by ID")}
							emptyText={t("{name} lists no models yet. Add one by its ID.", { name })}
						/>
					</>
				)}

				{error && <div className="run-error">{error}</div>}
				<div className="modal-foot">
					<span className="btn-row">
						<button type="button" className="btn ghost" disabled={saving} onClick={onClose}>
							{t("Cancel")}
						</button>
						<button type="button" className="btn primary" disabled={saving || !preset} onClick={() => void save()}>
							{t(saving ? "Saving…" : "Save")}
						</button>
					</span>
				</div>
			</div>
		</div>
	);
}
