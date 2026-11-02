import { useEffect, useRef, useState } from "react";
import type { AppDetails, AppId, SkillInfo } from "../../shared/protocol.ts";
import { CloseIcon, TrashIcon } from "../icons.tsx";
import { commandKey } from "../platform.ts";
import { askConfirm, errorText, notify, trivium } from "../store.ts";
import { THEMES } from "../theme.ts";
import { t, tx } from "../i18n.tsx";

/** A name pi accepts, made from whatever the user typed: lowercase words joined by single hyphens. */
const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64);

/**
 * Writes a new skill into a mode's folder from a name, a description and instructions, or edits an existing
 * skill's SKILL.md as it is, frontmatter and all, so fields Trivium doesn't know about are kept.
 */
export function SkillDialog({
	app,
	skill,
	onClose,
	onSaved,
}: {
	app: AppId;
	/** The skill to edit; a new one in this mode's folder when unset. */
	skill?: SkillInfo;
	onClose: () => void;
	onSaved: (details: AppDetails) => void;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	/** The whole file of the skill being edited, once read. */
	const [text, setText] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string>();
	const first = useRef<HTMLInputElement>(null);
	const editor = useRef<HTMLTextAreaElement>(null);
	const mode = t(THEMES[app].name);

	useEffect(() => {
		if (!skill) {
			first.current?.focus();
			return;
		}
		trivium
			.readSkill(app, skill.path)
			.then((contents) => {
				setText(contents);
				requestAnimationFrame(() => {
					// Focus puts the caret at the end; the frontmatter at the top is what the user looks at first.
					editor.current?.focus();
					editor.current?.setSelectionRange(0, 0);
					if (editor.current) editor.current.scrollTop = 0;
				});
			})
			.catch((thrown: unknown) => setError(errorText(thrown)));
	}, [app, skill]);

	const save = async () => {
		if (saving || (skill && text === undefined)) return;
		setError(undefined);
		setSaving(true);
		try {
			if (skill) {
				onSaved(await trivium.saveSkill(app, skill.path, text!));
				notify(t("Saved {name}", { name: skill.name }), "info");
			} else {
				const draft = { name: name.replace(/-+$/, ""), description, body };
				onSaved(await trivium.createSkill(app, draft));
				notify(t("Added {name}", { name: draft.name }), "info");
			}
			onClose();
		} catch (thrown) {
			setError(errorText(thrown));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!skill) return;
		const ok = await askConfirm({
			title: t("Delete {name}?", { name: skill.name }),
			message: t("Its folder goes to the Trash, with any scripts or files next to its SKILL.md."),
			confirmLabel: t("Delete"),
		});
		if (!ok) return;
		try {
			onSaved(await trivium.deleteSkill(app, skill.path));
			notify(t("Deleted {name}", { name: skill.name }), "info");
			onClose();
		} catch (thrown) {
			setError(errorText(thrown));
		}
	};

	const shared = skill && skill.source !== "App";
	return (
		<div
			className="scrim"
			onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}
			onKeyDown={(event) => {
				if (event.key === "Escape" && !saving) onClose();
				if (event.key === "Enter" && commandKey(event)) void save();
			}}
		>
			<div className="modal cm" role="dialog" aria-modal="true" aria-labelledby="skill-title" style={{ width: 640 }}>
				<div className="modal-head">
					<h2 id="skill-title">{skill ? t("Edit {name}", { name: skill.name }) : t("New {mode} skill", { mode })}</h2>
					<button type="button" className="icon-btn" aria-label={t("Close")} disabled={saving} onClick={onClose}>
						<CloseIcon size={15} width={2} />
					</button>
				</div>
				<p className="add-ext-intro">
					{shared
						? t("Every mode and the pi CLI share this skill, so a change here applies to all of them.")
						: t("Only {mode} sessions load it. The agent reads the description to decide when to follow the instructions.", { mode })}
				</p>

				{skill ? (
					<label className="cm-field wide">
						<span className="mono s-path" title={skill.path}>
							{skill.display}
						</span>
						<textarea
							ref={editor}
							className="cm-input cm-textarea skill-editor"
							value={text ?? ""}
							disabled={text === undefined}
							placeholder={t("Loading…")}
							spellCheck={false}
							aria-label={t("Skill text")}
							onChange={(event) => setText(event.target.value)}
						/>
						<span className="cm-help">
							{tx("The frontmatter between the {dashes} lines needs a {description}.", {
								dashes: <span className="mono">---</span>,
								description: <span className="mono">description</span>,
							})}
						</span>
					</label>
				) : (
					<div className="cm-grid">
						<label className="cm-field wide">
							<span>{t("Name")}</span>
							<input
								ref={first}
								className="cm-input mono"
								value={name}
								placeholder="release-notes"
								spellCheck={false}
								onChange={(event) => setName(slug(event.target.value))}
							/>
							<span className="cm-help">
								{tx("Lowercase letters, digits and hyphens. Run it yourself with {command}.", {
									command: <span className="mono">/skill:{name.replace(/-+$/, "") || "name"}</span>,
								})}
							</span>
						</label>
						<label className="cm-field wide">
							<span>{t("Description")}</span>
							<input
								className="cm-input"
								value={description}
								placeholder={t("Drafts release notes from merged changes. Use when the user asks for a changelog or release notes.")}
								onChange={(event) => setDescription(event.target.value)}
							/>
							<span className="cm-help">{t("What it does and when to use it, in a sentence or two.")}</span>
						</label>
						<label className="cm-field wide">
							<span>{t("Instructions")}</span>
							<textarea
								className="cm-input cm-textarea skill-editor"
								value={body}
								placeholder={t("# Release notes\n\n1. List the changes since the last release.\n2. Group them by what users will notice.\n3. …")}
								spellCheck={false}
								onChange={(event) => setBody(event.target.value)}
							/>
							<span className="cm-help">
								{t("Markdown. Scripts or references can sit next to it in the skill's folder; mention them by relative path.")}
							</span>
						</label>
					</div>
				)}

				{error && <div className="run-error">{error}</div>}
				<div className="modal-foot" style={{ justifyContent: skill?.source === "App" ? "space-between" : "flex-end" }}>
					{skill?.source === "App" && (
						<button type="button" className="btn ghost cm-delete" disabled={saving} onClick={() => void remove()}>
							<TrashIcon size={14} />
							{t("Delete skill")}
						</button>
					)}
					<span className="btn-row">
						<button type="button" className="btn ghost" disabled={saving} onClick={onClose}>
							{t("Cancel")}
						</button>
						<button type="button" className="btn primary" disabled={saving || (skill && text === undefined)} onClick={() => void save()}>
							{t(saving ? "Saving…" : skill ? "Save" : "Create")}
						</button>
					</span>
				</div>
			</div>
		</div>
	);
}
