import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextInfo, SessionView } from "../../shared/protocol.ts";
import { tokens } from "../format.ts";
import { CloseIcon, QueueIcon, SendIcon, SteerIcon, StopIcon } from "../icons.tsx";
import { attempt, getState, setState, trivium } from "../store.ts";
import { CommandMenu, useCommandMenu } from "./CommandMenu.tsx";
import { ModelSelect } from "./ModelSelect.tsx";

function ContextRing({ context }: { context?: ContextInfo }) {
	const [open, setOpen] = useState(false);
	if (!context) return <div className="ctx" />;
	const used = context.tokens ?? context.systemTokens;
	const percent = Math.min(100, (used / context.window) * 100);
	const circumference = 2 * Math.PI * 15;
	const system = Math.min(context.systemTokens, used);
	const conversation = Math.max(0, used - system);
	const share = (value: number) => `${(value / context.window) * 100}%`;
	const label = `Context used: ${tokens(used)} of ${tokens(context.window)} tokens`;
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
				<div className="tooltip" role="tooltip">
					<div className="head">
						<span style={{ fontWeight: 500 }}>Context</span>
						<span className="num">
							{tokens(used)} / {tokens(context.window)} · {Math.round(percent)}%
						</span>
					</div>
					<div className="bar">
						<span style={{ width: share(system), background: "var(--ctx-system)" }} />
						<span style={{ width: share(conversation), background: "var(--ctx-conversation)" }} />
					</div>
					<div className="legend">
						<span className="swatch" style={{ background: "var(--ctx-system)" }} />
						<span>System prompt and tools</span>
						<span className="num">~{tokens(system)}</span>
						<span className="swatch" style={{ background: "var(--ctx-conversation)" }} />
						<span>Conversation</span>
						<span className="num">{context.tokens === null ? "?" : tokens(conversation)}</span>
					</div>
					<span className="note">
						{context.tokens === null
							? "Exact count arrives with the next response"
							: context.compactAt === null
								? "Automatic compaction is off"
								: `Compacts automatically near ${context.compactAt}%`}
					</span>
				</div>
			)}
		</div>
	);
}

function ModelPicker({ view }: { view: SessionView }) {
	const change = async (key: string | undefined, level: string) => {
		if (!key) return;
		const ok = await attempt(() => trivium.setModel(view.path, key, level).then(() => true));
		if (!ok) return;
		setState((s) => {
			const current = s.views[view.path];
			return current ? { views: { ...s.views, [view.path]: { ...current, model: key, thinkingLevel: level } } } : {};
		});
	};
	return <ModelSelect value={view.model} level={view.thinkingLevel} variant="ghost" align="right" onChange={(k, l) => void change(k, l)} />;
}

function Tray({ view }: { view: SessionView }) {
	const { steering, followUp } = view.queue;
	if (!steering.length && !followUp.length) return null;
	const clear = async () => {
		const queue = await attempt(() => trivium.clearQueue(view.path));
		if (queue) setState((s) => ({ views: { ...s.views, [view.path]: { ...view, queue } } }));
	};
	const row = (kind: "steer" | "queue", text: string, index: number) => (
		<div key={`${kind}-${index}`} className="tray-row">
			{kind === "steer" ? <SteerIcon /> : <QueueIcon />}
			<span className={`kind ${kind === "steer" ? "steer" : ""}`}>{kind === "steer" ? "Steering" : "Queued"}</span>
			<span className="text ellipsis" title={text}>
				{text}
			</span>
			<span className="when">{kind === "steer" ? "after this tool" : "after this run"}</span>
			<button type="button" className="mini-btn" aria-label="Clear pending messages" title="Clear all pending messages" onClick={() => void clear()}>
				<CloseIcon size={12} />
			</button>
		</div>
	);
	return (
		<div className="tray" role="region" aria-label="Pending work">
			{steering.map((text, index) => row("steer", text, index))}
			{followUp.map((text, index) => row("queue", text, index))}
		</div>
	);
}

export function Composer({ view }: { view: SessionView }) {
	// Starts from a draft another screen left for this session, such as "Open in Write".
	const [text, setText] = useState(() => getState().drafts[view.path] ?? "");
	useEffect(() => {
		if (getState().drafts[view.path] === undefined) return;
		setState((s) => {
			const { [view.path]: _, ...rest } = s.drafts;
			return { drafts: rest };
		});
	}, [view.path]);
	const ref = useRef<HTMLTextAreaElement>(null);
	const running = view.running;
	const menu = useCommandMenu(view.path, text, setText);

	useLayoutEffect(() => {
		const area = ref.current;
		if (!area) return;
		area.style.height = "auto";
		area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
	}, [text]);

	useEffect(() => {
		ref.current?.focus();
	}, [view.path]);

	const send = async (mode: "prompt" | "steer" | "followUp") => {
		const message = text.trim();
		if (!message) return;
		setText("");
		const result = await attempt(() => trivium.send(view.path, message, mode).then(() => true));
		if (!result) setText(message);
	};

	const stop = () => void attempt(() => trivium.abort(view.path));

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (menu.onKeyDown(event)) return;
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void send(running ? (event.altKey ? "followUp" : "steer") : "prompt");
		} else if (event.key === "Escape" && running) {
			event.preventDefault();
			stop();
		}
	};

	return (
		<div className="dock">
			<div className="dock-inner">
				{running && <Tray view={view} />}
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
				<div className="composer">
					<label style={{ display: "block" }}>
						<span className="sr-only">Message</span>
						<textarea
							ref={ref}
							rows={1}
							value={text}
							placeholder={running ? "Message to steer the current run" : "Ask for the next change, or type / for commands"}
							onChange={(event) => setText(event.target.value)}
							onKeyDown={onKeyDown}
						/>
					</label>
					<div className="composer-bar">
						<ContextRing context={view.context} />
						<ModelPicker view={view} />
						{running ? (
							<button type="button" className="round-btn" aria-label="Stop" title="Stop (esc)" onClick={stop}>
								<StopIcon />
							</button>
						) : (
							<button
								type="button"
								className="round-btn"
								aria-label="Send"
								disabled={!text.trim()}
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
