import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { AppDetails, AppId, AppInfo, ExtensionInfo, ExtensionSource, ProviderInfo } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { shortPath } from "../format.ts";
import { AppIcon, BackIcon, Chevron, PlusIcon } from "../icons.tsx";
import {
	attempt,
	closeSettings,
	trivium,
	refreshModels,
	type SettingsSection,
	setState,
	updateSettings,
	useStore,
} from "../store.ts";
import { THEMES } from "../theme.ts";
import { LoginDialog } from "./LoginDialog.tsx";
import { ModelSelect } from "./ModelSelect.tsx";

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
	return (
		<button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}>
			<span />
		</button>
	);
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
	return (
		<div className="set-row">
			<div className="set-label">
				<span>{label}</span>
				{hint && <span className="hint">{hint}</span>}
			</div>
			{children}
		</div>
	);
}

/* General */

function General() {
	const settings = useStore((s) => s.settings);
	const [info, setInfo] = useState<AppInfo>();
	useEffect(() => {
		void attempt(() => trivium.appInfo()).then(setInfo);
	}, []);
	if (!settings) return null;
	const folder = (label: string, hint: string, path: string | undefined) =>
		path && (
			<Row label={label} hint={hint}>
				<span className="mono value" title={path}>
					{shortPath(path)}
				</span>
				<button type="button" className="soft-btn" onClick={() => void attempt(() => trivium.openPath(path))}>
					Open
				</button>
			</Row>
		);
	return (
		<>
			<h2 className="set-title">General</h2>
			<section className="set-section">
				<h3>Appearance</h3>
				<Row label="Text size">
					<select
						className="soft-select"
						value={settings.textSize}
						onChange={(event) => void updateSettings({ textSize: Number(event.target.value) })}
					>
						{[0.9, 1, 1.1, 1.25].map((size) => (
							<option key={size} value={size}>
								{Math.round(size * 100)}%
							</option>
						))}
					</select>
				</Row>
			</section>
			<section className="set-section">
				<h3>Folders</h3>
				{folder("Agent folder", "Logins, models and settings shared with the pi CLI", info?.agentDir)}
				{folder("Session files", "pi JSONL files, grouped by project folder", info?.sessionsDir)}
				{folder("App data", "App extensions, preferences and pending changes", info?.triviumDir)}
			</section>
			<section className="set-section">
				<h3>Sessions</h3>
				<Row label="Unload idle sessions after" hint="Unloaded sessions reload from disk when you open them">
					<select
						className="soft-select"
						value={settings.idleMinutes}
						onChange={(event) => void updateSettings({ idleMinutes: Number(event.target.value) })}
					>
						<option value={10}>10 minutes</option>
						<option value={30}>30 minutes</option>
						<option value={120}>2 hours</option>
						<option value={0}>Never</option>
					</select>
				</Row>
			</section>
			<section className="set-section">
				<h3>Notifications</h3>
				<Row label="When a run finishes while the app is in the background">
					<Switch
						on={settings.notifyDone}
						label="Notify when a run finishes"
						onChange={(on) => void updateSettings({ notifyDone: on })}
					/>
				</Row>
				<Row label="When a session is waiting for your answer">
					<Switch
						on={settings.notifyWaiting}
						label="Notify when a session is waiting"
						onChange={(on) => void updateSettings({ notifyWaiting: on })}
					/>
				</Row>
			</section>
		</>
	);
}

/* Models and logins */

