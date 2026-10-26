import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { AppDetails, AppId, AppInfo, ExtensionInfo, ExtensionSource, ProviderInfo } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { shortPath } from "../format.ts";
import { AppIcon, BackIcon, FolderIcon, InfoIcon, KeyboardIcon, KeyIcon, PlusIcon, SearchIcon, SlidersIcon } from "../icons.tsx";
import {
	attempt,
	closeSettings,
	refreshModels,
	type SettingsSection,
	setState,
	trivium,
	updateSettings,
	useStore,
} from "../store.ts";
import { THEMES } from "../theme.ts";
import { AddExtensionDialog } from "./AddExtensionDialog.tsx";
import { Dropdown } from "./Dropdown.tsx";
import { LoginDialog } from "./LoginDialog.tsx";
import { ModelSelect } from "./ModelSelect.tsx";

/* Building blocks */

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
	return (
		<button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={() => onChange(!on)}>
			<span />
		</button>
	);
}

function PageHeader({
	icon,
	tone = "neutral",
	title,
	subtitle,
	actions,
}: {
	icon: ReactNode;
	tone?: "neutral" | "accent";
	title: string;
	subtitle: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="s-head">
			<span className={`s-head-icon ${tone}`}>{icon}</span>
			<div className="s-head-text">
				<h2>{title}</h2>
				<p>{subtitle}</p>
			</div>
			{actions && <div className="s-head-actions">{actions}</div>}
		</header>
	);
}

/** A titled card of rows. */
function Group({
	title,
	description,
	aside,
	footer,
	children,
}: {
	title: string;
	description?: ReactNode;
	aside?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="s-group">
			<div className="s-group-head">
				<div>
					<h3>{title}</h3>
					{description && <p>{description}</p>}
				</div>
				{aside}
			</div>
			<div className="s-card">{children}</div>
			{footer && <p className="s-foot">{footer}</p>}
		</section>
	);
}

