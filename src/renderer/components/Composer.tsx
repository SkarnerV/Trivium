import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PERMISSION_LEVELS } from "../../shared/permissions.ts";
import type { ContextInfo, PermissionSettings, SessionView } from "../../shared/protocol.ts";
import { tokens } from "../format.ts";
import { MoreIcon, PaperclipIcon, PenIcon, QueueIcon, SendIcon, ShieldIcon, SteerIcon, StopIcon, TrashIcon } from "../icons.tsx";
import {
	attempt,
	deleteQueued,
	holdQueue,
	type QueuedMessage,
	queueMessage,
	resumeQueue,
	sendQueuedNow,
	setState,
	trivium,
	unqueueMessage,
	useStore,
} from "../store.ts";
import { AttachmentChips, useAttachments } from "./Attachments.tsx";
import { CommandMenu, useCommandMenu } from "./CommandMenu.tsx";
import { ContextMenu } from "./ContextMenu.tsx";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { ModelMenu } from "./ModelSelect.tsx";
import { keyCombo, keyName } from "../platform.ts";
import { t } from "../i18n.tsx";

function ContextRing({ context }: { context?: ContextInfo }) {
	const [open, setOpen] = useState(false);
	if (!context) return <div className="ctx" />;
	const used = context.tokens ?? context.systemTokens;
	const percent = Math.min(100, (used / context.window) * 100);
	const circumference = 2 * Math.PI * 15;
	const system = Math.min(context.systemTokens, used);
	const conversation = Math.max(0, used - system);
	const share = (value: number) => `${(value / context.window) * 100}%`;
	const label = t("Context used: {used} of {total} tokens", { used: tokens(used), total: tokens(context.window) });
	return (
		<div className="ctx">
			<button
				type="button"
				aria-label={label}
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
			>
				<svg width="15" height="15" viewBox="0 0 36 36" aria-hidden="true">
					<circle cx="18" cy="18" r="15" fill="none" stroke="var(--ring-track)" strokeWidth="5" />
					<circle
						cx="18"
						cy="18"
						r="15"
						fill="none"
						stroke="var(--accent)"
						strokeWidth="5"
						strokeDasharray={`${Math.max(1, (percent / 100) * circumference)} ${circumference}`}
						transform="rotate(-90 18 18)"
						strokeLinecap="round"
					/>
				</svg>
			</button>
			{open && (
				<div className="ctx-card" role="tooltip">
					<span className="ctx-title">{t("Context")}</span>
					<div className="ctx-head">
						<span className="ctx-percent">{Math.round(percent)}%</span>
						<span className="ctx-total">{t("{used} of {total} tokens", { used: tokens(used), total: tokens(context.window) })}</span>
					</div>
					<div className="ctx-bar">
						<div className="ctx-fill">
							<span style={{ width: share(system), background: "var(--ctx-system)" }} />
							<span style={{ width: share(conversation), background: "var(--ctx-conversation)" }} />
						</div>
						{context.compactAt !== null && <i className="ctx-limit" style={{ left: `${context.compactAt}%` }} />}
					</div>
					<div className="ctx-legend">
						<span className="swatch" style={{ background: "var(--ctx-system)" }} />
						<span>{t("System prompt and tools")}</span>
						<span className="num">~{tokens(system)}</span>
						<span className="swatch" style={{ background: "var(--ctx-conversation)" }} />
						<span>{t("Conversation")}</span>
						<span className="num">{context.tokens === null ? "?" : tokens(conversation)}</span>
					</div>
					<span className="ctx-note">
						{context.tokens === null
							? t("Exact count arrives with the next response")
							: context.compactAt === null
								? t("Automatic compaction is off")
								: t("Compacts automatically near {percent}%", { percent: context.compactAt })}
					</span>
				</div>
			)}
		</div>
	);
}

function ModelPicker({ view }: { view: SessionView }) {
	const change = async (key: string, level: string) => {
		const ok = await attempt(() => trivium.setModel(view.path, key, level).then(() => true));
		if (!ok) return;
		setState((s) => {
			const current = s.views[view.path];
			return current ? { views: { ...s.views, [view.path]: { ...current, model: key, thinkingLevel: level } } } : {};
		});
	};
	return <ModelMenu value={view.model} level={view.thinkingLevel} onChange={(k, l) => void change(k, l)} />;
}

