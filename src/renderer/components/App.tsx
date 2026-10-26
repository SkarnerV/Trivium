import { useEffect, useState } from "react";
import { appIconFilename } from "../../shared/branding.ts";
import type { AppId } from "../../shared/protocol.ts";
import { APP_IDS } from "../../shared/protocol.ts";
import { AlertIcon, CloseIcon, InfoIcon, MaximizeIcon, MinusIcon, RestoreIcon, TriviumIcon, WarnIcon } from "../icons.tsx";
import { dismissNotice, getState, notify, openSettings, setState, switchApp, trivium, useStore } from "../store.ts";
import { NEUTRAL, themeVars } from "../theme.ts";
import { panelFor, panelKind, panelOpen } from "../panels.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { EmptyPanel } from "./EmptyPanel.tsx";
import { ImageLightbox } from "./ImageTile.tsx";
import { NotePanel } from "./NotePanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { ConfirmDialog, NewSessionDialog, SearchOverlay, TrustDialog } from "./Overlays.tsx";
import { EmptyPane, SessionPane } from "./SessionPane.tsx";
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

function Toasts() {
	const notices = useStore((s) => s.notices);
	return (
		<div className="toasts" aria-live="polite">
			{notices.map((notice) => (
				<div key={notice.id} className={`toast ${notice.level}`} role={notice.level === "error" ? "alert" : "status"}>
					<span className="toast-icon">
						{notice.level === "error" ? <AlertIcon size={15} /> : notice.level === "warning" ? <WarnIcon size={14} width={2} /> : <InfoIcon size={15} />}
					</span>
					<p className="toast-text">{notice.message}</p>
					<button type="button" className="mini-btn" aria-label="Dismiss" onClick={() => dismissNotice(notice.id)}>
						<CloseIcon size={12} />
					</button>
				</div>
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
				if (state.page === "settings") setState({ page: "main" });
				else openSettings();
				return;
			}
			if (state.page === "settings") return;
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
		const { selected, app, sessions } = getState();
		for (const dialog of dialogs) {
			if (dialog.sessionPath === selected[app]) continue;
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
	const vars = page === "settings" ? themeVars(sectionApp ?? NEUTRAL) : themeVars(app);
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
	if (page === "settings") {
		return (
			<div className="shell" style={vars}>
				<WindowTitleBar app={iconApp} />
				<SettingsPage />
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
					{view && panel === "changes" && <ChangesPanel view={view} />}
					{view && panel === "note" && <NotePanel view={view} />}
					{view && panel === "review" && <ReviewPanel view={view} />}
					{view && open && !panel && <EmptyPanel view={view} kind={panelKind(app)} />}
				</div>
			</div>
			{overlay === "new" && <NewSessionDialog />}
			{overlay === "search" && <SearchOverlay />}
			<ConfirmDialog />
			<ImageLightbox />
			<TrustDialog />
			<Toasts />
		</div>
	);
}
