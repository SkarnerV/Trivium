import { useEffect } from "react";
import { APP_IDS } from "../../shared/protocol.ts";
import { CloseIcon } from "../icons.tsx";
import { dismissNotice, getState, notify, openSettings, setState, switchApp, useStore } from "../store.ts";
import { NEUTRAL, themeVars } from "../theme.ts";
import { ChangesPanel } from "./ChangesPanel.tsx";
import { NewSessionDialog, SearchOverlay } from "./Overlays.tsx";
import { EmptyPane, SessionPane } from "./SessionPane.tsx";
import { SettingsPage } from "./Settings.tsx";
import { PeekPanel, Rail, Sidebar } from "./Sidebar.tsx";

function Toasts() {
	const notices = useStore((s) => s.notices);
	return (
		<div className="toasts" aria-live="polite">
			{notices.map((notice) => (
				<div key={notice.id} className="toast" role={notice.level === "error" ? "alert" : "status"}>
					<span
						className="live-dot"
						style={{ background: notice.level === "error" ? "#FF8A80" : notice.level === "warning" ? "#F5C26B" : "#8F92FF" }}
					/>
					<span>{notice.message}</span>
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
	const changesHidden = useStore((s) => (path ? Boolean(s.changesHidden[path]) : false));
	const showChanges = app === "code" && view !== undefined && view.changes.length > 0 && !changesHidden;
	const page = useStore((s) => s.page);
	const section = useStore((s) => s.settingsSection);
	useShortcuts();
	useDialogAlerts();
	const sectionApp = section === "code" || section === "research" || section === "write" ? section : undefined;
	const vars = page === "settings" ? themeVars(sectionApp ?? NEUTRAL) : themeVars(app);
	useEffect(() => {
		document.body.style.background = vars["--chrome"]!;
	}, [vars["--chrome"]]);
	if (page === "settings") {
		return (
			<div className="shell" style={vars}>
				<SettingsPage />
				<Toasts />
			</div>
		);
	}
	return (
		<div className={`shell${folded ? " folded" : ""}`} style={vars}>
			{folded ? <Rail /> : <Sidebar />}
			<div className="workspace">
				<div className="card">
					{folded && peek && <PeekPanel />}
					{view ? <SessionPane view={view} /> : <EmptyPane />}
					{showChanges && <ChangesPanel view={view} />}
				</div>
			</div>
			{overlay === "new" && <NewSessionDialog />}
			{overlay === "search" && <SearchOverlay />}
			<Toasts />
		</div>
	);
}
