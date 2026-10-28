import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { PERMISSION_LEVELS } from "../../shared/permissions.ts";
import type {
	AppDetails,
	AppId,
	AppInfo,
	ConnectorInfo,
	ConnectorsView,
	CustomProvider,
	ExtensionInfo,
	ExtensionSource,
	McpExposure,
	PermissionSettings,
	ProviderInfo,
	SessionUsage,
	UsageReport,
} from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { EXPOSURES, joinCommand } from "../../shared/connectors.ts";
import {
	type CalendarDay,
	cacheShare,
	calendar,
	firstTokenOf,
	speedOf,
	summarize,
	type Tally,
	tokensOf,
	type UsageBar,
	type UsageRange,
} from "../../shared/usage.ts";
import { duration, relativeTime, shortPath, tokens } from "../format.ts";
import { useNow } from "../hooks.ts";
import { keyName } from "../platform.ts";
import { packageName } from "../../shared/packages.ts";
import { RECOMMENDED } from "../../shared/recommended.ts";
import { providerLogo } from "../provider-logos.ts";
import { AppIcon, BackIcon, ChartIcon, Chevron, FolderIcon, InfoIcon, KeyboardIcon, KeyIcon, PlugIcon, PlusIcon, SearchIcon, SlidersIcon, TriviumIcon } from "../icons.tsx";
import {
	attempt,
	closeSettings,
	installUpdate,
	notify,
	openSession,
	openSettings,
	refreshModels,
	type SettingsSection,
	setState,
	showSettings,
	trivium,
	updateSettings,
	useStore,
} from "../store.ts";
import { SECTION_COLORS, THEMES } from "../theme.ts";
import { t, tx } from "../i18n.tsx";
import { getLocale, type Language, LOCALE_NAMES, LOCALES } from "../../shared/i18n.ts";
import { AddExtensionDialog } from "./AddExtensionDialog.tsx";
import { ConnectorDialog } from "./ConnectorDialog.tsx";
import { CustomProviderDialog } from "./CustomProviderDialog.tsx";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { LoginDialog } from "./LoginDialog.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { PresetModelsDialog } from "./PresetModelsDialog.tsx";

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
	tone?: "neutral" | "accent" | "logo";
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
				<button type="button" className="s-icon-btn" aria-label={t("Open {name} in Finder", { name: label })} title={t("Open in Finder")} onClick={() => openFolder(path)}>
					<FolderIcon size={15} />
				</button>
			</Item>
		);
	return (
		<>
			<PageHeader icon={<SlidersIcon size={18} />} tone="accent" title={t("General")} subtitle={t("How Trivium looks, keeps sessions and gets your attention.")} />
			<Group title={t("Appearance")}>
				<Item label={t("Language")} hint={t("System follows your computer's language")}>
					<Dropdown
						label={t("Language")}
						value={settings.language ?? "system"}
						options={[
							{ value: "system", label: t("System") },
							...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
						]}
						align="right"
						onChange={(value) => void updateSettings({ language: value as Language })}
					/>
				</Item>
				<Item label={t("Text size")} hint={t("Scales the whole window")}>
					<Dropdown
						label={t("Text size")}
						value={String(settings.textSize)}
						options={[0.9, 1, 1.1, 1.25].map((size) => ({ value: String(size), label: `${Math.round(size * 100)}%` }))}
						align="right"
						onChange={(value) => void updateSettings({ textSize: Number(value) })}
					/>
				</Item>
			</Group>
			<Group title={t("Sessions")}>
				<Item label={t("Unload idle sessions")} hint={t("Frees memory. An unloaded session reloads from disk when you open it.")}>
					<Dropdown
						label={t("Unload idle sessions after")}
						value={String(settings.idleMinutes)}
						options={[
							{ value: "10", label: t("After 10 minutes") },
							{ value: "30", label: t("After 30 minutes") },
							{ value: "120", label: t("After 2 hours") },
							{ value: "0", label: t("Never") },
						]}
						align="right"
						onChange={(value) => void updateSettings({ idleMinutes: Number(value) })}
					/>
				</Item>
			</Group>
			<Group title={t("Notifications")} description={t("Only while Trivium is in the background.")}>
				<Item label={t("A run finishes")}>
					<Switch on={settings.notifyDone} label={t("Notify when a run finishes")} onChange={(on) => void updateSettings({ notifyDone: on })} />
				</Item>
				<Item label={t("A session needs your answer")} hint={t("A question or an approval from an extension")}>
					<Switch
						on={settings.notifyWaiting}
						label={t("Notify when a session is waiting")}
						onChange={(on) => void updateSettings({ notifyWaiting: on })}
					/>
				</Item>
			</Group>
			<Group title={t("Storage")} description={t("Sessions, logins and settings are pi's own, shared with the pi CLI.")}>
				{folder(t("Agent folder"), info?.agentDir)}
				{folder(t("Session files"), info?.sessionsDir)}
				{folder(t("Trivium data"), info?.triviumDir)}
			</Group>
		</>
	);
}

/* Models and logins */

/** The provider's logo, or its initial when Trivium has no logo for it. */
function ProviderTile({ id, name, on }: { id: string; name: string; on: boolean }) {
	const logo = providerLogo(id, name);
	return logo ? (
		<span className="s-tile logo">
			<img src={logo} alt="" draggable={false} />
		</span>
	) : (
		<span className={`s-tile${on ? " on" : ""}`}>{name.slice(0, 1).toUpperCase()}</span>
	);
}

const loginLabel = (type: "api_key" | "oauth", configured: boolean) =>
	t(type === "oauth" ? (configured ? "Log in again" : "Log in") : configured ? "Replace key" : "Add API key");

function ProviderRow({
	provider,
	onLogin,
	onLogout,
	onModels,
}: {
	provider: ProviderInfo;
	onLogin: (type: "api_key" | "oauth") => void;
	onLogout: () => void;
	/** Opens its models, offered once it is connected. */
	onModels: () => void;
}) {
	return (
		<div className="s-row s-provider">
			<ProviderTile id={provider.id} name={provider.name} on={provider.configured} />
			<div className="s-row-text">
				<span className="s-label">{provider.name}</span>
				{provider.configured && (
					<span className="s-hint">
						<span className="s-ok-dot" />
						{provider.how}
						{provider.models ? ` · ${t("{n} models", { n: provider.models })}` : ""}
					</span>
				)}
			</div>
			<div className="s-row-control">
				{provider.configured && provider.preset && (
					<button type="button" className="s-btn" onClick={onModels}>
						{t("Models")}
					</button>
				)}
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
						{t("Log out")}
					</button>
				)}
			</div>
		</div>
	);
}

const PROVIDERS_SHOWN = 8;

const API_NAMES: Record<CustomProvider["api"], string> = {
	"openai-completions": "OpenAI-compatible",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic",
	"google-generative-ai": "Gemini",
};

