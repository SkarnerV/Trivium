import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { DialogAnswer, DialogRequest } from "../../shared/protocol.ts";
import { WarnIcon } from "../icons.tsx";
import { attempt, desk, setState } from "../store.ts";

function answer(id: string, value: DialogAnswer): void {
	setState((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) }));
	void attempt(() => desk.answerDialog(id, value));
}

function Waiting() {
	return (
		<div className="ask-head">
			<span className="run-dot" />
			<strong>Waiting for your answer</strong>
		</div>
	);
}

function SelectCard({ request }: { request: Extract<DialogRequest, { kind: "select" }> }) {
	const [active, setActive] = useState(0);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const pick = (index: number) => answer(request.id, { value: request.options[index]! });
	return (
		<div
			ref={ref}
			className="ask"
			tabIndex={-1}
			onKeyDown={(event) => {
				const digit = Number(event.key);
				if (digit >= 1 && digit <= Math.min(9, request.options.length)) pick(digit - 1);
				else if (event.key === "ArrowDown") setActive((active + 1) % request.options.length);
				else if (event.key === "ArrowUp") setActive((active - 1 + request.options.length) % request.options.length);
				else if (event.key === "Enter") pick(active);
				else if (event.key === "Escape") answer(request.id, { cancelled: true });
				else return;
				event.preventDefault();
			}}
		>
			<Waiting />
			<p className="ask-q">{request.title}</p>
			<div className="options">
				{request.options.map((option, index) => (
					<button
						key={option}
						type="button"
						className={`option${index === active ? " active" : ""}`}
						onMouseEnter={() => setActive(index)}
						onClick={() => pick(index)}
					>
						<span className="num">{index < 9 ? index + 1 : "·"}</span>
						{option}
					</button>
				))}
			</div>
			<div className="ask-keys">
				<span>1–{Math.min(9, request.options.length)} choose</span>
				<span>esc dismiss</span>
			</div>
		</div>
	);
}

function ConfirmCard({ request }: { request: Extract<DialogRequest, { kind: "confirm" }> }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<div
			ref={ref}
			className="ask"
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.key === "Escape") answer(request.id, { confirmed: false });
				else if (event.key === "Enter" && event.metaKey) answer(request.id, { confirmed: true });
				else return;
				event.preventDefault();
			}}
		>
			<div className="ask-head">
				<span
					style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 7, background: "#FDF1E1", color: "#A65A08" }}
				>
					<WarnIcon />
				</span>
				<strong>{request.title}</strong>
			</div>
			{request.message && <p className="ask-msg">{request.message}</p>}
			<div className="btn-row">
				<button type="button" className="btn" onClick={() => answer(request.id, { confirmed: false })}>
					Decline <span className="kbd">esc</span>
				</button>
				<button type="button" className="btn primary" onClick={() => answer(request.id, { confirmed: true })}>
					Allow <span className="kbd">⌘↵</span>
				</button>
			</div>
		</div>
	);
}

function TextCard({ request }: { request: Extract<DialogRequest, { kind: "input" | "editor" }> }) {
	const [value, setValue] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const submit = () => answer(request.id, { value });
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") answer(request.id, { cancelled: true });
		else if (event.key === "Enter" && (event.metaKey || request.kind === "input")) submit();
		else return;
		event.preventDefault();
	};
	return (
		<div className="ask">
			<Waiting />
			<label style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<span className="ask-q">{request.title}</span>
				<span className="ask-field">
					{request.kind === "editor" ? (
						<textarea ref={ref} rows={8} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} />
					) : (
						<input
							ref={ref}
							type="text"
							value={value}
							placeholder={request.placeholder ?? "Your answer"}
							onChange={(e) => setValue(e.target.value)}
							onKeyDown={onKeyDown}
						/>
					)}
					<button type="button" className="btn primary" style={{ minHeight: 30 }} onClick={submit}>
						Answer <span className="kbd">{request.kind === "editor" ? "⌘↵" : "↵"}</span>
					</button>
				</span>
			</label>
		</div>
	);
}

export function AskCard({ request }: { request: DialogRequest }) {
	if (request.kind === "select") return <SelectCard request={request} />;
	if (request.kind === "confirm") return <ConfirmCard request={request} />;
	return <TextCard request={request} />;
}