/** pi-permission-system's level. Its config is shared, so the choice reaches every session that loads it. */
function PermissionPicker({ permissions }: { permissions: PermissionSettings }) {
	// A config Trivium can't parse is the user's to edit by hand.
	if (permissions.unreadable) return null;
	const known = PERMISSION_LEVELS.some((entry) => entry.id === permissions.level);
	const options: DropdownOption[] = PERMISSION_LEVELS.map((entry) => ({ value: entry.id, label: t(entry.label) }));
	if (!known) options.push({ value: "custom", label: t("Your own rules") });
	const change = async (level: string) => {
		const next = await attempt(() => trivium.setSessionPermissions(level));
		if (!next) return;
		setState((s) => ({
			views: Object.fromEntries(
				Object.entries(s.views).map(([path, view]) => [path, view.permissions ? { ...view, permissions: next } : view]),
			),
		}));
	};
	return (
		<Dropdown
			label={t("Permission mode")}
			value={known ? permissions.level : "custom"}
			options={options}
			variant="ghost"
			icon={<ShieldIcon size={13} />}
			onChange={(value) => value !== "custom" && void change(value)}
		/>
	);
}

function QueuedRow({ path, message, running, onEdit }: { path: string; message: QueuedMessage; running: boolean; onEdit: () => void }) {
	const [menu, setMenu] = useState<{ x: number; y: number }>();
	// The click that closes the menu also reaches the button; it should not open the menu again.
	const closed = useRef(0);
	const files = message.attachments.map((item) => item.name).join(", ");
	return (
		<div className="tray-row">
			<QueueIcon />
			<span className="kind">{t("Queued")}</span>
			<span className="text ellipsis" title={[message.text, files].filter(Boolean).join("\n")}>
				{message.text || files}
			</span>
			{message.text && message.attachments.length > 0 && (
				<span className="when" title={files}>
					<PaperclipIcon size={12} /> {message.attachments.length}
				</span>
			)}
			<button
				type="button"
				className="tray-btn"
				title={t(running ? "Send into the running turn now" : "Send now")}
				onClick={() => void sendQueuedNow(path, message.id)}
			>
				<SteerIcon />
				{t(running ? "Steer" : "Send")}
			</button>
			<button type="button" className="mini-btn" aria-label={t("Delete queued message")} title={t("Delete")} onClick={() => deleteQueued(path, message.id)}>
				<TrashIcon size={13} />
			</button>
			<button
				type="button"
				className="mini-btn"
				aria-label={t("More")}
				title={t("More")}
				aria-expanded={Boolean(menu)}
				onClick={(event) => {
					if (Date.now() - closed.current < 300) return;
					const rect = event.currentTarget.getBoundingClientRect();
					setMenu({ x: rect.right, y: rect.top - 6 });
				}}
			>
				<MoreIcon size={14} />
			</button>
			{menu && (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					align="right"
					label={t("More")}
					entries={[{ label: t("Edit"), icon: <PenIcon size={14} />, onSelect: onEdit }]}
					onClose={() => {
						closed.current = Date.now();
						setMenu(undefined);
					}}
				/>
			)}
		</div>
	);
}

function Tray({ view, onEdit }: { view: SessionView; onEdit: (message: QueuedMessage) => void }) {
	const queued = useStore((s) => s.queued[view.path]) ?? [];
	// What pi holds itself: steers waiting for the current tool to finish, and follow-ups an extension queued.
	const { steering, followUp } = view.running ? view.queue : { steering: [], followUp: [] };
	if (!view.compacting && !steering.length && !followUp.length && !queued.length) return null;
	const row = (kind: "steer" | "queue", text: string, index: number) => (
		<div key={`${kind}-${index}`} className="tray-row">
			{kind === "steer" ? <SteerIcon /> : <QueueIcon />}
			<span className={`kind ${kind === "steer" ? "steer" : ""}`}>{t(kind === "steer" ? "Steering" : "Queued")}</span>
			<span className="text ellipsis" title={text}>
				{text}
			</span>
			<span className="when">{t(kind === "steer" ? "after this tool" : "after this run")}</span>
		</div>
	);
	return (
		<div className="tray" role="region" aria-label={t("Pending work")}>
			{view.compacting && (
				<div className="tray-row" role="status">
					<span className="text shimmer">{t("Compacting the conversation…")}</span>
				</div>
			)}
			{steering.map((text, index) => row("steer", text, index))}
			{followUp.map((text, index) => row("queue", text, index))}
			{queued.map((message) => (
				<QueuedRow key={message.id} path={view.path} message={message} running={view.running} onEdit={() => onEdit(message)} />
			))}
		</div>
	);
}