function Models({ providers, reload }: { providers: ProviderInfo[]; reload: () => void }) {
	const [info, setInfo] = useState<AppInfo>();
	const [showAll, setShowAll] = useState(false);
	const login = useStore((s) => s.login);
	useEffect(() => {
		void attempt(() => trivium.appInfo()).then(setInfo);
	}, []);
	// Refresh once a login finishes, whatever the outcome.
	const loginDone = login?.events.some((event) => event.type === "done");
	useEffect(() => {
		if (loginDone) {
			reload();
			void refreshModels();
		}
	}, [loginDone, reload]);

	const startLogin = (provider: ProviderInfo, type: "api_key" | "oauth") => {
		setState({ login: { providerId: provider.id, name: provider.name, events: [] } });
		void attempt(() => trivium.login(provider.id, type));
	};
	const logout = async (provider: ProviderInfo) => {
		await attempt(() => trivium.logout(provider.id));
		reload();
		void refreshModels();
	};
	const connected = providers.filter((provider) => provider.configured);
	const others = providers.filter((provider) => !provider.configured);
	const row = (provider: ProviderInfo) => (
		<div key={provider.id} className="provider">
			<span className="tile">{provider.name.slice(0, 1).toUpperCase()}</span>
			<div className="set-label">
				<span style={{ fontWeight: 500 }}>{provider.name}</span>
				<span className="hint">
					{provider.how}
					{provider.configured && provider.models ? ` · ${provider.models} models` : ""}
				</span>
			</div>
			<span className={`status${provider.configured ? " ok" : ""}`}>
				<span className="dot" />
				{provider.configured ? "Connected" : "Not connected"}
			</span>
			{provider.logins.map((option) => (
				<button key={option.type} type="button" className="soft-btn" onClick={() => startLogin(provider, option.type)}>
					{provider.configured ? (option.type === "oauth" ? "Log in again" : "Replace key") : option.label}
				</button>
			))}
			{provider.canLogout && (
				<button type="button" className="soft-btn" onClick={() => void logout(provider)}>
					Log out
				</button>
			)}
		</div>
	);
	return (
		<>
			<div>
				<h2 className="set-title">Models and logins</h2>
				<p className="set-sub">
					Shared with the pi CLI through <span className="mono">{info ? shortPath(info.agentDir) : "~/.pi/agent"}</span>.
				</p>
			</div>
			<section className="set-section">
				<h3>Default model</h3>
				<Row label="New sessions" hint="Used when an app has no model of its own. Saved in pi's settings.">
					<ModelSelect
						value={info?.defaultModel}
						level={info?.defaultThinkingLevel}
						emptyLabel="Not set"
						onChange={async (key, level) => {
							if (!key) return;
							await attempt(() => trivium.setDefaultModel(key, level));
							setInfo(await attempt(() => trivium.appInfo()));
						}}
					/>
				</Row>
			</section>
			<section className="set-section">
				<h3>Providers</h3>
				{connected.length ? connected.map(row) : <p className="set-sub">No provider is connected yet.</p>}
				<button type="button" className="more-btn" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
					<Chevron open={showAll} />
					{showAll ? "Hide other providers" : `Show ${others.length} other providers`}
				</button>
				{showAll && others.map(row)}
			</section>
			{login && <LoginDialog />}
		</>
	);
}

/* Apps */

const SOURCE_HINT: Record<ExtensionSource, string> = {
	App: "In this app's folder",
	Added: "Added to this app",
	Global: "From ~/.pi/agent",
	Project: "From the project's .pi folder",
	Package: "From a pi package",
	"Built-in": "Built into pi",
	Dev: "Development only",
};

function ExtensionRow({ extension, order, onToggle }: { extension: ExtensionInfo; order: number; onToggle: () => void }) {
	return (
		<div className="ext">
			<span className="order mono">{extension.on ? order : "–"}</span>
			<div className="ext-body">
				<div className="ext-head">
					<span style={{ fontWeight: 500 }}>{extension.name}</span>
					<span className={`src src-${extension.source.toLowerCase().replace(/[^a-z]/g, "")}`} title={SOURCE_HINT[extension.source]}>
						{extension.source}
					</span>
					{extension.error && extension.on && <span className="ext-error-tag">Failed to load</span>}
					{!extension.on && <span className="hint">Off</span>}
				</div>
				<div className="ext-meta mono">
					<span style={{ overflowWrap: "anywhere" }}>{extension.display}</span>
					{extension.registers.map((item) => (
						<span key={item} className="reg">
							{item}
						</span>
					))}
				</div>
				{extension.error && extension.on && <div className="ext-error mono">{extension.error}</div>}
			</div>
			<Switch on={extension.on} label={`Load ${extension.name}`} onChange={onToggle} />
		</div>
	);
}

