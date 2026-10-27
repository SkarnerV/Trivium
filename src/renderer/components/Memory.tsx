import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryDay,
	type MemoryDeletion,
	type MemoryEntry,
	type MemoryFile,
	type MemoryOverview,
	type MemoryTarget,
	type MemoryWorkspace,
} from "../../shared/protocol.ts";
import { relativeTime } from "../format.ts";
import { BackIcon, CalendarIcon, ExternalIcon, FolderIcon, GlobeIcon, InfoIcon, PenIcon, PlusIcon, SearchIcon, ShieldIcon, ToTopIcon, TrashIcon, UndoIcon } from "../icons.tsx";
import { attempt, closeSettings, errorText, trivium, useStore } from "../store.ts";
import { THEMES } from "../theme.ts";
import { transition } from "../transition.ts";
import { Dropdown } from "./Dropdown.tsx";

type Section = { kind: "global" } | { kind: "project"; cwd: string } | { kind: "daily" } | { kind: "deleted" };

const sameSection = (a: Section, b: Section) => a.kind === b.kind && (a.kind !== "project" || a.cwd === (b as { cwd: string }).cwd);

const CATEGORY_OPTIONS = [
	...MEMORY_CATEGORIES.map((category) => ({ value: category, label: categoryLabel(category) })),
	{ value: "", label: "note" },
];

function categoryLabel(category: MemoryCategory | undefined): string {
	return category === "tool-quirk" ? "tool quirk" : (category ?? "note");
}

const FILTERS: { label: string; match: (category: MemoryCategory | undefined) => boolean }[] = [
	{ label: "All", match: () => true },
	{ label: "Conventions", match: (category) => category === "convention" },
	{ label: "Lessons", match: (category) => category === "failure" || category === "correction" || category === "tool-quirk" || category === "insight" },
	{ label: "Preferences", match: (category) => category === "preference" },
];

const chars = (n: number) => n.toLocaleString("en");

function Category({ category }: { category: MemoryCategory | undefined }) {
	return <span className={`mem-cat ${category ?? "note"}`}>{categoryLabel(category)}</span>;
}