export function Composer({ view }: { view: SessionView }) {
	// Takes a draft left for this session, such as from "Open in Write" or an earlier message taken back to edit.
	const draft = useStore((s) => s.drafts[view.path]);
	const [text, setText] = useState(() => draft?.text ?? "");
	const ref = useRef<HTMLTextAreaElement>(null);
	const running = view.running;
	// Stopping a run also stops a compaction, including one started by /compact while nothing ran.
	const stoppable = running || view.compacting;
	const menu = useCommandMenu(view.path, text, setText);
	const unsent = useRef(text);
	unsent.current = text;
	// Keeps an unsent message for when the user comes back to this session.
	const files = useAttachments((attachments) => {
		if (!unsent.current.trim() && !attachments.length) return;
		setState((s) => ({ drafts: { ...s.drafts, [view.path]: { text: unsent.current, attachments } } }));
	});
	useEffect(() => {
		if (!draft) return;
		setText(draft.text);
		files.replace(draft.attachments);
		setState((s) => {
			const { [view.path]: _, ...rest } = s.drafts;
			return { drafts: rest };
		});
		ref.current?.focus();
	}, [draft]);
	const [dragging, setDragging] = useState(false);
	const models = useStore((s) => s.models);
	const model = models.find((m) => m.key === view.model);
	const imageWarning =
		model && !model.images && files.items.some((item) => item.kind === "image")
			? t("{model} can't read images. Pick another model to send them.", { model: model.name })
			: undefined;

	useLayoutEffect(() => {
		const area = ref.current;
		if (!area) return;
		area.style.height = "auto";
		area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
	}, [text]);

	useEffect(() => {
		ref.current?.focus();
	}, [view.path]);

	const send = async (mode: "prompt" | "steer") => {
		const message = text.trim();
		const attached = files.items;
		if (!message && !attached.length) return;
		setText("");
		const ids = files.takeIds();
		// A message written while the session is busy waits above the box for the run to end.
		if (mode === "prompt" && stoppable) {
			queueMessage(view.path, { text: message, attachments: attached });
			return;
		}
		if (mode === "prompt") resumeQueue(view.path);
		const result = await attempt(() => trivium.send(view.path, message, mode, ids).then(() => true));
		if (!result) {
			setText(message);
			files.restore(attached);
		}
	};

	const stop = () => {
		// What the user queued waits for them instead of going out once the run stops.
		holdQueue(view.path);
		void attempt(() => trivium.abort(view.path));
	};

	/** Puts a queued message back in the box, in front of whatever is being written there. */
	const edit = (message: QueuedMessage) => {
		if (!unqueueMessage(view.path, message.id)) return;
		setText((current) => (current.trim() ? `${message.text}\n\n${current}` : message.text));
		files.restore([...message.attachments, ...files.items]);
		ref.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (menu.onKeyDown(event)) return;
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void send(running && event.altKey ? "steer" : "prompt");
		} else if (event.key === "Escape" && stoppable) {
			event.preventDefault();
			stop();
		}
	};

	return (
		<div className="dock">
			<div className="dock-inner">
				<Tray view={view} onEdit={edit} />
				{menu.open && (
					<CommandMenu
						items={menu.items}
						active={menu.active}
						argsMode={menu.argsMode}
						onHover={menu.setActive}
						onChoose={(item) => {
							menu.choose(item);
							ref.current?.focus();
						}}
					/>
				)}
				<div
					className={`composer${dragging ? " dropping" : ""}`}
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						files.addFiles([...event.dataTransfer.files]);
					}}
				>
					<AttachmentChips items={files.items} pending={files.pending} warning={imageWarning} onRemove={files.remove} />
					<label style={{ display: "block" }}>
						<span className="sr-only">{t("Message")}</span>
						<textarea
							ref={ref}
							rows={1}
							value={text}
							placeholder={
								running
									? t("Queue a message for after this run, or {keys} to steer it", { keys: keyCombo(["⌥", "↵"]) })
									: t("Ask for the next change, or type / for commands")
							}
							onChange={(event) => setText(event.target.value)}
							onPaste={(event) => {
								const pasted = [...event.clipboardData.files];
								if (!pasted.length) return;
								event.preventDefault();
								files.addFiles(pasted);
							}}
							onKeyDown={onKeyDown}
						/>
					</label>
					<div className="composer-bar">
						<button type="button" className="icon-btn attach-btn" aria-label={t("Attach files")} title={t("Attach files or images")} onClick={files.pick}>
							<PaperclipIcon />
						</button>
						{view.permissions && <PermissionPicker permissions={view.permissions} />}
						<ContextRing context={view.context} />
						<ModelPicker view={view} />
						{stoppable ? (
							<button type="button" className="round-btn" aria-label={t("Stop")} title={t("Stop ({key})", { key: keyName("esc") })} onClick={stop}>
								<StopIcon />
							</button>
						) : (
							<button
								type="button"
								className="round-btn"
								aria-label={t("Send")}
								disabled={!text.trim() && !files.items.length}
								onClick={() => void send("prompt")}
							>
								<SendIcon />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
