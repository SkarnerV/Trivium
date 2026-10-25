import type { ModelOption } from "../../shared/protocol.ts";
import { useStore } from "../store.ts";

function levelsOf(model: ModelOption): string[] {
	return model.reasoning && model.thinkingLevels.length ? model.thinkingLevels : ["off"];
}

function label(model: ModelOption, level: string): string {
	return level === "off" && !model.reasoning ? model.name : `${model.name} · ${level}`;
}

/** One select for model and thinking level, as "provider/id|level". */
export function ModelSelect({
	value,
	level,
	emptyLabel,
	onChange,
}: {
	value?: string;
	level?: string;
	/** Shown for no choice; the empty option is offered only when this is set. */
	emptyLabel?: string;
	onChange: (key: string | undefined, level: string) => void;
}) {
	const models = useStore((s) => s.models);
	const current = value ? `${value}|${level ?? "off"}` : "";
	const known = !value || models.some((model) => model.key === value);
	return (
		<select
			className="soft-select"
			value={current}
			onChange={(event) => {
				const [key, nextLevel] = event.target.value.split("|") as [string, string | undefined];
				onChange(key || undefined, nextLevel ?? "off");
			}}
		>
			{emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
			{!known && <option value={current}>{`${value?.split("/").pop()} · ${level ?? "off"} (unavailable)`}</option>}
			{models.map((model) => (
				<optgroup key={model.key} label={`${model.name} (${model.provider})`}>
					{levelsOf(model).map((option) => (
						<option key={option} value={`${model.key}|${option}`}>
							{label(model, option)}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}
