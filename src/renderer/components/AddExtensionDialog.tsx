import { useEffect, useRef, useState } from "react";
import { PACKAGE_GALLERY, packageSource } from "../../shared/packages.ts";
import type { AppDetails, AppId } from "../../shared/protocol.ts";
import { CloseIcon, ExternalIcon, FolderIcon } from "../icons.tsx";
import { attempt, notify, trivium } from "../store.ts";

function preview(text: string): { source?: string; error?: string } {
	if (!text.trim()) return {};
	try {
		return { source: packageSource(text) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Installs a pi package from npm, git or a URL, with the gallery a click away; a local file or folder still works. */
export function AddExtensionDialog({ app, onClose, onAdded }: { app: AppId; onClose: () => void; onAdded: (details: AppDetails) => void }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string>();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus(), []);
	const { source, error } = preview(value);

	const install = async () => {
		if (!source || busy) return;
		setBusy(true);
		setFailed(undefined);
		try {
			const details = await trivium.installPackage(app, value);
			onAdded(details);
			notify(`Installed ${source}`, "info");
			onClose();
		} catch (thrown) {
			// Electron prefixes errors from the main process with the channel name; show only pi's message.
			const message = thrown instanceof Error ? thrown.message : String(thrown);
			setFailed(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
		} finally {
			setBusy(false);
		}
	};

	const pickLocal = async () => {
		const details = await attempt(() => trivium.addExtension(app));
		if (!details) return;
		onAdded(details);
		onClose();
	};

	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
			onKeyDown={(event) => event.key === "Escape" && !busy && onClose()}
		>
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-extension-title" style={{ width: 520 }}>
				<div className="modal-head">
					<h2 id="add-extension-title">Add an extension</h2>
					<button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<p className="set-sub" style={{ margin: 0 }}>
					Install a pi package from npm or git, as <span className="mono">pi install</span> does. It loads in every app and the pi
					CLI; each app can turn it off.
				</p>
				<label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					<span className="ask-field">
						<input
							ref={input}
							autoComplete="off"
							spellCheck={false}
							value={value}
							disabled={busy}
							placeholder="pi-mcp-adapter, npm:@scope/name or github.com/owner/repo"
							onChange={(event) => {
								setValue(event.target.value);
								setFailed(undefined);
							}}
							onKeyDown={(event) => event.key === "Enter" && void install()}
						/>
						<button type="button" className="btn primary" style={{ minHeight: 30 }} disabled={!source || busy} onClick={() => void install()}>
							{busy ? "Installing…" : "Install"}
						</button>
					</span>
					<span className={`add-ext-source${error ? " bad" : ""}`}>
						{source ? (
							<>
								Installs <span className="mono">{source}</span>
							</>
						) : (
							error ?? "A gallery link, an npm name, a git repository or an https URL."
						)}
					</span>
				</label>
				<a className="add-ext-gallery" href={PACKAGE_GALLERY} target="_blank" rel="noreferrer">
					<span>
						<strong>Browse the pi package gallery</strong>
						<span className="mono">{PACKAGE_GALLERY.replace(/^https:\/\//, "")}</span>
					</span>
					<ExternalIcon size={14} />
				</a>
				{failed && <div className="run-error">{failed}</div>}
				<p className="set-sub" style={{ margin: 0 }}>
					Packages run code with your permissions. Review a package's source before installing it.
				</p>
				<div className="modal-foot" style={{ justifyContent: "space-between" }}>
					<button type="button" className="btn ghost" disabled={busy} onClick={() => void pickLocal()}>
						<FolderIcon size={14} /> Choose a file or folder…
					</button>
					<button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}