/** Entry text with `code` spans, as the agent writes them. */
function EntryText({ text }: { text: string }) {
	return <>{text.split(/(`[^`]+`)/).map((part, i) => (part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part))}</>;
}

/** The agent may write to memory at any time; reload when the window comes back. */
function useOnFocus(reload: () => void) {
	useEffect(() => {
		window.addEventListener("focus", reload);
		return () => window.removeEventListener("focus", reload);
	}, [reload]);
}

interface Undo {
	id: string;
	text: string;
}

export function MemoryPage() {
	const app = useStore((s) => s.app);
	const [section, setSection] = useState<Section>({ kind: "global" });
	const [overview, setOverview] = useState<MemoryOverview>();
	const [version, setVersion] = useState(0);
	const [undo, setUndo] = useState<Undo>();
	const reload = useCallback(() => setVersion((v) => v + 1), []);
	useOnFocus(reload);

	useEffect(() => {
		void attempt(() => trivium.memoryOverview()).then((next) => next && setOverview(next));
	}, [version]);
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector(".scrim, .dd.open, .mem-edit")) closeSettings();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	useEffect(() => {
		if (!undo) return;
		const timer = setTimeout(() => setUndo(undefined), 8000);
		return () => clearTimeout(timer);
	}, [undo]);

	const go = (next: Section) => {
		if (!sameSection(section, next)) transition("section", () => setSection(next));
	};
	const deleted = (id: string, text: string) => {
		setUndo({ id, text });
		reload();
	};
	const restore = async (id: string) => {
		setUndo(undefined);
		await attempt(() => trivium.memoryRestore(id));
		reload();
	};

	const item = (target: Section, label: string, icon: ReactNode, meta?: ReactNode) => (
		<button type="button" key={target.kind === "project" ? target.cwd : target.kind} className="set-nav-item" aria-current={sameSection(section, target) ? "page" : undefined} onClick={() => go(target)}>
			<span className="s-nav-icon">{icon}</span>
			<span className="s-nav-label ellipsis">{label}</span>
			{meta}
		</button>
	);
	const workspace = section.kind === "project" ? overview?.workspaces.find((entry) => entry.cwd === section.cwd) : undefined;

	return (
		<>
			<nav className="set-nav drag" aria-label="Memory">
				<button type="button" className="back" onClick={closeSettings}>
					<BackIcon />
					Back to {THEMES[app].name}
				</button>
				<h1>Memory</h1>
				{item({ kind: "global" }, "Everywhere", <GlobeIcon size={14} />, <span className="s-nav-meta">{overview?.global.entries ?? ""}</span>)}
				<div className="set-nav-head">Workspaces</div>
				{overview?.workspaces.map((entry) =>
					item(
						{ kind: "project", cwd: entry.cwd },
						entry.name,
						<FolderIcon size={14} />,
						entry.consent === false ? <span className="s-nav-meta warn">Off</span> : <span className="s-nav-meta">{entry.entries}</span>,
					),
				)}
				{overview && !overview.workspaces.length && <p className="mem-nav-empty">None yet. A project gets one when the agent first saves something there.</p>}
				<div className="set-nav-head">Logs</div>
				{item({ kind: "daily" }, "Daily log", <CalendarIcon size={14} />, <span className="s-nav-meta">{overview ? `${overview.days} ${overview.days === 1 ? "day" : "days"}` : ""}</span>)}
				<span style={{ flex: 1 }} />
				{item({ kind: "deleted" }, "Recently deleted", <TrashIcon size={14} />, overview?.deleted ? <span className="s-nav-meta">{overview.deleted}</span> : undefined)}
			</nav>
			<div className="workspace">
				<main className="card set-card">
					<div className="set-content">
						{section.kind === "global" && <FilePage key="global" target={{ kind: "global" }} version={version} reload={reload} onDeleted={deleted} />}
						{section.kind === "project" && workspace && (
							<FilePage key={workspace.cwd} target={{ kind: "project", cwd: workspace.cwd }} workspace={workspace} version={version} reload={reload} onDeleted={deleted} />
						)}
						{section.kind === "daily" && <DailyPage version={version} reload={reload} onDeleted={deleted} />}
						{section.kind === "deleted" && <DeletedPage version={version} restore={restore} />}
					</div>
				</main>
			</div>
			{undo && (
				<div className="mem-undo" role="status">
					<span className="ellipsis">Deleted “{undo.text.replaceAll("`", "")}”</span>
					<button type="button" onClick={() => void restore(undo.id)}>
						<UndoIcon />
						Undo
					</button>
				</div>
			)}
		</>
	);
}

