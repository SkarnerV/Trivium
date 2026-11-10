import { useEffect, useRef, useState } from "react";
import type { ProxyKeyInfo, ProxyStatus } from "../../shared/protocol.ts";
import { CloseIcon, CopyIcon, TrashIcon } from "../icons.tsx";
import { askConfirm, attempt, notify, trivium } from "../store.ts";
import { messageOf } from "./ModelList.tsx";
import { t } from "../i18n.tsx";

/**
 * Adds a key for the API proxy, or renames or replaces one. A new or replaced key is shown once, in full, to
 * copy into the client: Trivium keeps only what recognizes it.
 */
export function ProxyKeyDialog({
	item,
	onClose,
	onChanged,
}: {
	/** The key to edit; a new one when unset. */
	item?: ProxyKeyInfo;
	onClose: () => void;
	/** `created` is set when a key was added or given a new value. */
	onChanged: (status: ProxyStatus, created: boolean) => void;
}) {
	const [name, setName] = useState(item?.name ?? "");
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	/** The full key, once saved. */
	const [created, setCreated] = useState<string>();
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => first.current?.focus(), []);

	const save = async () => {
		setError(undefined);
		setSaving(true);
		try {
			const result = await trivium.saveProxyKey(item?.id, name, value);
			onChanged(result.status, Boolean(result.key));
			if (result.key) setCreated(result.key);
			else onClose();
		} catch (thrown) {
			setError(messageOf(thrown));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!item) return;
		const ok = await askConfirm({
			title: t("Remove {name}?", { name: item.name }),
			message: t("Clients that use this key can no longer connect. Requests already under way finish."),
			confirmLabel: t("Remove"),
		});
		if (!ok) return;
		try {
			onChanged(await trivium.removeProxyKey(item.id), false);
			onClose();
		} catch (thrown) {
			setError(messageOf(thrown));
		}
	};

	const copy = async () => {
		if (!created) return;
		await attempt(() => trivium.copyText(created));
		notify(t("Copied"), "info");
	};

	return (
		<div
			className="scrim"
			// A key shown once isn't lost to a stray click: only its own button closes it.
			onMouseDown={(event) => event.target === event.currentTarget && !saving && !created && onClose()}
			onKeyDown={(event) => event.key === "Escape" && !saving && !created && onClose()}
		>
			<div className="modal cm" role="dialog" aria-modal="true" aria-labelledby="pk-title" style={{ width: 520 }}>
				<div className="modal-head">
					<h2 id="pk-title">{created ? t("Copy your API key") : item ? t("Edit {name}", { name: item.name }) : t("Add an API key")}</h2>
					{!created && (
						<button type="button" className="icon-btn" aria-label={t("Close")} disabled={saving} onClick={onClose}>
							<CloseIcon size={15} width={2} />
						</button>
					)}
				</div>
				{created ? (
					<>
						<p className="add-ext-intro">{t("This is the only time Trivium shows the whole key. Paste it into the app that will connect. If you lose it, edit the key to give it a new value.")}</p>
						<div className="px-url">
							<input className="cm-input mono" readOnly value={created} aria-label={t("API key")} onFocus={(event) => event.target.select()} />
							<button type="button" className="s-btn accent" onClick={() => void copy()}>
								<CopyIcon size={13} />
								{t("Copy")}
							</button>
						</div>
						<div className="modal-foot" style={{ justifyContent: "flex-end" }}>
							<button type="button" className="btn primary" onClick={onClose}>
								{t("Done")}
							</button>
						</div>
					</>
				) : (
					<>
						<p className="add-ext-intro">{t("Give each app that connects its own key, so you can turn one off without disturbing the others.")}</p>
						<div className="cm-grid">
							<label className="cm-field wide">
								<span>{t("Name")}</span>
								<input
									ref={first}
									className="cm-input"
									value={name}
									maxLength={80}
									placeholder={t("Such as the app that will use it")}
									onChange={(event) => setName(event.target.value)}
									onKeyDown={(event) => event.key === "Enter" && !saving && void save()}
								/>
							</label>
							<label className="cm-field wide">
								<span>{t("Key")}</span>
								<input
									className="cm-input mono"
									type="password"
									autoComplete="off"
									spellCheck={false}
									value={value}
									maxLength={256}
									placeholder={item ? t("Leave empty to keep the current key") : t("Leave empty for Trivium to make one")}
									onChange={(event) => setValue(event.target.value)}
									onKeyDown={(event) => event.key === "Enter" && !saving && void save()}
								/>
								<span className="cm-help">{t("Your own key can be 16 to 256 letters, digits, dots, dashes, underscores or tildes.")}</span>
							</label>
						</div>
						{error && <div className="run-error">{error}</div>}
						<div className="modal-foot" style={{ justifyContent: item ? "space-between" : "flex-end" }}>
							{item && (
								<button type="button" className="btn ghost cm-delete" disabled={saving} onClick={() => void remove()}>
									<TrashIcon size={14} />
									{t("Remove key")}
								</button>
							)}
							<span className="btn-row">
								<button type="button" className="btn ghost" disabled={saving} onClick={onClose}>
									{t("Cancel")}
								</button>
								<button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
									{t(saving ? "Saving…" : "Save")}
								</button>
							</span>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
