import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
	label: string;
	icon?: ReactNode;
	/** Short text on the right, such as a shortened id. */
	hint?: string;
	danger?: boolean;
	disabled?: boolean;
	/** Says why the item is disabled. */
	title?: string;
	onSelect: () => void;
}

export type MenuEntry = MenuItem | "separator";

const EDGE = 8;

/**
 * A right-click menu at a point on screen. It stays inside the window, closes on a click elsewhere, Escape,
 * scrolling or leaving the window, and works with the keyboard (arrows, Home, End, Enter).
 */
export function ContextMenu({ x, y, entries, label, onClose }: { x: number; y: number; entries: MenuEntry[]; label: string; onClose: () => void }) {
	const root = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: x, top: y });
	const items = entries.filter((entry): entry is MenuItem => entry !== "separator");
	const enabled = items.filter((item) => !item.disabled);
	const [active, setActive] = useState(0);

	useLayoutEffect(() => {
		const rect = root.current?.getBoundingClientRect();
		if (!rect) return;
		setPosition({
			left: Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)),
			top: Math.max(EDGE, y + rect.height > window.innerHeight - EDGE ? y - rect.height : y),
		});
		root.current?.focus();
	}, [x, y]);

	useEffect(() => {
		const outside = (event: Event) => {
			if (!root.current?.contains(event.target as Node)) onClose();
		};
		const close = () => onClose();
		window.addEventListener("mousedown", outside, true);
		window.addEventListener("contextmenu", outside, true);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		window.addEventListener("blur", close);
		return () => {
			window.removeEventListener("mousedown", outside, true);
			window.removeEventListener("contextmenu", outside, true);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
			window.removeEventListener("blur", close);
		};
	}, [onClose]);

	const choose = (item: MenuItem | undefined) => {
		if (!item || item.disabled) return;
		onClose();
		item.onSelect();
	};

	const onKeyDown = (event: KeyboardEvent) => {
		const moves: Record<string, (index: number) => number> = {
			ArrowDown: (index) => (index + 1) % enabled.length,
			ArrowUp: (index) => (index - 1 + enabled.length) % enabled.length,
			Home: () => 0,
			End: () => enabled.length - 1,
		};
		if (event.key in moves) setActive(moves[event.key]!(active));
		else if (event.key === "Enter" || event.key === " ") choose(enabled[active]);
		else if (event.key === "Escape" || event.key === "Tab") onClose();
		else return;
		event.preventDefault();
		event.stopPropagation();
	};

	return createPortal(
		<div
			ref={root}
			className="cm-menu"
			role="menu"
			aria-label={label}
			tabIndex={-1}
			style={position}
			onKeyDown={onKeyDown}
			onContextMenu={(event) => event.preventDefault()}
		>
			{entries.map((entry, index) =>
				entry === "separator" ? (
					<div key={`sep-${index}`} className="cm-sep" role="separator" />
				) : (
					<button
						key={entry.label}
						type="button"
						role="menuitem"
						className={`cm-item${entry.danger ? " danger" : ""}${enabled[active] === entry ? " active" : ""}`}
						disabled={entry.disabled}
						title={entry.title}
						onMouseEnter={() => !entry.disabled && setActive(enabled.indexOf(entry))}
						onClick={() => choose(entry)}
					>
						<span className="cm-icon">{entry.icon}</span>
						<span className="cm-label">{entry.label}</span>
						{entry.hint && <span className="cm-hint">{entry.hint}</span>}
					</button>
				),
			)}
		</div>,
		// Inside the shell, which carries the app's colors; fixed positioning still places it over everything.
		document.querySelector(".shell") ?? document.body,
	);
}
