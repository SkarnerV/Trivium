import { useEffect, useRef, useState } from "react";
import { PACKAGE_GALLERY, packageName, packageSource } from "../../shared/packages.ts";
import { RECOMMENDED } from "../../shared/recommended.ts";
import type { AppDetails, AppId } from "../../shared/protocol.ts";
import { CheckIcon, CloseIcon, ExternalIcon, FolderIcon, InfoIcon } from "../icons.tsx";
import { attempt, notify, trivium } from "../store.ts";
import { THEMES } from "../theme.ts";

function preview(text: string): { source?: string; error?: string } {
	if (!text.trim()) return {};
	try {
		return { source: packageSource(text) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Installs a pi package from npm, git or a URL, with the gallery a click away; a local file or folder still works. */
export function AddExtensionDialog({
	app,
	packages,
	onClose,
	onAdded,
}: {
	app: AppId;
	/** Sources of the pi packages already installed. */
	packages: string[];
	onClose: () => void;
	onAdded: (details: AppDetails) => void;
}) {
	const [value, setValue] = useState("");
	/** The source being installed, from the box or a recommendation. */
	const [busy, setBusy] = useState<string>();
	const [failed, setFailed] = useState<string>();
	const [installed, setInstalled] = useState(() => new Set(packages.map(packageName)));
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus(), []);
	const { source, error } = preview(value);

	/** Installs and reports success; the dialog stays open for a recommendation, so several can be added. */
	const run = async (text: string, closeAfter: boolean) => {
		if (busy) return;
		const resolved = packageSource(text);
		setBusy(resolved);
		setFailed(undefined);
		try {
			const details = await trivium.installPackage(app, text);
			onAdded(details);
			setInstalled(new Set(details.packages.map(packageName)));
			notify(`Installed ${packageName(resolved)}`, "info");
			if (closeAfter) onClose();
		} catch (thrown) {
			// Electron prefixes errors from the main process with the channel name; show only pi's message.
			const message = thrown instanceof Error ? thrown.message : String(thrown);
			setFailed(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
		} finally {
			setBusy(undefined);
		}
	};
	const install = () => source && void run(value, true);

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
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-extension-title" style={{ width: 600 }}>
				<div className="modal-head">
					<h2 id="add-extension-title">Add an extension</h2>
					<button type="button" className="icon-btn" aria-label="Close" disabled={Boolean(busy)} onClick={onClose}>
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
							disabled={Boolean(busy)}
							placeholder="pi-mcp-adapter, npm:@scope/name or github.com/owner/repo"
							onChange={(event) => {
								setValue(event.target.value);
								setFailed(undefined);
							}}
							onKeyDown={(event) => event.key === "Enter" && install()}
						/>
						<button type="button" className="btn primary" style={{ minHeight: 30 }} disabled={!source || Boolean(busy)} onClick={install}>
							{busy && busy === source ? "Installing…" : "Install"}
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
				<section className="rec" aria-labelledby="rec-title">
					<h3 id="rec-title">Recommended for {THEMES[app].name}</h3>
					{RECOMMENDED[app].map((item) => {
						const done = installed.has(item.name);
						const working = busy === `npm:${item.name}`;
						return (
							<div key={item.name} className="rec-item">
								<div className="rec-text">
									<a className="rec-name mono" href={`${PACKAGE_GALLERY}/${item.name}`} target="_blank" rel="noreferrer">
										{item.name}
									</a>
									<span className="rec-adds">{item.adds}</span>
									<span className="rec-why">{item.why}</span>
									{item.note && (
										<span className="rec-note">
											<InfoIcon size={12} />
											{item.note}
										</span>
									)}
								</div>
								<button
									type="button"
									className={`btn ${done ? "ghost" : ""} rec-btn`}
									disabled={done || Boolean(busy)}
									onClick={() => void run(`npm:${item.name}`, false)}
								>
									{done ? (
										<>
											<CheckIcon size={12} /> Installed
										</>
									) : working ? (
										"Installing…"
									) : (
										"Install"
									)}
								</button>
							</div>
						);
					})}
				</section>
				<p className="set-sub" style={{ margin: 0 }}>
					Packages run code with your permissions. Review a package's source before installing it.
				</p>
				<div className="modal-foot" style={{ justifyContent: "space-between" }}>
					<button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={() => void pickLocal()}>
						<FolderIcon size={14} /> Choose a file or folder…
					</button>
					<button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={onClose}>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}
