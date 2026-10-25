import type { ModelOption } from "../../shared/protocol.ts";
import { useStore } from "../store.ts";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";

const EFFORT_LABELS: Record<string, string> = {
	off: "No thinking",
	minimal: "Minimal effort",
	low: "Low effort",
	medium: "Medium effort",
	high: "High effort",
	xhigh: "Extra high effort",
};

const effortLabel = (level: string) => EFFORT_LABELS[level] ?? `${level} effort`;

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

/**
 * Model and thinking effort as two separate dropdowns. The effort dropdown only
 * appears for models that can think.
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
	const options: DropdownOption[] = [
		...(emptyLabel !== undefined ? [{ value: "", label: emptyLabel }] : []),
		...(value && !model ? [{ value, label: `${value.split("/").pop()} (unavailable)` }] : []),
		...models.map((m) => ({ value: m.key, label: m.name, group: m.provider })),
	];
	const levels = levelsOf(model);
	const effort = levels.includes(level ?? "") ? level! : levelFor(model, level);
	return (
		<div className="model-select">
			<Dropdown
				label="Model"
				value={value ?? ""}
				options={options}
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
