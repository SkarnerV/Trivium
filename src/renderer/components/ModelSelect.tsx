import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ModelOption } from "../../shared/protocol.ts";
import { useStore } from "../store.ts";
import { Dropdown, type DropdownOption, menuPlacement, OptionList } from "./Dropdown.tsx";

const EFFORT_LABELS: Record<string, string> = {
	off: "No thinking",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/** Shorter names for the composer's trigger, where they sit after the model name. */
const EFFORT_SHORT: Record<string, string> = {
	off: "Off",
	minimal: "Min",
	low: "Low",
	medium: "Med",
	high: "High",
	xhigh: "X-High",
	max: "Max",
};

const effortLabel = (level: string) => EFFORT_LABELS[level] ?? level;

function levelsOf(model: ModelOption | undefined): string[] {
	return model?.reasoning && model.thinkingLevels.length ? model.thinkingLevels : [];
}

/** The level to keep when switching models: the current one if the new model has it, else a sensible middle. */
function levelFor(model: ModelOption | undefined, current: string | undefined): string {
	const levels = levelsOf(model);
	if (!levels.length) return "off";
	if (current && levels.includes(current)) return current;
	return levels.includes("medium") ? "medium" : levels[levels.length - 1]!;
}

function modelOptions(models: ModelOption[], value: string | undefined, emptyLabel?: string): DropdownOption[] {
	const known = models.some((m) => m.key === value);
	return [
		...(emptyLabel !== undefined ? [{ value: "", label: emptyLabel }] : []),
		...(value && !known ? [{ value, label: `${value.split("/").pop()} (unavailable)` }] : []),
		...models.map((m) => ({ value: m.key, label: m.name, group: m.provider })),
	];
}

function ChevronIcon({ back = false }: { back?: boolean }) {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={back ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} />
		</svg>
	);
}

/**
 * Model and thinking effort as two separate dropdowns, for forms. The effort
 * dropdown only appears for models that can think.
 */
export function ModelSelect({
	value,
	level,
	emptyLabel,
	variant = "soft",
	align = "right",
	onChange,
}: {
	value?: string;
	level?: string;
	/** Offers a "no choice" entry with this label, such as "pi's default". */
	emptyLabel?: string;
	variant?: "ghost" | "soft";
	align?: "left" | "right";
	onChange: (key: string | undefined, level: string) => void;
}) {
	const models = useStore((s) => s.models);
	const model = models.find((m) => m.key === value);
	const levels = levelsOf(model);
	const effort = levels.includes(level ?? "") ? level! : levelFor(model, level);
	return (
		<div className="model-select">
			<Dropdown
				label="Model"
				value={value ?? ""}
				options={modelOptions(models, value, emptyLabel)}
				variant={variant}
				align={align}
				placeholder={emptyLabel ?? "Choose a model"}
				onChange={(key) => {
					const next = models.find((m) => m.key === key);
					onChange(key || undefined, levelFor(next, level));
				}}
			/>
			{levels.length > 0 && (
				<Dropdown
					label="Thinking effort"
					value={effort}
					options={levels.map((l) => ({ value: l, label: effortLabel(l) }))}
					variant={variant}
					align={align}
					onChange={(next) => onChange(value, next)}
				/>
			)}
		</div>
	);
}

/**
 * Model and thinking effort behind one compact trigger, for the composer. The
 * menu opens on an effort slider with the model underneath; the model name
 * leads to the model list. Models that cannot think open straight on the list.
 */
export function ModelMenu({
	value,
	level,
	onChange,
}: {
	value?: string;
	level?: string;
	onChange: (key: string, level: string) => void;
}) {
	const models = useStore((s) => s.models);
	const model = models.find((m) => m.key === value);
	const levels = levelsOf(model);
	const effort = levels.includes(level ?? "") ? level! : levelFor(model, level);
	const [open, setOpen] = useState(false);
	const [pane, setPane] = useState<"effort" | "models">("effort");
	const [placement, setPlacement] = useState<"up" | "down">("up");
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const slider = useRef<HTMLInputElement>(null);
	const name = model?.name ?? (value ? value.split("/").pop()! : "Choose a model");

	const show = () => {
		setPlacement(menuPlacement(trigger.current));
		setPane(levels.length ? "effort" : "models");
		setOpen(true);
	};

	const close = (refocus = true) => {
		setOpen(false);
		if (refocus) trigger.current?.focus();
	};

	const chooseModel = (key: string) => {
		const next = models.find((m) => m.key === key);
		if (key !== value) onChange(key, levelFor(next, level));
		if (levelsOf(next).length) setPane("effort");
		else close();
	};

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) close(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	useEffect(() => {
		if (open && pane === "effort") slider.current?.focus();
	}, [open, pane]);

	const index = Math.max(0, levels.indexOf(effort));
	const last = levels.length - 1;
	return (
		<div ref={root} className={`dd dd-ghost model-menu${open ? " open" : ""}`}>
			<button
				ref={trigger}
				type="button"
				className="dd-trigger"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`Model: ${name}${levels.length ? `, thinking: ${effortLabel(effort)}` : ""}`}
				title="Model and thinking effort"
				onClick={() => (open ? close() : show())}
			>
				<span className="dd-value">{name}</span>
				{/* Every level's name is stacked in one cell, so the button (and the menu centred on it) keeps its width while the slider moves. */}
				{levels.length > 0 && (
					<span className="mm-effort">
						{levels.map((l) => (
							<span key={l} className={l === effort ? undefined : "hidden"} aria-hidden={l !== effort}>
								{EFFORT_SHORT[l] ?? effortLabel(l)}
							</span>
						))}
					</span>
				)}
			</button>
			{open && (
				<div
					className={`dd-menu mm-menu ${placement}`}
					role="dialog"
					aria-label="Model and thinking effort"
					onKeyDown={(event) => {
						if (event.key !== "Escape" || pane !== "effort") return;
						event.preventDefault();
						close();
					}}
				>
					{pane === "effort" ? (
						<div className="mm-effort-pane">
							<div className="mm-level">{effortLabel(effort)}</div>
							<button type="button" className="mm-model" title="Change model" onClick={() => setPane("models")}>
								{name}
								<ChevronIcon />
							</button>
							<div className="mm-scale" style={{ "--mm-fill": last ? index / last : 0 } as CSSProperties}>
								<div className="mm-ticks" aria-hidden="true">
									{levels.map((l, i) => (
										<span key={l} className={i <= index ? "on" : ""} />
									))}
								</div>
								<input
									ref={slider}
									type="range"
									min={0}
									max={last}
									step={1}
									value={index}
									aria-label="Thinking effort"
									aria-valuetext={effortLabel(effort)}
									onChange={(event) => onChange(value!, levels[Number(event.target.value)]!)}
								/>
							</div>
							<div className="mm-ends" aria-hidden="true">
								<span>{effortLabel(levels[0]!)}</span>
								<span>{effortLabel(levels[last]!)}</span>
							</div>
						</div>
					) : (
						<>
							{levels.length > 0 && (
								<button type="button" className="mm-back" onClick={() => setPane("effort")}>
									<ChevronIcon back />
									Thinking effort
								</button>
							)}
							<OptionList
								value={value ?? ""}
								options={modelOptions(models, value)}
								label="Model"
								onChoose={(option) => chooseModel(option.value)}
								onClose={(refocus) => (levels.length && refocus ? setPane("effort") : close(refocus))}
							/>
						</>
					)}
				</div>
			)}
		</div>
	);
}