/** One row in a card: a label with an optional hint on the left, a control on the right. */
function Item({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
	return (
		<div className="s-row">
			<div className="s-row-text">
				<span className="s-label">{label}</span>
				{hint && <span className="s-hint">{hint}</span>}
			</div>
			{children && <div className="s-row-control">{children}</div>}
		</div>
	);
}

const openFolder = (path: string) => void attempt(() => trivium.openPath(path));

/* General */

function General() {
	const settings = useStore((s) => s.settings);
	const [info, setInfo] = useState<AppInfo>();
	useEffect(() => {
		void attempt(() => trivium.appInfo()).then(setInfo);
	}, []);
	if (!settings) return null;
	const folder = (label: string, path: string | undefined) =>
		path && (
			<Item
				label={label}
				hint={
					<span className="mono s-path" title={path}>
						{shortPath(path)}
					</span>
				}
			>
				<button type="button" className="s-icon-btn" aria-label={`Open ${label} in Finder`} title="Open in Finder" onClick={() => openFolder(path)}>
					<FolderIcon size={15} />
				</button>
			</Item>
		);
	return (
		<>
			<PageHeader icon={<SlidersIcon size={18} />} title="General" subtitle="How Trivium looks, keeps sessions and gets your attention." />
			<Group title="Appearance">
				<Item label="Text size" hint="Scales the whole window">
					<Dropdown
						label="Text size"
						value={String(settings.textSize)}
						options={[0.9, 1, 1.1, 1.25].map((size) => ({ value: String(size), label: `${Math.round(size * 100)}%` }))}
						align="right"
						onChange={(value) => void updateSettings({ textSize: Number(value) })}
					/>
				</Item>
			</Group>
			<Group title="Sessions">
				<Item label="Unload idle sessions" hint="Frees memory. An unloaded session reloads from disk when you open it.">
					<Dropdown
						label="Unload idle sessions after"
						value={String(settings.idleMinutes)}
						options={[
							{ value: "10", label: "After 10 minutes" },
							{ value: "30", label: "After 30 minutes" },
							{ value: "120", label: "After 2 hours" },
							{ value: "0", label: "Never" },
						]}
						align="right"
						onChange={(value) => void updateSettings({ idleMinutes: Number(value) })}
					/>
				</Item>
			</Group>
			<Group title="Notifications" description="Only while Trivium is in the background.">
				<Item label="A run finishes">
					<Switch on={settings.notifyDone} label="Notify when a run finishes" onChange={(on) => void updateSettings({ notifyDone: on })} />
				</Item>
				<Item label="A session needs your answer" hint="A question or an approval from an extension">
					<Switch
						on={settings.notifyWaiting}
						label="Notify when a session is waiting"
						onChange={(on) => void updateSettings({ notifyWaiting: on })}
					/>
				</Item>
			</Group>
			<Group title="Storage" description="Sessions, logins and settings are pi's own, shared with the pi CLI.">
				{folder("Agent folder", info?.agentDir)}
				{folder("Session files", info?.sessionsDir)}
				{folder("Trivium data", info?.triviumDir)}
			</Group>
		</>
	);
}

/* Models and logins */

const loginLabel = (type: "api_key" | "oauth", configured: boolean) =>
	type === "oauth" ? (configured ? "Log in again" : "Log in") : configured ? "Replace key" : "Add API key";

function ProviderRow({
	provider,
	onLogin,
	onLogout,
}: {
	provider: ProviderInfo;
	onLogin: (type: "api_key" | "oauth") => void;
	onLogout: () => void;
}) {
	return (
		<div className="s-row s-provider">
			<span className={`s-tile${provider.configured ? " on" : ""}`}>{provider.name.slice(0, 1).toUpperCase()}</span>
			<div className="s-row-text">
				<span className="s-label">{provider.name}</span>
				{provider.configured && (
					<span className="s-hint">
						<span className="s-ok-dot" />
						{provider.how}
						{provider.models ? ` · ${provider.models} models` : ""}
					</span>
				)}
			</div>
			<div className="s-row-control">
				{provider.logins.map((option) => (
					<button
						key={option.type}
						type="button"
						className={`s-btn${provider.configured ? "" : " soft"}`}
						title={option.label}
						onClick={() => onLogin(option.type)}
					>
						{loginLabel(option.type, provider.configured)}
					</button>
				))}
				{provider.canLogout && (
					<button type="button" className="s-btn" onClick={onLogout}>
						Log out
					</button>
				)}
			</div>
		</div>
	);
}

const PROVIDERS_SHOWN = 8;

function Models({ providers, reload }: { providers: ProviderInfo[]; reload: () => void }) {
	const [info, setInfo] = useState<AppInfo>();
	const [query, setQuery] = useState("");
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
	const others = useMemo(() => {
		const q = query.trim().toLowerCase();
		const rest = providers.filter((provider) => !provider.configured);
		return q ? rest.filter((provider) => provider.name.toLowerCase().includes(q) || provider.id.includes(q)) : rest;
	}, [providers, query]);
	const visible = query || showAll ? others : others.slice(0, PROVIDERS_SHOWN);
	const row = (provider: ProviderInfo) => (
		<ProviderRow
			key={provider.id}
			provider={provider}
			onLogin={(type) => startLogin(provider, type)}
			onLogout={() => void logout(provider)}
		/>
	);
	return (
		<>
			<PageHeader
				icon={<KeyIcon size={18} />}
				title="Models and logins"
				subtitle={
					<>
						Shared with the pi CLI through <span className="mono">{info ? shortPath(info.agentDir) : "~/.pi/agent"}</span>
					</>
				}
			/>
			<Group title="Default model">
				<Item label="New sessions" hint="Used when an app has no model of its own">
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
				</Item>
			</Group>
			<Group title={`Connected${connected.length ? ` · ${connected.length}` : ""}`}>
				{connected.length ? (
					connected.map(row)
				) : (
					<div className="s-empty">No provider is connected yet. Add one below to start a session.</div>
				)}
			</Group>
			<Group
				title="Add a provider"
				aside={
					<label className="s-search">
						<SearchIcon size={13} />
						<span className="sr-only">Search providers</span>
						<input value={query} placeholder="Search providers" onChange={(event) => setQuery(event.target.value)} />
					</label>
				}
				footer={
					!query && others.length > PROVIDERS_SHOWN ? (
						<button type="button" className="s-link" onClick={() => setShowAll(!showAll)}>
							{showAll ? "Show fewer" : `Show all ${others.length} providers`}
						</button>
					) : undefined
				}
			>
				{visible.length ? visible.map(row) : <div className="s-empty">No provider matches “{query}”.</div>}
			</Group>
			{login && <LoginDialog />}
		</>
	);
}

/* Apps */

const APP_SUMMARY: Record<AppId, string> = {
	code: "Builds and fixes software, with a shell and a Changes panel to review every edit.",
	research: "Reads sources and writes notes without a shell, citing where each claim came from.",
	write: "Edits documents in your project in small, reviewable steps, keeping your voice.",
};

const SOURCE_HINT: Record<ExtensionSource, string> = {
	App: "In this app's folder",
	Added: "Added to this app from elsewhere",
	Global: "From ~/.pi/agent, loaded by pi everywhere",
	Project: "From the project's .pi folder",
	Package: "From a pi package",
	"Built-in": "Built into pi",
	Dev: "Development only",
};

function ExtensionRow({ extension, onToggle }: { extension: ExtensionInfo; onToggle: () => void }) {
	const failed = Boolean(extension.error && extension.on);
	return (
		<div className={`s-row s-ext${extension.on ? "" : " off"}`}>
			<div className="s-row-text">
				<div className="s-ext-title">
					<span className="s-label">{extension.name}</span>
					<span className={`s-tag src-${extension.source.toLowerCase().replace(/[^a-z]/g, "")}`} title={SOURCE_HINT[extension.source]}>
						{extension.source}
					</span>
					{failed && <span className="s-tag error">Failed to load</span>}
				</div>
				{extension.registers.length > 0 && (
					<div className="s-chips">
						{extension.registers.map((item) => (
							<span key={item} className="s-chip mono">
								{item}
							</span>
						))}
					</div>
				)}
				<span className="mono s-path" title={extension.path}>
					{extension.display}
				</span>
				{failed && (
					<pre className="s-error mono" title={extension.error}>
						{/* pi appends the require stack; the first line says what went wrong. */}
						{extension.error?.split("\n")[0]}
					</pre>
				)}
			</div>
			<div className="s-row-control">
				<Switch on={extension.on} label={`Load ${extension.name}`} onChange={onToggle} />
			</div>
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
	const [adding, setAdding] = useState(false);
	const added = async (next: AppDetails) => {
		setDetails(next);
		setTouched(true);
		setState({ settings: await trivium.getSettings() });
	};
	const reload = async () => {
		await attempt(() => trivium.reloadApp(app));
		setTouched(false);
		load();
	};
	const theme = THEMES[app];
	const extensions = details?.extensions ?? [];
	const onCount = extensions.filter((e) => e.on).length;
	return (
		<>
			<PageHeader
				icon={<AppIcon app={app} size={18} />}
				tone="accent"
				title={theme.name}
				subtitle={APP_SUMMARY[app]}
				actions={
					details && (
						<button type="button" className="s-btn soft" onClick={() => openFolder(details.extensionDir)}>
							<FolderIcon size={14} />
							Open folder
						</button>
					)
				}
			/>

			{details && (
				<div className="s-stats">
					<span>
						<strong>{onCount}</strong> of {extensions.length} extensions on
					</span>
					<span>
						<strong>{details.tools.length}</strong> tools
					</span>
					<span>
						<strong>{details.skills}</strong> skills
					</span>
					<span>
						<strong>{details.prompts}</strong> prompts
					</span>
					<span>{details.running ? <><strong>{details.running}</strong> running</> : "Nothing running"}</span>
				</div>
			)}

			{touched && (
				<div className="s-notice">
					<span>
						{details?.loaded
							? `${details.loaded} open ${theme.name} ${details.loaded === 1 ? "session still uses" : "sessions still use"} the previous setup.`
							: `Changes apply the next time a ${theme.name} session loads.`}
					</span>
					{Boolean(details?.loaded) && (
						<button type="button" className="s-btn" onClick={() => void reload()} title="Running sessions keep their setup until they finish">
							Reload idle sessions
						</button>
					)}
				</div>
			)}

			<Group
				title="Extensions"
				description="pi's own extensions load first, then this app's folder. Turn off anything this app should skip."
				aside={
					<button type="button" className="s-btn accent" onClick={() => setAdding(true)}>
						<PlusIcon size={12} width={2.6} />
						Add
					</button>
				}
				footer={
					details && (
						<>
							Project extensions come from <span className="mono">{shortPath(details.projectDir)}</span>, this app's most
							recent project. Changes apply when a session loads.
						</>
					)
				}
			>
				{!details && <div className="s-empty">Loading…</div>}
				{details && !extensions.length && (
					<div className="s-empty">
						No extensions yet. Install a pi package, or put <span className="mono">.ts</span> files in this app's folder.
					</div>
				)}
				{extensions.map((extension) => (
					<ExtensionRow key={extension.path} extension={extension} onToggle={() => void toggle(extension)} />
				))}
			</Group>
			{adding && (
				<AddExtensionDialog
					app={app}
					packages={details?.packages ?? []}
					onClose={() => setAdding(false)}
					onAdded={(next) => void added(next)}
				/>
			)}

			<Group title="Model">
				<Item label={`New ${theme.name} sessions`} hint="Open sessions keep the model they use">
					<ModelSelect
						value={appSettings.model}
						level={appSettings.thinkingLevel}
						emptyLabel="pi's default"
						onChange={(key, level) => void saveApp({ model: key, thinkingLevel: key ? level : undefined })}
					/>
				</Item>
			</Group>

			{details && (
				<Group title="Tools" description="What the agent can call in this app. Extensions can add more.">
					<div className="s-row">
						<div className="s-chips big">
							{details.tools.map((tool) => (
								<span key={tool} className="s-chip mono">
									{tool}
								</span>
							))}
						</div>
					</div>
				</Group>
			)}

			{details?.systemPrompt && (
				<Group title="Instructions" description="Added to pi's system prompt for every session in this app.">
					<pre className="s-prompt">{details.systemPrompt}</pre>
				</Group>
			)}
		</>
	);
}

/* Shortcuts */

/** Each entry is a list of alternatives; each alternative is the keys pressed together. */
type Shortcut = [label: string, keys: string[][], hint?: string];

const SHORTCUTS: [title: string, description: string | undefined, rows: Shortcut[]][] = [
	[
		"Anywhere",
		undefined,
		[
			["Switch to Code, Research or Write", [["⌘", "1"], ["–"], ["⌘", "3"]]],
			["New session", [["⌘", "N"]]],
			["Search sessions in every app", [["⌘", "K"]]],
			["Fold or unfold the sidebar", [["⌘", "\\"]]],
			["Open or close Settings", [["⌘", ","]]],
		],
	],
	[
		"Message box",
		undefined,
		[
			["Send", [["↵"]], "While a run is going, this steers it"],
			["New line", [["⇧", "↵"]]],
			["Queue a follow-up for after the run", [["⌥", "↵"]]],
			["Stop the run", [["esc"]]],
			["Commands", [["/"]], "Prompt templates, skills and extension commands"],
		],
	],
	[
		"Command menu",
		undefined,
		[
			["Move through the list", [["↑"], ["↓"]]],
			["Complete the command or suggestion", [["tab"]]],
			["Complete, or send a command typed in full", [["↵"]]],
			["Close the menu", [["esc"]]],
		],
	],
	[
		"Questions from the agent",
		"Shown in the conversation when an extension asks something.",
		[
			["Pick an option", [["1"], ["–"], ["9"]]],
			["Move between options", [["↑"], ["↓"]]],
			["Pick the highlighted option or send an answer", [["↵"]]],
			["Allow, or send a long answer", [["⌘", "↵"]]],
			["Dismiss or decline", [["esc"]]],
		],
	],
	[
		"Dialogs and lists",
		undefined,
		[
			["Start the new session", [["⌘", "↵"]]],
			["Pick a project in New session", [["⌘", "1"], ["–"], ["⌘", "6"]]],
			["Move through search results and dropdowns", [["↑"], ["↓"]]],
			["Jump to the first or last dropdown option", [["home"], ["end"]]],
			["Close", [["esc"]]],
		],
	],
];

function Keys({ keys }: { keys: string[][] }) {
	return (
		<span className="s-keys">
			{keys.map((combo, index) =>
				combo.length === 1 && combo[0] === "–" ? (
					<span key={index} className="s-keys-sep">
						to
					</span>
				) : (
					<span key={index} className="s-combo">
						{combo.map((key) => (
							<kbd key={key}>{key}</kbd>
						))}
					</span>
				),
			)}
		</span>
	);
}

function Shortcuts() {
	return (
		<>
			<PageHeader icon={<KeyboardIcon size={18} />} title="Keyboard shortcuts" subtitle="Everything Trivium does from the keyboard." />
			{SHORTCUTS.map(([title, description, rows]) => (
				<Group key={title} title={title} description={description}>
					{rows.map(([label, keys, hint]) => (
						<Item key={label} label={label} hint={hint}>
							<Keys keys={keys} />
						</Item>
					))}
				</Group>
			))}
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
			<PageHeader
				icon={<span className="s-logo">π</span>}
				title="Trivium"
				subtitle="A desktop workspace for coding, research and writing, built on pi."
			/>
			{info && (
				<Group title="Versions">
					<Item label="Trivium">
						<span className="mono s-value">{info.version}</span>
					</Item>
					<Item label="pi" hint="@earendil-works/pi-coding-agent">
						<span className="mono s-value">{info.piVersion}</span>
					</Item>
					<Item label="Electron">
						<span className="mono s-value">{info.electron}</span>
					</Item>
					<Item label="Node">
						<span className="mono s-value">{info.node}</span>
					</Item>
				</Group>
			)}
			<Group title="Project">
				<Item label="Source code" hint="Issues and pull requests are welcome">
					<a className="s-btn soft" href="https://github.com/SkarnerV/Trivium" target="_blank" rel="noreferrer">
						GitHub
					</a>
				</Item>
				<Item label="License" hint="Plugins you write are yours to license">
					<span className="s-value">MIT</span>
				</Item>
			</Group>
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
			if (event.key === "Escape" && !document.querySelector(".scrim, .dd.open")) closeSettings();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const connected = providers.filter((p) => p.configured).length;
	const item = (id: SettingsSection, label: string, icon: ReactNode, color?: string, meta?: ReactNode) => (
		<button
			key={id}
			type="button"
			className="set-nav-item"
			aria-current={section === id ? "page" : undefined}
			onClick={() => setState({ settingsSection: id })}
		>
			<span className="s-nav-icon" style={color ? { color, background: `color-mix(in srgb, ${color} 14%, #fff)` } : undefined}>
				{icon}
			</span>
			<span className="s-nav-label">{label}</span>
			{meta}
		</button>
	);
	return (
		<>
			<nav className="set-nav drag" aria-label="Settings sections">
				<button type="button" className="back" onClick={closeSettings}>
					<BackIcon />
					Back to {THEMES[app].name}
				</button>
				<h1>Settings</h1>
				{item("general", "General", <SlidersIcon />)}
				{item(
					"models",
					"Models and logins",
					<KeyIcon />,
					undefined,
					connected ? <span className="s-nav-meta">{connected}</span> : <span className="s-nav-meta warn">Set up</span>,
				)}
				{item("shortcuts", "Keyboard shortcuts", <KeyboardIcon />)}
				<div className="set-nav-head">Apps</div>
				{APP_IDS.map((id) =>
					item(
						id,
						THEMES[id].name,
						<AppIcon app={id} size={13} />,
						THEMES[id].accent,
						errors[id] ? (
							<span className="s-nav-meta error" title={`${errors[id]} extension failed to load`}>
								{errors[id]} {errors[id] === 1 ? "error" : "errors"}
							</span>
						) : undefined,
					),
				)}
				<span style={{ flex: 1 }} />
				{item("about", "About", <InfoIcon />)}
			</nav>
			<div className="workspace">
				<main className="card set-card">
					<div className="set-content">
						{section === "general" && <General />}
						{section === "models" && <Models providers={providers} reload={loadProviders} />}
						{section === "shortcuts" && <Shortcuts />}
						{(section === "code" || section === "research" || section === "write") && <AppPage app={section} />}
						{section === "about" && <About />}
					</div>
				</main>
			</div>
		</>
	);
}