function CustomProviderRow({ provider, onEdit }: { provider: CustomProvider; onEdit: () => void }) {
	let host = provider.baseUrl;
	try {
		host = new URL(provider.baseUrl).host;
	} catch {
		// Shown as written.
	}
	return (
		<div className="s-row s-provider">
			<ProviderTile id={provider.id} name={provider.name} on />
			<div className="s-row-text">
				<span className="s-label">{provider.name}</span>
				<span className="s-hint">
					<span className="mono s-path" title={provider.baseUrl}>
						{host}
					</span>
					· {t(API_NAMES[provider.api])} · {t(provider.models.length === 1 ? "{n} model" : "{n} models", { n: provider.models.length })}
				</span>
			</div>
			<div className="s-row-control">
				<button type="button" className="s-btn" onClick={onEdit}>
					{t("Edit")}
				</button>
			</div>
		</div>
	);
}

function Models({ providers, reload }: { providers: ProviderInfo[]; reload: () => void }) {
	const [info, setInfo] = useState<AppInfo>();
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);
	const login = useStore((s) => s.login);
	const [custom, setCustom] = useState<CustomProvider[]>([]);
	/** The endpoint being edited: a provider, or null for a new one. */
	const [editing, setEditing] = useState<CustomProvider | null>();
	/** The built-in provider whose models are open. */
	const [presetId, setPresetId] = useState<string>();
	const loadCustom = useCallback(() => {
		void attempt(() => trivium.customProviders()).then((list) => list && setCustom(list));
	}, []);
	useEffect(() => {
		void attempt(() => trivium.appInfo()).then(setInfo);
		loadCustom();
	}, [loadCustom]);
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
	// Custom endpoints have a group of their own, edited instead of logged in to.
	const connected = providers.filter((provider) => provider.configured && !provider.custom);
	const others = useMemo(() => {
		const q = query.trim().toLowerCase();
		const rest = providers.filter((provider) => !provider.configured && !provider.custom);
		return q ? rest.filter((provider) => provider.name.toLowerCase().includes(q) || provider.id.includes(q)) : rest;
	}, [providers, query]);
	const visible = query || showAll ? others : others.slice(0, PROVIDERS_SHOWN);
	const row = (provider: ProviderInfo) => (
		<ProviderRow
			key={provider.id}
			provider={provider}
			onLogin={(type) => startLogin(provider, type)}
			onLogout={() => void logout(provider)}
			onModels={() => setPresetId(provider.id)}
		/>
	);
	return (
		<>
			<PageHeader
				icon={<KeyIcon size={18} />}
				tone="accent"
				title={t("Models and logins")}
				subtitle={tx("Shared with the pi CLI through {path}", {
					path: <span className="mono">{info ? shortPath(info.agentDir) : "~/.pi/agent"}</span>,
				})}
			/>
			<Group title={t("Default model")}>
				<Item label={t("New sessions")} hint={t("Used when a mode has no model of its own")}>
					<ModelSelect
						value={info?.defaultModel}
						level={info?.defaultThinkingLevel}
						emptyLabel={t("Not set")}
						onChange={async (key, level) => {
							if (!key) return;
							await attempt(() => trivium.setDefaultModel(key, level));
							setInfo(await attempt(() => trivium.appInfo()));
						}}
					/>
				</Item>
			</Group>
			<Group title={`${t("Connected")}${connected.length ? ` · ${connected.length}` : ""}`}>
				{connected.length ? (
					connected.map(row)
				) : (
					<div className="s-empty">{t("No provider is connected yet. Add one below to start a session.")}</div>
				)}
			</Group>
			<Group
				title={t("Custom endpoints")}
				description={t("Local servers, proxies and anything else that speaks an API pi knows.")}
				aside={
					<button type="button" className="s-btn accent" onClick={() => setEditing(null)}>
						<PlusIcon size={12} width={2.6} />
						{t("Add")}
					</button>
				}
			>
				{custom.length ? (
					custom.map((provider) => <CustomProviderRow key={provider.id} provider={provider} onEdit={() => setEditing(provider)} />)
				) : (
					<div className="s-empty">{t("None yet. Add Ollama, LM Studio, vLLM or a proxy, and Trivium can fetch its models.")}</div>
				)}
			</Group>
			<Group
				title={t("Add a provider")}
				aside={
					<label className="s-search">
						<SearchIcon size={13} />
						<span className="sr-only">{t("Search providers")}</span>
						<input value={query} placeholder={t("Search providers")} onChange={(event) => setQuery(event.target.value)} />
					</label>
				}
				footer={
					!query && others.length > PROVIDERS_SHOWN ? (
						<button type="button" className="s-link" onClick={() => setShowAll(!showAll)}>
							{showAll ? t("Show fewer") : t("Show all {n} providers", { n: others.length })}
						</button>
					) : undefined
				}
			>
				{visible.length ? visible.map(row) : <div className="s-empty">{t("No provider matches “{query}”.", { query })}</div>}
			</Group>
			{login && <LoginDialog />}
			{presetId && (
				<PresetModelsDialog
					providerId={presetId}
					onClose={() => setPresetId(undefined)}
					onSaved={() => {
						reload();
						void refreshModels();
					}}
				/>
			)}
			{editing !== undefined && (
				<CustomProviderDialog
					provider={editing ?? undefined}
					takenIds={providers.map((provider) => provider.id)}
					onClose={() => setEditing(undefined)}
					onSaved={() => {
						loadCustom();
						reload();
						void refreshModels();
					}}
				/>
			)}
		</>
	);
}

/* Connectors */

const CONNECTOR_STATES: Record<NonNullable<ConnectorInfo["state"]>, { label: string; tone: string }> = {
	connected: { label: "Connected", tone: "ok" },
	"needs-auth": { label: "Needs sign-in", tone: "warn" },
	failed: { label: "Can't connect", tone: "error" },
	disabled: { label: "Off", tone: "" },
};

const exposureOptions = (): DropdownOption[] => EXPOSURES.map(({ value, label }) => ({ value, label: t(label) }));

/** The command a local server runs, or the address of a remote one. */
function serverAddress(server: ConnectorInfo): string {
	if (server.transport === "stdio") return joinCommand([server.command, ...server.args]);
	try {
		const url = new URL(server.url);
		return `${url.host}${url.pathname.replace(/\/$/, "")}`;
	} catch {
		return server.url;
	}
}

