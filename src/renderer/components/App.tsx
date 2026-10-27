import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appIconFilename } from "../../shared/branding.ts";
import type { AppId, Notice } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { AlertIcon, Chevron, CloseIcon, InfoIcon, MaximizeIcon, MinusIcon, RestoreIcon, TriviumIcon, WarnIcon } from "../icons.tsx";
import { closeSettings, dismissNotice, getState, holdNotice, notify, openSettings, setState, switchApp, trivium, useStore } from "../store.ts";
import { NEUTRAL, sectionTheme, themeVars } from "../theme.ts";
import { panelFor, panelKind, panelOpen } from "../panels.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { EmptyPanel } from "./EmptyPanel.tsx";
import { ImageLightbox } from "./ImageTile.tsx";
import { NotePanel } from "./NotePanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { ConfirmDialog, NewSessionDialog, SearchOverlay, StartingSessionDialog, TrustDialog } from "./Overlays.tsx";
import { EmptyPane, SessionPane } from "./SessionPane.tsx";
import { MemoryPage } from "./Memory.tsx";
import { SettingsPage } from "./Settings.tsx";
import { AppSwitcher, PeekPanel, Rail, Sidebar } from "./Sidebar.tsx";

const IS_WINDOWS = navigator.userAgent.includes("Windows");

function WindowTitleBar({ app, showAppSwitcher = false }: { app: AppId; showAppSwitcher?: boolean }) {
	const [maximized, setMaximized] = useState(false);
	useEffect(() => {
		if (!IS_WINDOWS) return;
		void trivium.windowIsMaximized().then(setMaximized);
		return trivium.onWindowMaximized(setMaximized);
	}, []);
	return (
		<header className="window-titlebar drag" aria-label="Trivium window">
			<span className="window-mark" aria-hidden="true"><TriviumIcon app={app} size={18} /></span>
			<span>Trivium</span>
			{IS_WINDOWS && showAppSwitcher && (
				<div className="window-app-switcher">
					<AppSwitcher />
				</div>
			)}
			{IS_WINDOWS && (
				<div className="window-controls">
					<button type="button" aria-label="Minimize" title="Minimize" onClick={() => void trivium.windowMinimize()}>
						<MinusIcon size={13} />
					</button>
					<button
						type="button"
						aria-label={maximized ? "Restore" : "Maximize"}
						title={maximized ? "Restore" : "Maximize"}
						onClick={() => void trivium.windowToggleMaximize()}
					>
						{maximized ? <RestoreIcon size={12} /> : <MaximizeIcon size={12} />}
					</button>
					<button type="button" className="close" aria-label="Close" title="Close" onClick={() => void trivium.windowClose()}>
						<CloseIcon size={14} />
					</button>
				</div>
			)}
		</header>
	);
}

/** One line high, so a long error doesn't cover the thread; the user can expand it to read the rest. */
function Toast({ notice }: { notice: Notice }) {
	const text = useRef<HTMLParagraphElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [clipped, setClipped] = useState(false);
	useLayoutEffect(() => {
		const element = text.current;
		if (element && !expanded) setClipped(element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);
	}, [notice.message, expanded]);
	return (
		<div className={`toast ${notice.level}${expanded ? " expanded" : ""}`} role={notice.level === "error" ? "alert" : "status"}>
			<span className="toast-icon">
				{notice.level === "error" ? <AlertIcon size={14} /> : notice.level === "warning" ? <WarnIcon size={13} width={2} /> : <InfoIcon size={14} />}
			</span>
			<p className="toast-text" ref={text} title={clipped && !expanded ? notice.message : undefined}>
				{notice.message}
			</p>
			{(clipped || expanded) && (
				<button
					type="button"
					className="mini-btn"
					aria-expanded={expanded}
					aria-label={expanded ? "Show less" : "Show full message"}
					title={expanded ? "Show less" : "Show full message"}
					onClick={() => {
						holdNotice(notice.id);
						setExpanded(!expanded);
					}}
				>
					<Chevron open={expanded} down size={12} />
				</button>
			)}
			<button type="button" className="mini-btn" aria-label="Dismiss" title="Dismiss" onClick={() => dismissNotice(notice.id)}>
				<CloseIcon size={12} />
			</button>
		</div>
	);
}

function Toasts() {
	const notices = useStore((s) => s.notices);
	return (
		<div className="toasts" aria-live="polite">
			{notices.map((notice) => (
				<Toast key={notice.id} notice={notice} />
			))}
		</div>
	);
}