function Header({ icon, title, subtitle, children }: { icon: ReactNode; title: string; subtitle: string; children?: ReactNode }) {
	return (
		<header className="s-head">
			<span className="s-head-icon">{icon}</span>
			<div className="s-head-text">
				<h2>{title}</h2>
				<p>{subtitle}</p>
			</div>
			{children && <div className="s-head-actions">{children}</div>}
		</header>
	);
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
	return (
		<label className="s-search">
			<SearchIcon size={13} />
			<input value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}

const matches = (entry: MemoryEntry, query: string) => !query || `${entry.category ?? ""} ${entry.text}`.toLowerCase().includes(query.toLowerCase());

function Meter({ file, off }: { file: MemoryFile; off?: boolean }) {
	const cut = file.entries.filter((entry) => !entry.loaded).length;
	const full = cut > 0 || file.chars >= file.limit;
	const label = off
		? "Not loading: turned off for this workspace"
		: cut
			? `Full: the last ${cut === 1 ? "entry doesn't" : `${cut} entries don't`} load`
			: "load into each session";
	return (
		<div className="s-card mem-meter">
			<div className="mem-meter-top">
				<div>
					<strong>{chars(Math.min(file.chars, file.limit))}</strong> of {chars(file.limit)} characters
				</div>
				<span>{label}</span>
			</div>
			<div className={`mem-bar${full ? " full" : ""}${off ? " off" : ""}`}>
				<i style={{ width: `${Math.min(100, (file.chars / file.limit) * 100)}%` }} />
			</div>
		</div>
	);
}

interface RowActions {
	target: MemoryTarget;
	reload: () => void;
	onDeleted: (id: string, text: string) => void;
	/** Offered in MEMORY.md files, which load from the top. */
	canMoveUp?: boolean;
}

function EntryRow({ entry, actions }: { entry: MemoryEntry; actions: RowActions }) {
	const [editing, setEditing] = useState(false);
	if (editing) return <EntryForm actions={actions} entry={entry} done={() => setEditing(false)} />;
	const remove = async () => {
		const id = await attempt(() => trivium.memoryDelete(actions.target, entry));
		if (id) actions.onDeleted(id, entry.text);
		else actions.reload();
	};
	const moveUp = async () => {
		await attempt(() => trivium.memoryMoveToTop(actions.target, entry));
		actions.reload();
	};
	return (
		<div className={`mem-entry${entry.loaded ? "" : " out"}`}>
			{entry.time && <span className="mem-time">{entry.time}</span>}
			<Category category={entry.category} />
			<span className="mem-text">
				<EntryText text={entry.text} />
			</span>
			{entry.recalled && (
				<span className="mem-recalled" title="Failures and corrections from the last 30 days reach every new session">
					Recalled
				</span>
			)}
			<span className="mem-actions">
				{actions.canMoveUp && (
					<button type="button" className="s-icon-btn" aria-label="Move to top" title="Move to top" onClick={() => void moveUp()}>
						<ToTopIcon />
					</button>
				)}
				<button type="button" className="s-icon-btn" aria-label="Edit" title="Edit" onClick={() => setEditing(true)}>
					<PenIcon size={13} />
				</button>
				<button type="button" className="s-icon-btn" aria-label="Delete" title="Delete" onClick={() => void remove()}>
					<TrashIcon />
				</button>
			</span>
		</div>
	);
}

/** Adds an entry, or edits one in place. The store refuses text that looks like a credential, and says why. */
function EntryForm({ actions, entry, done, file }: { actions: RowActions; entry?: MemoryEntry; done?: () => void; file?: string }) {
	const [category, setCategory] = useState<string>(entry ? (entry.category ?? "") : "convention");
	const [text, setText] = useState(entry?.text ?? "");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
	useEffect(() => {
		if (entry) field.current?.focus();
	}, [entry]);
	const save = async () => {
		if (!text.trim() || busy) return;
		setBusy(true);
		const picked = (category || undefined) as MemoryCategory | undefined;
		try {
			const result = entry
				? await trivium.memoryEdit(actions.target, entry, picked, text)
				: await trivium.memoryAdd(actions.target, picked, text);
			setError(result.error);
			if (!result.error) {
				if (!entry) setText("");
				done?.();
				actions.reload();
			}
		} catch (failure) {
			setError(errorText(failure));
			actions.reload();
		} finally {
			setBusy(false);
		}
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void save();
		} else if (event.key === "Escape" && done) {
			event.preventDefault();
			event.stopPropagation();
			done();
		}
	};
	const picker = <Dropdown value={category} options={CATEGORY_OPTIONS} onChange={setCategory} label="Category" />;
	const secret = error && (
		<div className="mem-error">
			<ShieldIcon />
			<span>{error}</span>
		</div>
	);
	if (entry) {
		return (
			<div className={`mem-edit${error ? " bad" : ""}`}>
				<textarea ref={field} rows={2} value={text} aria-label="Memory" onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
				{secret}
				<div className="mem-edit-foot">
					{picker}
					<span className="hint">One line{file ? ` in ${file}` : ""}. Enter saves, Esc cancels.</span>
					<button type="button" className="s-btn" onClick={done}>
						Cancel
					</button>
					<button type="button" className="s-btn accent" disabled={!text.trim() || busy} onClick={() => void save()}>
						Save
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className={`mem-add${error ? " bad" : ""}`}>
			<div className="mem-add-row">
				{picker}
				<input
					ref={field}
					value={text}
					placeholder="Add something to remember, such as how to start the dev server"
					aria-label="New memory"
					onChange={(event) => {
						setText(event.target.value);
						setError(undefined);
					}}
					onKeyDown={onKeyDown}
				/>
				<button type="button" className="s-btn accent" disabled={!text.trim() || busy} onClick={() => void save()}>
					<PlusIcon size={13} />
					Add
				</button>
			</div>
			{secret}
		</div>
	);
}

function FilePage({
	target,
	workspace,
	version,
	reload,
	onDeleted,
}: {
	target: Extract<MemoryTarget, { kind: "global" | "project" }>;
	workspace?: MemoryWorkspace;
	version: number;
	reload: () => void;
	onDeleted: (id: string, text: string) => void;
}) {
	const [file, setFile] = useState<MemoryFile>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState(FILTERS[0]!);
	useEffect(() => {
		void attempt(() => trivium.memoryFile(target)).then((next) => next && setFile(next));
	}, [version]);
	if (!file) return null;
	const actions: RowActions = { target, reload, onDeleted, canMoveUp: true };
	const shown = file.entries.filter((entry) => filter.match(entry.category) && matches(entry, query));
	const firstOut = shown.findIndex((entry) => !entry.loaded);
	const global = target.kind === "global";
	return (
		<>
			<Header
				icon={global ? <GlobeIcon size={20} /> : <FolderIcon size={20} />}
				title={global ? "Everywhere" : (workspace?.name ?? "Workspace")}
				subtitle={global ? "Preferences and facts that follow you into every project and mode." : "What the agent knows about this project, loaded into every session here."}
			>
				<Search value={query} onChange={setQuery} placeholder={global ? "Search everywhere" : "Search this workspace"} />
				{file.exists && (
					<button type="button" className="s-btn" onClick={() => void attempt(() => trivium.openFile(file.path))}>
						<ExternalIcon size={13} />
						Open file
					</button>
				)}
			</Header>
			<Meter file={file} off={workspace?.consent === false} />
			<section className="s-group">
				<div className="s-group-head">
					<div>
						<h3>Entries</h3>
						<p>{global ? "Loaded from the top, so move what matters most up." : "Saved by the agent when you ask it to remember, or when you correct it."}</p>
					</div>
					<div className="mem-filters" role="group" aria-label="Show">
						{FILTERS.map((entry) => (
							<button key={entry.label} type="button" aria-pressed={entry === filter} onClick={() => setFilter(entry)}>
								{entry.label}
							</button>
						))}
					</div>
				</div>
				<div className="s-card mem-list">
					{!file.entries.length && (
						<p className="s-empty">
							{global ? "Nothing yet. The agent saves here what you ask it to remember in every project." : "Nothing here yet."}
						</p>
					)}
					{file.entries.length > 0 && !shown.length && <p className="s-empty">No entries match.</p>}
					{shown.map((entry, index) => (
						<div key={`${entry.line}:${entry.raw}`} className="mem-item">
							{index === firstOut && (
								<div className="mem-cut">
									<InfoIcon />
									Past {chars(file.limit)} characters. These don't load, but the agent can still find them with search.
								</div>
							)}
							<EntryRow entry={entry} actions={{ ...actions, canMoveUp: entry.line !== file.entries[0]?.line }} />
						</div>
					))}
					<EntryForm actions={actions} file={global ? undefined : ".pi/memory/MEMORY.md"} />
				</div>
			</section>
			{workspace && <WorkspaceSettings workspace={workspace} reload={reload} />}
		</>
	);
}

const GIT_HINT: Record<MemoryWorkspace["git"], string> = {
	tracked: "tracked by git, so everyone with the repository gets it",
	untracked: "not committed yet",
	ignored: "ignored by git, so it stays on this computer",
	none: "not in a git repository, so it stays on this computer",
};

function WorkspaceSettings({ workspace, reload }: { workspace: MemoryWorkspace; reload: () => void }) {
	const on = workspace.consent === true;
	const hint =
		workspace.consent === undefined
			? "Not asked yet. The next session here asks before loading it."
			: on
				? "Sessions here load it. Turning it off applies to new sessions; the file stays."
				: "Turned off, so sessions here don't load it. The file stays.";
	const setConsent = async (allowed: boolean) => {
		await attempt(() => trivium.setMemoryConsent(workspace.cwd, allowed));
		reload();
	};
	const keepLocal = async () => {
		await attempt(() => trivium.keepMemoryLocal(workspace.cwd));
		reload();
	};
	return (
		<section className="s-group">
			<div className="s-group-head">
				<div>
					<h3>This workspace</h3>
				</div>
			</div>
			<div className="s-card">
				<div className="s-row">
					<div className="s-row-text">
						<span className="s-label">Load in sessions here</span>
						<span className="s-hint">{hint}</span>
					</div>
					<div className="s-row-control">
						<button type="button" role="switch" aria-checked={on} aria-label="Load in sessions here" className="switch" onClick={() => void setConsent(!on)}>
							<span />
						</button>
					</div>
				</div>
				<div className="s-row">
					<div className="s-row-text">
						<span className="s-label">Memory file</span>
						<span className="s-hint">
							<span className="mono s-path">.pi/memory/MEMORY.md</span> · {GIT_HINT[workspace.git]}
						</span>
					</div>
					{workspace.git === "untracked" && (
						<div className="s-row-control">
							<button type="button" className="s-btn" title="Adds it to .git/info/exclude, which only this computer reads" onClick={() => void keepLocal()}>
								Keep it to me
							</button>
						</div>
					)}
				</div>
			</div>
		</section>
	);
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayLabel(date: string, now = new Date()): string {
	const label = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
	if (date === localDate(now)) return `Today · ${label}`;
	if (date === localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `Yesterday · ${label}`;
	return label;
}

function DailyPage({ version, reload, onDeleted }: { version: number; reload: () => void; onDeleted: (id: string, text: string) => void }) {
	const [days, setDays] = useState<MemoryDay[]>();
	const [query, setQuery] = useState("");
	useEffect(() => {
		void attempt(() => trivium.memoryDays()).then((next) => next && setDays(next));
	}, [version]);
	if (!days) return null;
	const shown = days.map((day) => ({ day, entries: day.file.entries.filter((entry) => matches(entry, query)) })).filter((day) => day.entries.length);
	return (
		<>
			<Header icon={<CalendarIcon size={20} />} title="Daily log" subtitle="Notes the agent keeps as it works, by day, across every project.">
				<Search value={query} onChange={setQuery} placeholder="Search the log" />
			</Header>
			<div className="s-card mem-rules">
				<div>
					<strong>Loaded</strong>
					<span>Today and yesterday, in every session</span>
				</div>
				<div>
					<strong>Recalled</strong>
					<span>Failures and corrections from the last 30 days</span>
				</div>
				<div>
					<strong>Searched</strong>
					<span>Every older day, when the agent looks</span>
				</div>
			</div>
			<section className="s-group">
				<div className="s-group-head">
					<div>
						<h3>Days</h3>
						<p>One file per day, newest first.</p>
					</div>
				</div>
				<div className="s-card mem-list">
					{!days.length && <p className="s-empty">No log yet. The agent writes here as it works.</p>}
					{days.length > 0 && !shown.length && <p className="s-empty">No entries match.</p>}
					{shown.map(({ day, entries }) => (
						<div key={day.date} className="mem-item">
							<div className="mem-day">
								<span>{dayLabel(day.date)}</span>
								<span>{day.file.loads ? `${chars(Math.min(day.file.chars, day.file.limit))} of ${chars(day.file.limit)} characters` : "Not loaded"}</span>
							</div>
							{entries.map((entry) => (
								<EntryRow key={`${entry.line}:${entry.raw}`} entry={entry} actions={{ target: { kind: "daily", date: day.date }, reload, onDeleted }} />
							))}
						</div>
					))}
				</div>
			</section>
		</>
	);
}

function DeletedPage({ version, restore }: { version: number; restore: (id: string) => Promise<void> }) {
	const [list, setList] = useState<MemoryDeletion[]>();
	useEffect(() => {
		void attempt(() => trivium.memoryDeleted()).then((next) => next && setList(next));
	}, [version]);
	if (!list) return null;
	return (
		<>
			<Header icon={<TrashIcon size={20} />} title="Recently deleted" subtitle="What you or the agent deleted stays here until it's restored." />
			<section className="s-group">
				<div className="s-card mem-list">
					{!list.length && <p className="s-empty">Nothing deleted.</p>}
					{list.map((deletion) => (
						<div key={deletion.id} className="mem-entry mem-deleted">
							<span className="mem-time">{relativeTime(deletion.timestamp)}</span>
							<div className="mem-deleted-items">
								{deletion.items.map((entry, index) => (
									<div key={index} className="mem-deleted-item">
										<Category category={entry.category} />
										<span className="mem-text">
											<EntryText text={entry.text} />
											<span className="mem-where"> · {entry.where}</span>
										</span>
									</div>
								))}
							</div>
							<button type="button" className="s-btn" onClick={() => void restore(deletion.id)}>
								<UndoIcon size={13} />
								Restore
							</button>
						</div>
					))}
				</div>
			</section>
		</>
	);
}