function ConnectorRow({
	server,
	checking,
	signingIn,
	onToggle,
	onExposure,
	onToolExposure,
	onEdit,
	onSignIn,
	onSignOut,
}: {
	server: ConnectorInfo;
	checking: boolean;
	signingIn: boolean;
	onToggle: () => void;
	onExposure: (exposure: McpExposure) => void;
	onToolExposure: (tool: string, exposure: McpExposure) => void;
	onEdit: () => void;
	onSignIn: () => void;
	onSignOut: () => void;
}) {
	const [open, setOpen] = useState(false);
	const state = server.state && CONNECTOR_STATES[server.state];
	const off = server.tools.filter((tool) => tool.exposure === "hidden").length;
	const counts = server.tools.length
		? `${t(server.tools.length === 1 ? "{n} tool" : "{n} tools", { n: server.tools.length })}${off ? ` · ${t("{n} off", { n: off })}` : ""}`
		: t("Details");
	const address = serverAddress(server);
	return (
		<div className={`s-row s-ext${server.enabled ? "" : " off"}`}>
			<div className="s-row-text">
				<div className="s-ext-title">
					<span className="s-label">{server.name}</span>
					<span className="s-tag" title={t(server.transport === "stdio" ? "Runs on this computer" : "Reached over HTTP")}>
						{t(server.transport === "stdio" ? "Local" : "Remote")}
					</span>
					{server.enabled && checking && !state ? (
						<span className="s-tag">{t("Checking…")}</span>
					) : (
						state && server.enabled && <span className={`s-tag ${state.tone}`}>{t(state.label)}</span>
					)}
				</div>
				<span className="s-ext-desc">
					{server.description || (
						<span className="mono" title={address}>
							{address}
						</span>
					)}
				</span>
				<button type="button" className="s-ext-more" aria-expanded={open} onClick={() => setOpen(!open)}>
					{counts}
					<Chevron open={open} size={10} />
				</button>
				{open && (
					<div className="cn-details">
						<div className="cn-reach">
							<div className="cn-reach-text">
								<span className="cn-head">{t("Tools reach the agent")}</span>
								<span>{t(EXPOSURES.find((entry) => entry.value === server.exposure)?.hint ?? "")}</span>
							</div>
							<Dropdown
								label={t("How {name}'s tools reach the agent", { name: server.name })}
								value={server.exposure}
								options={exposureOptions()}
								align="right"
								onChange={(value) => onExposure(value as McpExposure)}
							/>
						</div>
						{server.tools.length > 0 ? (
							<div className="cn-tools">
								{server.tools.map((tool) => (
									<div key={tool.name} className={`cn-tool${tool.exposure === "hidden" ? " off" : ""}`}>
										<span className="mono">{tool.name}</span>
										<Dropdown
											label={t("How {name} reaches the agent", { name: tool.name })}
											value={tool.exposure}
											options={exposureOptions()}
											align="right"
											variant="ghost"
											onChange={(value) => onToolExposure(tool.name, value as McpExposure)}
										/>
									</div>
								))}
							</div>
						) : (
							<p className="cn-none">
								{t(
									!server.enabled
										? "Turn it on to see its tools."
										: server.state === "connected"
											? "This server offers no tools."
											: server.state
												? "Its tools show once it connects."
												: "Check connections to see its tools.",
								)}
							</p>
						)}
						<dl className="s-ext-details cn-facts">
							<div>
								<dt>{t(server.transport === "stdio" ? "Runs" : "URL")}</dt>
								<dd className="mono s-path" title={server.transport === "stdio" ? address : server.url}>
									{server.transport === "stdio" ? address : server.url}
								</dd>
							</div>
							{server.resources && (
								<div>
									<dt>{t("Resources")}</dt>
									<dd>{t("Readable through pi's resource tools")}</dd>
								</div>
							)}
						</dl>
						{server.oauth && server.state === "connected" && (
							<button type="button" className="s-link cn-signout" onClick={onSignOut}>
								{t("Sign out")}
							</button>
						)}
					</div>
				)}
				{server.error && <pre className="s-error mono cn-error">{server.error}</pre>}
			</div>
			<div className="s-row-control">
				{server.enabled && server.state === "needs-auth" && (
					<button type="button" className="s-btn accent" disabled={signingIn} onClick={onSignIn}>
						{t(signingIn ? "Waiting for browser…" : "Sign in")}
					</button>
				)}
				<button type="button" className="s-btn s-ext-remove" onClick={onEdit}>
					{t("Edit")}
				</button>
				<Switch on={server.enabled} label={t("Connect to {name}", { name: server.name })} onChange={onToggle} />
			</div>
		</div>
	);
}

