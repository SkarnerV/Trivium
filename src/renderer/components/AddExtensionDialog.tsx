import { useEffect, useRef, useState } from "react";
import { PACKAGE_GALLERY, packageName, packageSource } from "../../shared/packages.ts";
import { RECOMMENDED } from "../../shared/recommended.ts";
import type { AppDetails, AppId } from "../../shared/protocol.ts";
import { CheckIcon, Chevron, CloseIcon, ExternalIcon, FolderIcon, InfoIcon } from "../icons.tsx";
import { attempt, notify, trivium } from "../store.ts";
import { THEMES } from "../theme.ts";
import { t, tx } from "../i18n.tsx";

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
	removed,
	onRestore,
	onClose,
	onAdded,
}: {
	app: AppId;
	/** Sources of the pi packages already installed. */
	packages: string[];
	/** Packages Trivium ships for this app that the user removed. */
	removed: string[];
	onRestore: (name: string) => Promise<unknown>;
	onClose: () => void;
	onAdded: (details: AppDetails) => void;
}) {
	const [value, setValue] = useState("");
	/** The source being installed, from the box or a recommendation. */
	const [busy, setBusy] = useState<string>();
	const [failed, setFailed] = useState<string>();
	const [installed, setInstalled] = useState(() => new Set(packages.map(packageName)));
	/** The recommendation showing why it suits the app and any caveat. */
	const [open, setOpen] = useState<string>();
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
			notify(t("Installed {name}", { name: packageName(resolved) }), "info");
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
	const restore = async (name: string) => {
		if (busy) return;
		setBusy(`npm:${name}`);
		try {
			await onRestore(name);
			notify(t("Added {name} back", { name }), "info");
		} finally {
			setBusy(undefined);
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
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-extension-title" style={{ width: 600 }}>
				<div className="modal-head">
					<h2 id="add-extension-title">{t("Add an extension")}</h2>
					<button type="button" className="icon-btn" aria-label={t("Close")} disabled={Boolean(busy)} onClick={onClose}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<p className="add-ext-intro">{t("A pi package loads in every mode and the pi CLI. Each mode can turn it off.")}</p>
				<label className="add-ext-input">
					<span className="ask-field">
						<input
							ref={input}
							autoComplete="off"
							spellCheck={false}
							value={value}
							disabled={Boolean(busy)}
							placeholder={t("pi-mcp-adapter, npm:@scope/name or github.com/owner/repo")}
							onChange={(event) => {
								setValue(event.target.value);
								setFailed(undefined);
							}}
							onKeyDown={(event) => event.key === "Enter" && install()}
						/>
						<button type="button" className="btn primary" style={{ minHeight: 30 }} disabled={!source || Boolean(busy)} onClick={install}>
							{t(busy && busy === source ? "Installing…" : "Install")}
						</button>
					</span>
					<span className={`add-ext-source${error ? " bad" : ""}`}>
						{source
							? tx("Installs {source}", { source: <span className="mono">{source}</span> })
							: (error ?? t("An npm name, a git repository, an https URL or a gallery link."))}
					</span>
				</label>
				{failed && <div className="run-error">{failed}</div>}
				<section className="rec" aria-labelledby="rec-title">
					<div className="rec-head">
						<h3 id="rec-title">{t("Recommended for {mode}", { mode: t(THEMES[app].name) })}</h3>
						<a className="rec-gallery" href={PACKAGE_GALLERY} target="_blank" rel="noreferrer">
							{t("Browse the gallery")}
							<ExternalIcon size={12} />
						</a>
					</div>
					<ul className="rec-list">
						{RECOMMENDED[app].map((item) => {
							const done = installed.has(item.name);
							const working = busy === `npm:${item.name}`;
							// Shipped with Trivium: nothing to download, only to bring back if removed.
							const shipped = item.builtIn && !done;
							const isRemoved = shipped && removed.includes(item.name);
							const isOpen = open === item.name;
							return (
								<li key={item.name} className={`rec-item${isOpen ? " open" : ""}`}>
									<button
										type="button"
										className="rec-text"
										aria-expanded={isOpen}
										title={t(isOpen ? "Hide details" : "Show details")}
										onClick={() => setOpen(isOpen ? undefined : item.name)}
									>
										<span className="rec-name">
											{item.name.split("/").pop()}
											<Chevron open={isOpen} size={11} />
										</span>
										<span className="rec-adds">{t(item.adds)}</span>
									</button>
									{shipped && !isRemoved ? (
										<button type="button" className="btn ghost rec-btn" disabled title={t("Comes with Trivium. Remove it from the extension list.")}>
											<CheckIcon size={12} /> {t("Built in")}
										</button>
									) : (
										<button
											type="button"
											className={`btn ${done ? "ghost" : ""} rec-btn`}
											disabled={done || Boolean(busy)}
											onClick={() => void (isRemoved ? restore(item.name) : run(`npm:${item.name}`, false))}
										>
											{done ? (
												<>
													<CheckIcon size={12} /> {t("Installed")}
												</>
											) : working ? (
												t(isRemoved ? "Adding…" : "Installing…")
											) : isRemoved ? (
												t("Add back")
											) : (
												t("Install")
											)}
										</button>
									)}
									{isOpen && (
										<div className="rec-details">
											<p>{t(item.why)}</p>
											{item.note && (
												<p className="rec-note">
													<InfoIcon size={12} />
													{t(item.note)}
												</p>
											)}
											<a className="rec-link mono" href={`${PACKAGE_GALLERY}/${item.name}`} target="_blank" rel="noreferrer">
												{item.name}
												<ExternalIcon size={11} />
											</a>
										</div>
									)}
								</li>
							);
						})}
					</ul>
					<p className="rec-warn">{t("Packages run code with your permissions. Review a package's source before installing it.")}</p>
				</section>
				<div className="modal-foot" style={{ justifyContent: "space-between" }}>
					<button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={() => void pickLocal()}>
						<FolderIcon size={14} /> {t("Choose a file or folder…")}
					</button>
					<button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={onClose}>
						{t("Done")}
					</button>
				</div>
			</div>
		</div>
	);
}
