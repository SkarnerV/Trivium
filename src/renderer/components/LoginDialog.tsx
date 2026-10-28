import { useEffect, useRef, useState } from "react";
import { CloseIcon } from "../icons.tsx";
import { attempt, trivium, setState, useStore } from "../store.ts";
import { t } from "../i18n.tsx";

/** Shows a provider login as pi drives it: links to open, codes to enter, and questions to answer. */
export function LoginDialog() {
	const login = useStore((s) => s.login)!;
	const [value, setValue] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const prompts = login.events.filter((event) => event.type === "prompt");
	const done = login.events.find((event) => event.type === "done");
	const answered = useRef(new Set<string>());
	const prompt = done ? undefined : prompts.findLast((event) => !answered.current.has(event.prompt.id))?.prompt;
	const infos = login.events.filter((event) => event.type === "info" || event.type === "device_code");

	useEffect(() => {
		setValue("");
		input.current?.focus();
	}, [prompt?.id]);

	useEffect(() => {
		if (done?.type === "done" && done.ok) {
			const timer = setTimeout(() => setState({ login: undefined }), 900);
			return () => clearTimeout(timer);
		}
	}, [done]);

	const answer = (text: string | undefined) => {
		if (!prompt) return;
		answered.current.add(prompt.id);
		setValue("");
		void attempt(() => trivium.answerLogin(prompt.id, text));
	};
	const close = () => {
		if (prompt) answer(undefined);
		setState({ login: undefined });
	};

	return (
		<div className="scrim" onKeyDown={(event) => event.key === "Escape" && close()}>
			<div className="modal" role="dialog" aria-modal="true" aria-labelledby="login-title" style={{ width: 480 }}>
				<div className="modal-head">
					<h2 id="login-title">{t("Connect {name}", { name: login.name })}</h2>
					<button type="button" className="icon-btn" aria-label={t("Close")} onClick={close}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				{infos.map((event, index) =>
					event.type === "device_code" ? (
						<div key={index} className="login-code">
							<span className="hint">{t("Enter this code at")}</span>{" "}
							<a href={event.url} target="_blank" rel="noreferrer">
								{event.url}
							</a>
							<div className="mono code">{event.code}</div>
						</div>
					) : event.type === "info" ? (
						<p key={index} className="set-sub">
							{event.message}
							{event.url && (
								<>
									{" "}
									<a href={event.url} target="_blank" rel="noreferrer">
										{t("Open the page again")}
									</a>
								</>
							)}
						</p>
					) : null,
				)}
				{prompt?.type === "select" && (
					<div className="options">
						<p className="ask-q" style={{ fontSize: 14 }}>
							{prompt.message}
						</p>
						{prompt.options.map((option, index) => (
							<button key={option.id} type="button" className="option" onClick={() => answer(option.id)}>
								<span className="num">{index + 1}</span>
								<span style={{ display: "flex", flexDirection: "column" }}>
									{option.label}
									{option.description && <span className="hint">{option.description}</span>}
								</span>
							</button>
						))}
					</div>
				)}
				{prompt && prompt.type !== "select" && (
					<label style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						<span className="ask-q" style={{ fontSize: 14 }}>
							{prompt.message}
						</span>
						<span className="ask-field">
							<input
								ref={input}
								type={prompt.type === "secret" ? "password" : "text"}
								autoComplete="off"
								spellCheck={false}
								value={value}
								placeholder={prompt.placeholder}
								onChange={(event) => setValue(event.target.value)}
								onKeyDown={(event) => event.key === "Enter" && value && answer(value)}
							/>
							<button type="button" className="btn primary" style={{ minHeight: 30 }} disabled={!value} onClick={() => answer(value)}>
								{t("Continue")}
							</button>
						</span>
					</label>
				)}
				{!prompt && !done && !infos.length && <p className="set-sub">{t("Starting…")}</p>}
				{done?.type === "done" &&
					(done.ok ? (
						<p className="set-sub" style={{ color: "var(--add)" }}>
							{t("Connected.")}
						</p>
					) : (
						<div className="run-error">{done.error ?? t("Login cancelled.")}</div>
					))}
				<div className="modal-foot">
					<button type="button" className="btn ghost" onClick={close}>
						{t(done ? "Close" : "Cancel")}
					</button>
				</div>
			</div>
		</div>
	);
}
