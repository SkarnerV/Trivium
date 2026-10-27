import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface DropdownOption {
	value: string;
	label: string;
	/** Short text on the right of the row, such as a provider. */
	hint?: string;
	/** Rows with the same group are listed under that heading. */
	group?: string;
}

const MENU_GAP = 6;
const MENU_MAX = 320;

function CheckIcon() {
	return (
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="m5 12 5 5 9-10" />
		</svg>
	);
}

function CaretIcon() {
	return (
		<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

/** Opens a menu above its trigger when there is not enough room below it. */
export function menuPlacement(trigger: HTMLElement | null): "up" | "down" {
	const rect = trigger?.getBoundingClientRect();
	if (!rect) return "down";
	const below = window.innerHeight - rect.bottom;
	return below < MENU_MAX + MENU_GAP && rect.top > below ? "up" : "down";
}

/**
 * The searchable, keyboard-driven list inside a dropdown menu. Takes focus when
 * it mounts; arrows, Home and End move, Enter picks, Escape and Tab call onClose.
 */
export function OptionList({
	value,
	options,
	label,
	onChoose,
	onClose,
	searchThreshold = 9,
}: {
	value: string;
	options: DropdownOption[];
	label: string;
	onChoose: (option: DropdownOption) => void;
	/** refocus is false when Tab moves focus on by itself. */
	onClose: (refocus: boolean) => void;
	searchThreshold?: number;
}) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
	const list = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const id = useId();
	const searchable = options.length >= searchThreshold;

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return options;
		return options.filter((option) =>
			[option.label, option.hint, option.group].some((text) => text?.toLowerCase().includes(q)),
		);
	}, [options, query]);

	useEffect(() => {
		(searchable ? search.current : list.current)?.focus();
	}, [searchable]);

	// Keep the highlighted row in view while moving with the keyboard.
	useLayoutEffect(() => {
		list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const onKey = (event: KeyboardEvent) => {
		const last = visible.length - 1;
		if (event.key === "ArrowDown") setActive((index) => Math.min(last, index + 1));
		else if (event.key === "ArrowUp") setActive((index) => Math.max(0, index - 1));
		else if (event.key === "Home") setActive(0);
		else if (event.key === "End") setActive(last);
		else if (event.key === "Enter") visible[active] && onChoose(visible[active]);
		else if (event.key === "Escape") onClose(true);
		else if (event.key === "Tab") onClose(false);
		else return;
		event.preventDefault();
		event.stopPropagation();
	};

	let lastGroup: string | undefined;
	return (
		<div className="dd-options" onKeyDown={onKey}>
			{searchable && (
				<input
					ref={search}
					className="dd-search"
					placeholder="Search…"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					aria-controls={id}
					aria-activedescendant={visible[active] ? `${id}-${active}` : undefined}
				/>
			)}
			<div ref={list} id={id} role="listbox" aria-label={label} tabIndex={-1} className="dd-list" aria-activedescendant={visible[active] ? `${id}-${active}` : undefined}>
				{visible.map((option, index) => {
					const heading = option.group && option.group !== lastGroup ? option.group : undefined;
					lastGroup = option.group;
					const isSelected = option.value === value;
					return (
						<div key={option.value} role="presentation">
							{heading && <div className="dd-group">{heading}</div>}
							<div
								id={`${id}-${index}`}
								data-index={index}
								role="option"
								aria-selected={isSelected}
								className={`dd-option${index === active ? " active" : ""}`}
								onMouseMove={() => index !== active && setActive(index)}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => onChoose(option)}
							>
								<span className="dd-check">{isSelected && <CheckIcon />}</span>
								<span className="dd-label">{option.label}</span>
								{option.hint && <span className="dd-hint">{option.hint}</span>}
							</div>
						</div>
					);
				})}
				{!visible.length && <div className="dd-empty">Nothing matches</div>}
			</div>
		</div>
	);
}

/**
 * A select replacement: a button that opens a list of options. Opens upward when
 * there is no room below, filters with a search box when the list is long, and
 * works with the keyboard (arrows, Enter, Escape, Home, End).
 */
export function Dropdown({
	value,
	options,
	onChange,
	label,
	variant = "soft",
	align = "left",
	placeholder = "Choose…",
	searchThreshold = 9,
	icon,
}: {
	value: string;
	options: DropdownOption[];
	onChange: (value: string) => void;
	/** Accessible name, also shown as the trigger's tooltip. */
	label: string;
	/** "ghost" is transparent until hovered, for the composer; "soft" is a filled control for forms. */
	variant?: "ghost" | "soft";
	align?: "left" | "right";
	placeholder?: string;
	/** Show a search box when there are at least this many options. */
	searchThreshold?: number;
	icon?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<"up" | "down">("down");
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const selected = options.find((option) => option.value === value);

	const show = () => {
		setPlacement(menuPlacement(trigger.current));
		setOpen(true);
	};

	const close = (refocus = true) => {
		setOpen(false);
		if (refocus) trigger.current?.focus();
	};

	const choose = (option: DropdownOption) => {
		close();
		if (option.value !== value) onChange(option.value);
	};

	// Close on a click anywhere else.
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) close(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	return (
		<div ref={root} className={`dd dd-${variant}${open ? " open" : ""}`}>
			<button
				ref={trigger}
				type="button"
				className="dd-trigger"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`${label}: ${selected?.label ?? placeholder}`}
				title={label}
				onClick={() => (open ? close() : show())}
				onKeyDown={(event) => {
					if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
						event.preventDefault();
						show();
					}
				}}
			>
				{icon}
				<span className="dd-value">{selected?.label ?? placeholder}</span>
				<CaretIcon />
			</button>
			{open && (
				<div className={`dd-menu ${placement} ${align}`}>
					<OptionList value={value} options={options} label={label} searchThreshold={searchThreshold} onChoose={choose} onClose={close} />
				</div>
			)}
		</div>
	);
}