function useShortcuts() {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			const state = getState();
			if (event.key === ",") {
				event.preventDefault();
				if (state.page === "settings") closeSettings();
				else openSettings();
				return;
			}
			if (state.page !== "main") return;
			if (/^[1-3]$/.test(event.key) && !state.overlay) {
				switchApp(APP_IDS[Number(event.key) - 1]!);
			} else if (event.key === "n") {
				setState({ overlay: "new" });
			} else if (event.key === "k") {
				setState({ overlay: state.overlay === "search" ? null : "search" });
			} else if (event.key === "\\") {
				setState({ folded: !state.folded, peek: false });
			} else {
				return;
			}
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}

/** Tells the user when a session they are not looking at needs an answer. */
function useDialogAlerts() {
	const dialogs = useStore((s) => s.dialogs);
	useEffect(() => {
		const { selected, app, sessions, views } = getState();
		for (const dialog of dialogs) {
			// A session not on screen yet asks in StartingSessionDialog instead.
			if (dialog.sessionPath === selected[app] || !views[dialog.sessionPath]) continue;
			const session = sessions.find((s) => s.path === dialog.sessionPath);
			notify(`"${session?.title ?? "A session"}" is waiting for your answer`, "warning");
		}
	}, [dialogs.length]);
}

export function App() {
	const app = useStore((s) => s.app);
	const folded = useStore((s) => s.folded);
	const peek = useStore((s) => s.peek);
	const overlay = useStore((s) => s.overlay);
	const path = useStore((s) => s.selected[s.app]);
	const view = useStore((s) => (path ? s.views[path] : undefined));
	const hidden = useStore((s) => (path ? s.changesHidden[path] : undefined));
	const open = view ? panelOpen(app, view, hidden) : false;
	const panel = view && open ? panelFor(app, view) : undefined;
	const page = useStore((s) => s.page);
	const section = useStore((s) => s.settingsSection);
	useShortcuts();
	useDialogAlerts();
	const sectionApp = section === "code" || section === "research" || section === "write" ? section : undefined;
	const iconApp = page === "settings" ? sectionApp ?? "code" : app;
	const sidebarWidth = useStore((s) => s.sidebarWidth);
	const panelWidth = useStore((s) => s.panelWidth);
	const vars = page === "settings" ? themeVars(sectionApp ?? sectionTheme(section)) : themeVars(app);
	const widths: Record<string, string> = {};
	if (sidebarWidth) widths["--sidebar-width"] = `${sidebarWidth}px`;
	if (panelWidth) widths["--panel-width"] = `${panelWidth}px`;
	useEffect(() => {
		const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
		if (favicon) favicon.href = appIconFilename(iconApp);
		void trivium.setWindowIcon(iconApp).catch(console.error);
	}, [iconApp]);
	useEffect(() => {
		document.body.style.background = vars["--chrome"]!;
		if (document.documentElement.classList.contains("windows")) {
			void trivium.setWindowChrome(vars["--chrome"]!).catch(console.error);
		}
	}, [vars["--chrome"]]);
	if (page === "memory") {
		return (
			<div className="shell" style={themeVars(NEUTRAL)}>
				<WindowTitleBar app={iconApp} />
				<MemoryPage />
				<ConfirmDialog />
				<Toasts />
			</div>
		);
	}
	if (page === "settings") {
		return (
			<div className="shell" style={vars}>
				<WindowTitleBar app={iconApp} />
				<SettingsPage />
				<ConfirmDialog />
				<Toasts />
			</div>
		);
	}
	return (
		<div className={`shell${folded ? " folded" : ""}`} style={{ ...vars, ...widths }}>
			<WindowTitleBar app={iconApp} showAppSwitcher />
			{folded ? <Rail /> : <Sidebar />}
			<div className="workspace">
				<div className="card">
					{folded && peek && <PeekPanel />}
					{view ? <SessionPane view={view} /> : <EmptyPane />}
					{/* The Code panel has its own empty state, beside the repository's changes. */}
					{view && open && app === "code" && <ChangesPanel view={view} />}
					{view && panel === "note" && <NotePanel view={view} />}
					{view && panel === "review" && <ReviewPanel view={view} />}
					{view && open && !panel && app !== "code" && <EmptyPanel view={view} kind={panelKind(app)} />}
					<Toasts />
				</div>
			</div>
			{overlay === "new" && <NewSessionDialog />}
			{overlay === "search" && <SearchOverlay />}
			<ConfirmDialog />
			<ImageLightbox />
			<TrustDialog />
			<StartingSessionDialog />
		</div>
	);
}