function AppPage({ app }: { app: AppId }) {
	const settings = useStore((s) => s.settings);
	const [details, setDetails] = useState<AppDetails>();
	const [touched, setTouched] = useState(false);
	const load = useCallback(() => {
		void attempt(() => trivium.appDetails(app)).then(setDetails);
	}, [app]);
	useEffect(() => {
		setDetails(undefined);
		setTouched(false);
		load();
	}, [load]);
	if (!settings) return null;
	const appSettings = settings.apps[app];
	const saveApp = async (patch: Partial<typeof appSettings>) => {
		await updateSettings({ apps: { ...settings.apps, [app]: { ...appSettings, ...patch } } });
		setTouched(true);
	};
	const toggle = async (extension: ExtensionInfo) => {
		const disabled = extension.on
			? [...appSettings.disabled, extension.path]
			: appSettings.disabled.filter((path) => path !== extension.path);
		setDetails((current) =>
			current && {
				...current,
				extensions: current.extensions.map((e) => (e.path === extension.path ? { ...e, on: !e.on } : e)),
			},
		);
		await saveApp({ disabled });
	};
	const add = async () => {
		const next = await attempt(() => trivium.addExtension(app));
		if (next) {
			setDetails(next);
			setTouched(true);
			setState({ settings: await trivium.getSettings() });
		}
	};
	const reload = async () => {
		await attempt(() => trivium.reloadApp(app));
		setTouched(false);
		load();
	};
	const theme = THEMES[app];
	const extensions = details?.extensions ?? [];
	const onCount = extensions.filter((e) => e.on).length;
	let order = 0;
	return (
		<>
			<div className="app-head">
				<span className="app-badge big">
					<AppIcon app={app} size={18} />
				</span>
				<div className="set-label" style={{ flex: "1 1 240px" }}>
					<h2 className="set-title">{theme.name}</h2>
					<span className="hint">
						<span className="mono">{details ? shortPath(details.extensionDir) : ""}</span>
						{details && ` · ${details.running ? `${details.running} running` : "nothing running"}`}
					</span>
				</div>
				<button type="button" className="soft-btn big" onClick={() => details && void attempt(() => trivium.openPath(details.extensionDir))}>
					Open folder
				</button>
			</div>

			<ol className="pills">
				<li>
					<span className="mono">1</span>pi's own extensions, then this app's folder
				</li>
				<li aria-hidden="true">→</li>
				<li>
					<span className="mono">2</span>Switch off what {theme.name} should skip
				</li>
				<li aria-hidden="true">→</li>
				<li>
					<span className="mono">3</span>Applies when a session loads
				</li>
			</ol>

			<section className="set-section">
				<div className="ext-title">
					<h3 className="big">
						Extensions <span className="hint">{details ? `${onCount} of ${extensions.length} on` : "Loading…"}</span>
					</h3>
					<button type="button" className="add-btn" onClick={() => void add()}>
						<PlusIcon size={11} width={2.8} />
						Add
					</button>
				</div>
				{details && !extensions.length && (
					<p className="set-sub">
						No extensions found. Put <span className="mono">.ts</span> files in this app's folder, or add one from
						elsewhere.
					</p>
				)}
				{extensions.map((extension) => (
					<ExtensionRow
						key={extension.path}
						extension={extension}
						order={extension.on ? ++order : 0}
						onToggle={() => void toggle(extension)}
					/>
				))}
				{details && (
					<p className="set-sub small">
						Project extensions are read from <span className="mono">{shortPath(details.projectDir)}</span>, this app's most
						recent project.
					</p>
				)}
			</section>

			<section className="set-section">
				<h3 className="big">Model for new sessions</h3>
				<Row label={`New ${theme.name} sessions`} hint="Open sessions keep the model they use">
					<ModelSelect
						value={appSettings.model}
						level={appSettings.thinkingLevel}
						emptyLabel="pi's default"
						onChange={(key, level) => void saveApp({ model: key, thinkingLevel: key ? level : undefined })}
					/>
				</Row>
			</section>

			{details && (
				<section className="facts">
					<span className="k">Tools</span>
					<span className="mono">{details.tools.join(", ")}</span>
					<span className="k">Skills</span>
					<span className="mono">{details.skills}</span>
					<span className="k">Prompts</span>
					<span className="mono">{details.prompts}</span>
				</section>
			)}

			{details?.systemPrompt && (
				<section className="set-section">
					<div className="prompt-block">
						<div className="prompt-head">Added to the system prompt</div>
						<pre>{details.systemPrompt}</pre>
					</div>
				</section>
			)}

			{touched && (
				<div className="reload-note">
					<span>
						{details?.loaded
							? `${details.loaded} loaded ${theme.name} ${details.loaded === 1 ? "session uses" : "sessions use"} the previous setup.`
							: `Changes apply the next time a ${theme.name} session loads.`}
					</span>
					{Boolean(details?.loaded) && (
						<button type="button" onClick={() => void reload()} title="Running sessions keep their setup until they finish">
							Reload idle sessions
						</button>
					)}
				</div>
			)}
		</>
	);
}