function Connectors({ onCount }: { onCount: (count: number) => void }) {
	const [view, setView] = useState<ConnectorsView>();
	const [checking, setChecking] = useState(false);
	const [touched, setTouched] = useState(false);
	/** The server being edited: a server, or null for a new one. */
	const [editing, setEditing] = useState<ConnectorInfo | null>();
	const [signingIn, setSigningIn] = useState<string>();
	const show = useCallback(
		(next: ConnectorsView) => {
			setView(next);
			onCount(next.servers.length);
		},
		[onCount],
	);
	const check = useCallback(async () => {
		setChecking(true);
		const next = await attempt(() => trivium.checkConnectors());
		setChecking(false);
		if (next) show(next);
	}, [show]);
	useEffect(() => {
		void attempt(() => trivium.connectors()).then((next) => {
			if (!next) return;
			show(next);
			// Connecting starts every local server, so it happens once a run unless asked for again.
			if (!next.checked && next.servers.some((server) => server.enabled)) void check();
		});
	}, [show, check]);

	const change = async (fn: () => Promise<ConnectorsView>) => {
		const next = await attempt(fn);
		if (!next) return undefined;
		show(next);
		setTouched(true);
		return next;
	};
	const toggle = async (server: ConnectorInfo) => {
		const next = await change(() => trivium.setConnector(server.name, { enabled: !server.enabled }));
		if (next && !server.enabled) void check();
	};
	const signIn = async (name: string) => {
		setSigningIn(name);
		await change(() => trivium.signInConnector(name));
		setSigningIn(undefined);
	};
	const reload = async () => {
		const reloaded = await Promise.all(APP_IDS.map((id) => attempt(() => trivium.reloadApp(id))));
		const count = reloaded.reduce((total, paths) => total + (paths?.length ?? 0), 0);
		notify(count ? t(count === 1 ? "Reloaded {n} idle session" : "Reloaded {n} idle sessions", { n: count }) : t("No idle sessions to reload"), "info");
		setTouched(false);
	};

	const servers = view?.servers ?? [];
	const on = servers.filter((server) => server.enabled);
	const connected = on.filter((server) => server.state === "connected");
	const waiting = on.filter((server) => server.state === "needs-auth").length;
	const failing = on.filter((server) => server.state === "failed").length;
	const tools = connected.reduce((total, server) => total + server.tools.filter((tool) => tool.exposure !== "hidden").length, 0);
	return (
		<>
			<PageHeader
				icon={<PlugIcon size={18} />}
				tone="accent"
				title={t("Connectors")}
				subtitle={tx("MCP servers that give the agent tools. Shared with the pi CLI through {path}", {
					path: <span className="mono">{view ? shortPath(view.path) : "~/.pi/agent/mcp.json"}</span>,
				})}
				actions={
					servers.length > 0 && (
						<button type="button" className="s-btn soft" disabled={checking} onClick={() => void check()}>
							{t(checking ? "Checking…" : "Check connections")}
						</button>
					)
				}
			/>

			{view && servers.length > 0 && (
				<div className="s-stats">
					<span>{tx("{on} of {total} servers on", { on: <strong>{on.length}</strong>, total: servers.length })}</span>
					{view.checked && <span>{tx("{n} connected", { n: <strong>{connected.length}</strong> })}</span>}
					{view.checked && <span>{tx(tools === 1 ? "{n} tool available" : "{n} tools available", { n: <strong>{tools}</strong> })}</span>}
					{waiting > 0 && <span>{tx(waiting === 1 ? "{n} needs sign-in" : "{n} need sign-in", { n: <strong>{waiting}</strong> })}</span>}
					{failing > 0 && <span>{tx("{n} can't connect", { n: <strong>{failing}</strong> })}</span>}
				</div>
			)}

			{touched && (
				<div className="s-notice">
					<span>{t("Open sessions keep the servers and tools they started with. Changes apply the next time a session loads.")}</span>
					<button type="button" className="s-btn" onClick={() => void reload()} title={t("Running sessions keep their setup until they finish")}>
						{t("Reload idle sessions")}
					</button>
				</div>
			)}

			<Group
				title={t("MCP servers")}
				description={t("Each server's tools are named mcp__server__tool. Expand a server to choose how its tools reach the agent.")}
				aside={
					<button type="button" className="s-btn accent" onClick={() => setEditing(null)}>
						<PlusIcon size={12} width={2.6} />
						{t("Add")}
					</button>
				}
				footer={tx(
					"A project's own servers in {file} load in its sessions once you trust the project, and replace a server here with the same name.",
					{ file: <span className="mono">.pi/mcp.json</span> },
				)}
			>
				{!view && <div className="s-empty">{t("Loading…")}</div>}
				{view && !servers.length && (
					<div className="s-empty">
						{tx("No MCP servers yet. Add one, or paste the {key} block from Claude, Cursor or VS Code.", {
							key: <span className="mono">mcpServers</span>,
						})}
					</div>
				)}
				{servers.map((server) => (
					<ConnectorRow
						key={server.name}
						server={server}
						checking={checking}
						signingIn={signingIn === server.name}
						onToggle={() => void toggle(server)}
						onExposure={(exposure) => void change(() => trivium.setConnector(server.name, { exposure }))}
						onToolExposure={(tool, exposure) => void change(() => trivium.setToolExposure(server.name, tool, exposure))}
						onEdit={() => setEditing(server)}
						onSignIn={() => void signIn(server.name)}
						onSignOut={() => void change(() => trivium.signOutConnector(server.name))}
					/>
				))}
			</Group>

			{view && view.errors.length > 0 && (
				<Group title={t("Skipped entries")} description={t("pi leaves these out until they're fixed.")}>
					<div className="s-row">
						<pre className="s-error mono cn-error">{view.errors.join("\n")}</pre>
					</div>
				</Group>
			)}

			{editing !== undefined && (
				<ConnectorDialog
					server={editing ?? undefined}
					onClose={() => setEditing(undefined)}
					onSaved={(next, names) => {
						show(next);
						setTouched(true);
						if (names.length) void check();
					}}
				/>
			)}
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
	App: "In this mode's folder",
	Added: "Added to this mode from elsewhere",
	Trivium: "Comes with Trivium. Remove it if this mode shouldn't have it; Add can bring it back.",
	Global: "From ~/.pi/agent, loaded by pi everywhere",
	Project: "From the project's .pi folder",
	Package: "From a pi package",
	"Built-in": "Built into pi",
	Dev: "Development only",
};

/** What an extension registers, by kind, as pi names them: "tool x", "/x" and "on x". */
const REGISTER_KINDS = [
	{ label: "Tools", one: "{n} tool", many: "{n} tools", match: (item: string) => item.startsWith("tool ") },
	{ label: "Commands", one: "{n} command", many: "{n} commands", match: (item: string) => item.startsWith("/") },
	{ label: "Hooks", one: "{n} hook", many: "{n} hooks", match: (item: string) => item.startsWith("on ") },
];

function ExtensionRow({
	extension,
	summary,
	onToggle,
	onRemove,
}: {
	extension: ExtensionInfo;
	/** One line on what it does: Trivium's own words for packages it recommends, else the package's description. */
	summary?: string;
	onToggle: () => void;
	onRemove?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const failed = Boolean(extension.error && extension.on);
	const kinds = REGISTER_KINDS.map((kind) => ({ ...kind, items: extension.registers.filter(kind.match) })).filter(
		(kind) => kind.items.length,
	);
	const counts = kinds.map((kind) => t(kind.items.length === 1 ? kind.one : kind.many, { n: kind.items.length })).join(" · ");
	return (
		<div className={`s-row s-ext${extension.on ? "" : " off"}`}>
			<div className="s-row-text">
				<div className="s-ext-title">
					<span className="s-label">{extension.name}</span>
					<span className={`s-tag src-${extension.source.toLowerCase().replace(/[^a-z]/g, "")}`} title={t(SOURCE_HINT[extension.source])}>
						{t(extension.source === "App" ? "Mode" : extension.source)}
					</span>
					{failed && <span className="s-tag error">{t("Failed to load")}</span>}
				</div>
				{summary && <span className="s-ext-desc">{summary}</span>}
				<button type="button" className="s-ext-more" aria-expanded={open} onClick={() => setOpen(!open)}>
					{counts || t("Details")}
					<Chevron open={open} size={10} />
				</button>
				{open && (
					<dl className="s-ext-details">
						{kinds.map((kind) => (
							<div key={kind.label}>
								<dt>{t(kind.label)}</dt>
								<dd className="s-chips">
									{kind.items.map((item) => (
										<span key={item} className="s-chip mono">
											{item.replace(/^(tool|on) /, "")}
										</span>
									))}
								</dd>
							</div>
						))}
						<div>
							<dt>{t("From")}</dt>
							<dd className="mono s-path" title={extension.path}>
								{extension.display}
							</dd>
						</div>
					</dl>
				)}
				{failed && (
					<pre className="s-error mono" title={extension.error}>
						{/* pi appends the require stack; the first line says what went wrong. */}
						{extension.error?.split("\n")[0]}
					</pre>
				)}
			</div>
			<div className="s-row-control">
				{onRemove && (
					<button type="button" className="s-btn s-ext-remove" title={t("Remove {name} from this mode", { name: extension.builtIn ?? "" })} onClick={onRemove}>
						{t("Remove")}
					</button>
				)}
				<Switch on={extension.on} label={t("Load {name}", { name: extension.name })} onChange={onToggle} />
			</div>
		</div>
	);
}

/** pi-permission-system's level, written to its own config file, which the pi CLI shares. */
function PermissionsGroup({ permissions, onChange }: { permissions: PermissionSettings; onChange: (level: string) => void }) {
	const level = PERMISSION_LEVELS.find((entry) => entry.id === permissions.level);
	const options: DropdownOption[] = PERMISSION_LEVELS.map((entry) => ({ value: entry.id, label: t(entry.label) }));
	if (!level) options.push({ value: "custom", label: t("Your own rules") });
	return (
		<Group
			title={t("Permissions")}
			description={t("What pi-permission-system asks you about before it runs. .env files are always blocked.")}
			footer={tx("Saved in {path}, which the pi CLI also uses. Changes apply when a session loads.", {
				path: <span className="mono">{shortPath(permissions.path)}</span>,
			})}
		>
			<Item
				label={t("Mode")}
				hint={t(
					level?.hint ??
						(permissions.unreadable
							? "The config has comments or isn't plain JSON, so Trivium leaves it to you."
							: "The config has rules of its own. Choosing a level replaces them."),
				)}
			>
				{permissions.unreadable ? (
					<button type="button" className="s-btn soft" onClick={() => openFolder(permissions.path.replace(/[\\/][^\\/]+$/, ""))}>
						<FolderIcon size={14} />
						{t("Open folder")}
					</button>
				) : (
					<Dropdown
						label={t("Permission mode")}
						value={level?.id ?? "custom"}
						options={options}
						align="right"
						onChange={(value) => value !== "custom" && onChange(value)}
					/>
				)}
			</Item>
		</Group>
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
	/** Removes a package Trivium ships from this app, or brings it back; its extensions' on/off state is kept. */
	const setRemoved = async (name: string, remove: boolean) => {
		const removed = appSettings.removed.filter((entry) => entry !== name);
		await saveApp({ removed: remove ? [...removed, name] : removed });
		const next = await attempt(() => trivium.appDetails(app));
		if (next) setDetails(next);
		return next;
	};
	const [adding, setAdding] = useState(false);
	const added = async (next: AppDetails) => {
		setDetails(next);
		setTouched(true);
		showSettings(await trivium.getSettings());
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
				title={t(theme.name)}
				subtitle={t(APP_SUMMARY[app])}
				actions={
					details && (
						<button type="button" className="s-btn soft" onClick={() => openFolder(details.extensionDir)}>
							<FolderIcon size={14} />
							{t("Open folder")}
						</button>
					)
				}
			/>

			{details && (
				<div className="s-stats">
					<span>{tx("{on} of {total} extensions on", { on: <strong>{onCount}</strong>, total: extensions.length })}</span>
					<span>{tx("{n} tools", { n: <strong>{details.tools.length}</strong> })}</span>
					<span>{tx("{n} skills", { n: <strong>{details.skills}</strong> })}</span>
					<span>{tx("{n} prompts", { n: <strong>{details.prompts}</strong> })}</span>
					<span>{details.running ? tx("{n} running", { n: <strong>{details.running}</strong> }) : t("Nothing running")}</span>
				</div>
			)}

			{touched && (
				<div className="s-notice">
					<span>
						{details?.loaded
							? t(details.loaded === 1 ? "{n} open {mode} session still uses the previous setup." : "{n} open {mode} sessions still use the previous setup.", {
									n: details.loaded,
									mode: t(theme.name),
								})
							: t("Changes apply the next time a {mode} session loads.", { mode: t(theme.name) })}
					</span>
					{Boolean(details?.loaded) && (
						<button type="button" className="s-btn" onClick={() => void reload()} title={t("Running sessions keep their setup until they finish")}>
							{t("Reload idle sessions")}
						</button>
					)}
				</div>
			)}

			{details?.permissions && (
				<PermissionsGroup
					permissions={details.permissions}
					onChange={async (level) => {
						const next = await attempt(() => trivium.setPermissionLevel(app, level));
						if (!next) return;
						setDetails(next);
						setTouched(true);
					}}
				/>
			)}

			<Group
				title={t("Extensions")}
				description={t("pi's own extensions load first, then this mode's folder. Turn off anything this mode should skip.")}
				aside={
					<button type="button" className="s-btn accent" onClick={() => setAdding(true)}>
						<PlusIcon size={12} width={2.6} />
						{t("Add")}
					</button>
				}
				footer={
					details &&
					tx("Project extensions come from {path}, this mode's most recent project. Changes apply when a session loads.", {
						path: <span className="mono">{shortPath(details.projectDir)}</span>,
					})
				}
			>
				{!details && <div className="s-empty">{t("Loading…")}</div>}
				{details && !extensions.length && (
					<div className="s-empty">
						{tx("No extensions yet. Install a pi package, or put {ext} files in this mode's folder.", { ext: <span className="mono">.ts</span> })}
					</div>
				)}
				{extensions.map((extension) => (
					<ExtensionRow
						key={extension.path}
						extension={extension}
						summary={(() => {
							const adds = RECOMMENDED[app].find((item) => item.name === (extension.builtIn ?? packageName(extension.display)))?.adds;
							return adds ? t(adds) : extension.description;
						})()}
						onToggle={() => void toggle(extension)}
						onRemove={extension.builtIn ? () => void setRemoved(extension.builtIn!, true) : undefined}
					/>
				))}
			</Group>
			{adding && (
				<AddExtensionDialog
					app={app}
					packages={details?.packages ?? []}
					removed={appSettings.removed}
					onRestore={(name) => setRemoved(name, false)}
					onClose={() => setAdding(false)}
					onAdded={(next) => void added(next)}
				/>
			)}

			<Group title={t("Model")}>
				<Item label={t("New {mode} sessions", { mode: t(theme.name) })} hint={t("Open sessions keep the model they use")}>
					<ModelSelect
						value={appSettings.model}
						level={appSettings.thinkingLevel}
						emptyLabel={t("pi's default")}
						onChange={(key, level) => void saveApp({ model: key, thinkingLevel: key ? level : undefined })}
					/>
				</Item>
			</Group>

			{details && (
				<Group title={t("Tools")} description={t("What the agent can call in this mode. Extensions can add more.")}>
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
				<Group title={t("Instructions")} description={t("Added to pi's system prompt for every session in this mode.")}>
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
			["Search sessions in every mode", [["⌘", "K"]]],
			["Fold or unfold the sidebar", [["⌘", "\\"]]],
			["Open or close Settings", [["⌘", ","]]],
		],
	],
	[
		"Message box",
		undefined,
		[
			["Send", [["↵"]], "While a run is going, this queues it for after the run"],
			["New line", [["⇧", "↵"]]],
			["Steer the run that's going", [["⌥", "↵"]], "Reaches the agent after its current tool"],
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
						{t("to")}
					</span>
				) : (
					<span key={index} className="s-combo">
						{combo.map((key) => (
							<kbd key={key}>{keyName(key)}</kbd>
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
			<PageHeader icon={<KeyboardIcon size={18} />} tone="accent" title={t("Keyboard shortcuts")} subtitle={t("Everything Trivium does from the keyboard.")} />
			{SHORTCUTS.map(([title, description, rows]) => (
				<Group key={title} title={t(title)} description={description && t(description)}>
					{rows.map(([label, keys, hint]) => (
						<Item key={label} label={t(label)} hint={hint && t(hint)}>
							<Keys keys={keys} />
						</Item>
					))}
				</Group>
			))}
		</>
	);
}

/* About */

/** What the About page says about updates, and what its button does. */
function UpdateItem() {
	const update = useStore((s) => s.update);
	const now = useNow(60_000);
	let hint: string;
	let action: ReactNode = (
		<button type="button" className="s-btn soft" disabled={update.state === "checking"} onClick={() => void attempt(() => trivium.checkForUpdates())}>
			{t(update.state === "checking" ? "Checking…" : "Check now")}
		</button>
	);
	switch (update.state) {
		case "checking":
			hint = t("Asking GitHub for the latest release…");
			break;
		case "current": {
			const ago = relativeTime(update.checkedAt, now);
			hint = t("You have the latest version · checked {when}", {
				when: now - update.checkedAt < 60_000 ? t("just now") : /^\d/.test(ago) ? t("{time} ago", { time: ago }) : ago,
			});
			break;
		}
		case "available": {
			const available = t("Trivium {version} is available", { version: update.release.version });
			hint = update.release.installable ? available : `${available}. ${update.release.reason}`;
			action = (
				<button type="button" className="s-btn accent" onClick={() => void installUpdate()}>
					{t(update.release.installable ? "Update and restart" : "Download")}
				</button>
			);
			break;
		}
		case "downloading":
			hint = t("Downloading {version} · {percent}%", {
				version: update.release.version,
				percent: Math.floor((update.received / (update.total || 1)) * 100),
			});
			action = null;
			break;
		case "installing":
			hint = t("Installing {version}. Trivium restarts when it's done.", { version: update.release.version });
			action = null;
			break;
		case "ready":
			hint = t("{version} is ready to install", { version: update.release.version });
			action = (
				<button type="button" className="s-btn accent" onClick={() => void installUpdate()}>
					{t("Restart now")}
				</button>
			);
			break;
		case "error":
			hint = update.message;
			if (update.release) {
				action = (
					<button type="button" className="s-btn soft" onClick={() => void installUpdate()}>
						{t("Try again")}
					</button>
				);
			}
			break;
		default:
			hint = t("Trivium looks for new releases on GitHub");
	}
	const release = "release" in update ? update.release : undefined;
	return (
		<Item label={t("Status")} hint={hint}>
			{release && (
				<a className="s-btn soft" href={release.url} target="_blank" rel="noreferrer">
					{t("What's new")}
				</a>
			)}
			{action}
		</Item>
	);
}

function About() {
	const [info, setInfo] = useState<AppInfo>();
	const settings = useStore((s) => s.settings);
	useEffect(() => {
		void attempt(() => trivium.appInfo()).then(setInfo);
	}, []);
	return (
		<>
			<PageHeader
				icon={<TriviumIcon size={30} />}
				tone="logo"
				title="Trivium"
				subtitle={t("A desktop workspace for coding, research and writing, built on pi.")}
			/>
			{info && (
				<Group title={t("Versions")}>
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
			<Group title={t("Updates")}>
				<UpdateItem />
				{settings && (
					<Item label={t("Check automatically")} hint={t("At startup and every few hours")}>
						<Switch on={settings.checkUpdates} label={t("Check for updates automatically")} onChange={(on) => void updateSettings({ checkUpdates: on })} />
					</Item>
				)}
			</Group>
			<Group title={t("Project")}>
				<Item label={t("Source code")} hint={t("Issues and pull requests are welcome")}>
					<a className="s-btn soft" href="https://github.com/SkarnerV/Trivium" target="_blank" rel="noreferrer">
						GitHub
					</a>
				</Item>
				<Item label={t("License")} hint={t("Plugins you write are yours to license")}>
					<span className="s-value">MIT</span>
				</Item>
			</Group>
		</>
	);
}

/* Usage */

const RANGES: { value: UsageRange; label: string }[] = [
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "all", label: "All time" },
];

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
	return (
		<div className="seg" role="tablist" aria-label={label}>
			{options.map((option) => (
				<button key={option.value} type="button" role="tab" aria-selected={value === option.value} onClick={() => onChange(option.value)}>
					{t(option.label)}
				</button>
			))}
		</div>
	);
}

function money(dollars: number): string {
	if (dollars >= 1000) return `$${Math.round(dollars).toLocaleString()}`;
	if (dollars > 0 && dollars < 0.01) return "<$0.01";
	return `$${dollars.toFixed(2)}`;
}

function dayLabel(day: string): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(year, month - 1, date).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

/** A cost, or why there is none: replies through a plan login, or a model pi has no price for. */
function Cost({ dollars, providers, plans }: { dollars: number; providers: string[]; plans: string[] }) {
	if (dollars > 0) return <span className="u-num">{money(dollars)}</span>;
	if (providers.every((provider) => plans.includes(provider))) {
		return (
			<span className="u-num u-quiet" title={t("Logged in through a subscription, so these replies have no price")}>
				{t("Plan")}
			</span>
		);
	}
	return (
		<span className="u-num u-quiet" title={t("pi has no price for this model")}>
			—
		</span>
	);
}

/** A model's response count; pointing at it shows how fast the model answered. */
function Speed({ tally }: { tally: Tally }) {
	const firstToken = firstTokenOf(tally);
	const speed = speedOf(tally);
	return (
		<span className="u-speed" tabIndex={0}>
			{t(tally.responses === 1 ? "{n} response" : "{n} responses", { n: tally.responses.toLocaleString() })}
			<span className="u-speed-card" role="tooltip">
				<span>{t("Time to first token")}</span>
				<b>{firstToken === undefined ? "—" : duration(firstToken)}</b>
				<span>{t("Output speed")}</span>
				<b>{speed === undefined ? "—" : `${speed < 10 ? speed.toFixed(1) : Math.round(speed)} tk/s`}</b>
				<small>
					{firstToken === undefined
						? t("First tokens are timed on new replies.")
						: tally.firstTokens === tally.responses
							? t("Averaged over every response.")
							: t("First token timed on {timed} of {total} responses.", {
									timed: tally.firstTokens.toLocaleString(),
									total: tally.responses.toLocaleString(),
								})}
				</small>
			</span>
		</span>
	);
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
	return (
		<div className="u-stat">
			<span className="u-stat-label">{t(label)}</span>
			<span className="u-stat-value">{value}</span>
			<span className="u-stat-note">{note}</span>
		</div>
	);
}

/** One bar's parts, bottom to top; cache writes count as input. */
const PARTS = [
	{ key: "input", label: "Input", value: (t: Tally) => t.input + t.cacheWrite },
	{ key: "cached", label: "Cache read", value: (t: Tally) => t.cacheRead },
	{ key: "output", label: "Output", value: (t: Tally) => t.output },
] as const;

function UsageChart({ bars, metric }: { bars: UsageBar[]; metric: "tokens" | "cost" }) {
	const [hover, setHover] = useState<number>();
	const height = (tally: Tally) => (metric === "tokens" ? tokensOf(tally) : tally.cost);
	const max = Math.max(...bars.map((bar) => height(bar.tally)), 0);
	const shown = hover === undefined ? undefined : bars[hover];
	const when = (bar: UsageBar) => (bar.from === bar.to ? dayLabel(bar.from) : `${dayLabel(bar.from)} – ${dayLabel(bar.to)}`);
	return (
		<div className="s-card u-chart-card">
			<div className="u-readout">
				{shown ? (
					<>
						<span className="u-readout-when">{when(shown)}</span>
						{metric === "cost"
							? money(shown.tally.cost)
							: PARTS.map((part) => t(`{n} ${part.label.toLowerCase()}`, { n: tokens(part.value(shown.tally)) })).join(" · ")}
					</>
				) : (
					<span className="u-quiet">{t("Point at a bar for its numbers")}</span>
				)}
			</div>
			<div className="u-chart" onMouseLeave={() => setHover(undefined)}>
				{bars.map((bar, index) => (
					<div
						key={bar.from}
						className={`u-bar${hover === index ? " on" : ""}`}
						onMouseEnter={() => setHover(index)}
						aria-label={`${when(bar)}: ${metric === "cost" ? money(bar.tally.cost) : t("{n} tokens", { n: tokens(tokensOf(bar.tally)) })}`}
					>
						{max > 0 &&
							(metric === "cost" ? (
								<span className="u-part output" style={{ height: `${(bar.tally.cost / max) * 100}%` }} />
							) : (
								PARTS.map((part) => <span key={part.key} className={`u-part ${part.key}`} style={{ height: `${(part.value(bar.tally) / max) * 100}%` }} />)
							))}
					</div>
				))}
			</div>
			<div className="u-axis">
				<span>{dayLabel(bars[0].from)}</span>
				<span>{t("Today")}</span>
			</div>
		</div>
	);
}

/** Short weekday names, Sunday first, in the user's language. */
const weekdays = () => Array.from({ length: 7 }, (_, index) => new Date(2026, 0, 4 + index).toLocaleDateString(getLocale(), { weekday: "short" }));

function UsageCalendar({ report }: { report: UsageReport }) {
	const { weeks, active, streak } = useMemo(() => calendar(report), [report]);
	const [hover, setHover] = useState<CalendarDay>();
	// A month's name goes over the first week that starts in it, unless the one before is too close.
	let named = -3;
	const months = weeks.map((week, index) => {
		const first = week[0]?.day;
		const previous = weeks[index - 1]?.[0]?.day;
		if (!first || (previous && previous.slice(0, 7) === first.slice(0, 7)) || index - named < 3) return "";
		named = index;
		const [year, month] = first.split("-").map(Number);
		return new Date(year, month - 1, 1).toLocaleDateString(getLocale(), { month: "short" });
	});
	return (
		<section className="s-group">
			<div className="s-group-head">
				<h3>{t("Last 12 months")}</h3>
				<span className="u-columns">
					{t(active === 1 ? "{n} active day" : "{n} active days", { n: active })}
					{streak > 1 && ` · ${t("{n}-day streak", { n: streak })}`}
				</span>
			</div>
			<div className="s-card u-cal-card">
				<div className="u-readout">
					{hover ? (
						<>
							<span className="u-readout-when">{dayLabel(hover.day)}</span>
							{hover.tally.responses
								? `${t("{n} tokens", { n: tokens(tokensOf(hover.tally)) })} · ${money(hover.tally.cost)} · ${t(hover.tally.responses === 1 ? "{n} response" : "{n} responses", { n: hover.tally.responses })}`
								: t("No replies")}
						</>
					) : (
						<span className="u-quiet">{t("Point at a day for its numbers")}</span>
					)}
				</div>
				<div className="u-cal" style={{ gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))` }} onMouseLeave={() => setHover(undefined)}>
					<span />
					{months.map((month, index) => (
						<span key={`m${index}`} className="u-cal-month">
							{month}
						</span>
					))}
					{weekdays().map((weekday, row) => (
						<Fragment key={weekday}>
							<span className="u-cal-weekday">{row % 2 ? weekday : ""}</span>
							{weeks.map((week, column) => {
								const day = week[row];
								return day ? (
									<span
										key={day.day}
										className={`u-cal-day l${day.level}${hover?.day === day.day ? " on" : ""}`}
										onMouseEnter={() => setHover(day)}
										aria-label={`${dayLabel(day.day)}: ${t("{n} tokens", { n: tokens(tokensOf(day.tally)) })}`}
									/>
								) : (
									<span key={`e${column}`} />
								);
							})}
						</Fragment>
					))}
				</div>
				<div className="u-cal-legend">
					{t("Less")}
					{([0, 1, 2, 3, 4] as const).map((level) => (
						<i key={level} className={`u-cal-day l${level}`} />
					))}
					{t("More")}
				</div>
			</div>
		</section>
	);
}

function Usage() {
	const [report, setReport] = useState<UsageReport>();
	const [range, setRange] = useState<UsageRange>("30");
	const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
	useEffect(() => {
		void attempt(() => trivium.usage()).then(setReport);
	}, []);
	const summary = useMemo(() => report && summarize(report, range), [report, range]);
	const header = (
		<PageHeader
			icon={<ChartIcon size={18} />}
			tone="accent"
			title={t("Usage")}
			subtitle={t("Tokens and estimated cost, counted from your sessions on this computer.")}
			actions={<Segmented label={t("Time range")} value={range} options={RANGES} onChange={setRange} />}
		/>
	);
	if (!report || !summary) {
		return (
			<>
				{header}
				<div className="s-card s-empty">{t("Counting…")}</div>
			</>
		);
	}
	const { total, previous } = summary;
	const { plans } = report;
	const all = tokensOf(total);
	const before = previous && tokensOf(previous);
	const change = before ? Math.round(((all - before) / before) * 100) : undefined;
	const share = cacheShare(total);
	const unpriced = summary.models.some((model) => model.tally.cost === 0 && plans.includes(model.provider));
	const top = Math.max(...summary.apps.map((entry) => tokensOf(entry.tally)), 1);
	const providersOf = (session: SessionUsage) => [...new Set(session.buckets.map((bucket) => bucket.provider))];
	return (
		<>
			{header}
			<div className="u-stats">
				<Stat
					label="Tokens"
					value={tokens(all)}
					note={
						range === "all"
							? t("since {date}", { date: dayLabel(summary.from) })
							: change === undefined
								? t("none the {n} days before", { n: range })
								: t("{change}% on the {n} days before", { change: `${change > 0 ? "+" : ""}${change}`, n: range })
					}
				/>
				<Stat label="Estimated cost" value={money(total.cost)} note={t(unpriced ? "plus replies through a plan" : "from pi's price list")} />
				<Stat label="From cache" value={share === undefined ? "—" : `${Math.round(share * 100)}%`} note={t("of input tokens")} />
				<Stat
					label="Responses"
					value={total.responses.toLocaleString()}
					note={t(summary.sessions === 1 ? "in {n} session" : "in {n} sessions", { n: summary.sessions })}
				/>
			</div>
			{report.sessions.length > 0 && <UsageCalendar report={report} />}
			{all === 0 ? (
				<div className="s-card s-empty">{t("No replies in this time. Usage shows once a session gets an answer.")}</div>
			) : (
				<>
					<section className="s-group">
						<div className="s-group-head">
							<h3>{t(summary.bars[0].from === summary.bars[0].to ? "Each day" : "Each week")}</h3>
							<div className="u-chart-controls">
								{metric === "tokens" && (
									<span className="u-legend">
										{PARTS.map((part) => (
											<span key={part.key}>
												<i className={`u-swatch ${part.key}`} />
												{t(part.label)}
											</span>
										))}
									</span>
								)}
								<Segmented
									label={t("Chart shows")}
									value={metric}
									options={[
										{ value: "tokens", label: "Tokens" },
										{ value: "cost", label: "Cost" },
									]}
									onChange={setMetric}
								/>
							</div>
						</div>
						<UsageChart bars={summary.bars} metric={metric} />
					</section>
					<Group title={t("By mode")}>
						{summary.apps.map(({ app, tally }) => (
							<div key={app} className="s-row u-row">
								<span className="u-dot" style={{ background: THEMES[app].accent }} />
								<span className="u-name">{t(THEMES[app].name)}</span>
								<span className="u-meter">
									<span style={{ width: `${(tokensOf(tally) / top) * 100}%`, background: THEMES[app].accent }} />
								</span>
								<span className="u-num">{tokens(tokensOf(tally))}</span>
								<span className="u-num">{money(tally.cost)}</span>
							</div>
						))}
					</Group>
					<Group
						title={t("By model")}
						aside={
							<span className="u-columns">
								<span>{t("Input")}</span>
								<span>{t("Output")}</span>
								<span>{t("Cost")}</span>
							</span>
						}
					>
						{summary.models.map(({ provider, model, tally }) => (
							<div key={`${provider}/${model}`} className="s-row u-row">
								<div className="s-row-text">
									<span className="s-label">{model}</span>
									<span className="s-hint">
										{provider} · <Speed tally={tally} />
									</span>
								</div>
								<span className="u-num">{tokens(tally.input + tally.cacheRead + tally.cacheWrite)}</span>
								<span className="u-num">{tokens(tally.output)}</span>
								<Cost dollars={tally.cost} providers={[provider]} plans={plans} />
							</div>
						))}
					</Group>
					<Group title={t("Biggest sessions")}>
						{summary.top.map(({ session, last, tally }) => (
							<button
								key={session.path}
								type="button"
								className="s-row u-row u-session"
								onClick={() => {
									closeSettings();
									void openSession(session.path);
								}}
							>
								<span className="u-dot" style={{ background: THEMES[session.app].accent }} />
								<div className="s-row-text">
									<span className="s-label u-title">{session.title}</span>
									<span className="s-hint">
										<span className="mono s-path">{session.chat ? t("Chat") : shortPath(session.cwd)}</span>· {dayLabel(last)}
									</span>
								</div>
								<span className="u-num">{tokens(tokensOf(tally))}</span>
								<Cost dollars={tally.cost} providers={providersOf(session)} plans={plans} />
								<Chevron open={false} />
							</button>
						))}
					</Group>
				</>
			)}
			<p className="s-foot">
				{t(
					"Costs are estimates from pi's price list. Models used through a plan login, like a ChatGPT or GLM Coding Plan, show tokens only. Subagents count toward the session that started them, and deleted sessions no longer count.",
				)}
			</p>
		</>
	);
}

/* Page */

export function SettingsPage() {
	const section = useStore((s) => s.settingsSection);
	const app = useStore((s) => s.app);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [errors, setErrors] = useState<Partial<Record<AppId, number>>>({});
	const [servers, setServers] = useState<number>();
	const loadProviders = useCallback(() => {
		void attempt(() => trivium.providers()).then((list) => list && setProviders(list));
	}, []);
	useEffect(() => {
		loadProviders();
		void attempt(() => trivium.connectors()).then((view) => view && setServers(view.servers.length));
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
			onClick={() => openSettings(id)}
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
			<nav className="set-nav drag" aria-label={t("Settings sections")}>
				<button type="button" className="back" onClick={closeSettings}>
					<BackIcon />
					{t("Back to {mode}", { mode: t(THEMES[app].name) })}
				</button>
				<h1>{t("Settings")}</h1>
				{item("general", t("General"), <SlidersIcon />, SECTION_COLORS.general.accent)}
				{item(
					"models",
					t("Models and logins"),
					<KeyIcon />,
					SECTION_COLORS.models.accent,
					connected ? <span className="s-nav-meta">{connected}</span> : <span className="s-nav-meta warn">{t("Set up")}</span>,
				)}
				{item(
					"connectors",
					t("Connectors"),
					<PlugIcon />,
					SECTION_COLORS.connectors.accent,
					servers ? <span className="s-nav-meta">{servers}</span> : undefined,
				)}
				{item("usage", t("Usage"), <ChartIcon />, SECTION_COLORS.usage.accent)}
				{item("shortcuts", t("Keyboard shortcuts"), <KeyboardIcon />, SECTION_COLORS.shortcuts.accent)}
				<div className="set-nav-head">{t("Modes")}</div>
				{APP_IDS.map((id) =>
					item(
						id,
						t(THEMES[id].name),
						<AppIcon app={id} size={13} />,
						THEMES[id].accent,
						errors[id] ? (
							<span
								className="s-nav-meta error"
								title={t(errors[id] === 1 ? "{n} extension failed to load" : "{n} extensions failed to load", { n: errors[id] })}
							>
								{t(errors[id] === 1 ? "{n} error" : "{n} errors", { n: errors[id] })}
							</span>
						) : undefined,
					),
				)}
				<span style={{ flex: 1 }} />
				{item("about", t("About"), <InfoIcon />, SECTION_COLORS.about.accent)}
			</nav>
			<div className="workspace">
				<main className="card set-card">
					<div className="set-content">
						{section === "general" && <General />}
						{section === "models" && <Models providers={providers} reload={loadProviders} />}
						{section === "connectors" && <Connectors onCount={setServers} />}
						{section === "usage" && <Usage />}
						{section === "shortcuts" && <Shortcuts />}
						{(section === "code" || section === "research" || section === "write") && <AppPage app={section} />}
						{section === "about" && <About />}
					</div>
				</main>
			</div>
		</>
	);
}