/* About */

function About() {
	const [info, setInfo] = useState<AppInfo>();
	useEffect(() => {
		void attempt(() => trivium.appInfo()).then(setInfo);
	}, []);
	return (
		<>
			<h2 className="set-title">About</h2>
			{info && (
				<section className="facts">
					<span className="k">App version</span>
					<span className="mono">{info.version}</span>
					<span className="k">pi</span>
					<span className="mono">@earendil-works/pi-coding-agent {info.piVersion}</span>
					<span className="k">Electron</span>
					<span className="mono">{info.electron}</span>
					<span className="k">Node</span>
					<span className="mono">{info.node}</span>
				</section>
			)}
		</>
	);
}

/* Page */

export function SettingsPage() {
	const section = useStore((s) => s.settingsSection);
	const app = useStore((s) => s.app);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [errors, setErrors] = useState<Partial<Record<AppId, number>>>({});
	const loadProviders = useCallback(() => {
		void attempt(() => trivium.providers()).then((list) => list && setProviders(list));
	}, []);
	useEffect(() => {
		loadProviders();
		for (const id of APP_IDS) {
			void attempt(() => trivium.appDetails(id)).then(
				(details) =>
					details && setErrors((current) => ({ ...current, [id]: details.extensions.filter((e) => e.on && e.error).length })),
			);
		}
	}, [loadProviders]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector(".scrim")) closeSettings();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const connected = providers.filter((p) => p.configured).length;
	const item = (id: SettingsSection, label: string, dot: string, meta = "") => (
		<button
			key={id}
			type="button"
			className="set-nav-item"
			aria-current={section === id ? "page" : undefined}
			onClick={() => setState({ settingsSection: id })}
		>
			<span className="swatch" style={{ background: dot }} />
			{label}
			<span className="meta">{meta}</span>
		</button>
	);
	return (
		<>
			<nav className="set-nav" aria-label="Settings sections">
				<button type="button" className="back" onClick={closeSettings}>
					<BackIcon />
					Back to {THEMES[app].name}
					<span className="kbd">esc</span>
				</button>
				<h1>Settings</h1>
				<div className="set-nav-head">App</div>
				{item("general", "General", "#8B8D97")}
				{item("models", "Models and logins", "#8B8D97", connected ? `${connected} connected` : "")}
				<div className="set-nav-head">Apps</div>
				{APP_IDS.map((id) =>
					item(id, THEMES[id].name, THEMES[id].accent, errors[id] ? `${errors[id]} ${errors[id] === 1 ? "error" : "errors"}` : ""),
				)}
				<div className="set-nav-head" />
				{item("about", "About", "#8B8D97")}
			</nav>
			<div className="workspace">
				<main className="card set-card">
					<div className="set-content">
						{section === "general" && <General />}
						{section === "models" && <Models providers={providers} reload={loadProviders} />}
						{(section === "code" || section === "research" || section === "write") && <AppPage app={section} />}
						{section === "about" && <About />}
					</div>
				</main>
			</div>
		</>
	);
}
