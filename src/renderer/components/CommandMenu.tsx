import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompletionItem, SlashCommand } from "../../shared/protocol.ts";
import { trivium } from "../store.ts";

/** One row of the menu: a command, or a suggested argument for one. */
interface MenuItem {
	key: string;
	label: string;
	hint?: string;
	description?: string;
	tag?: string;
	/** The message box text after choosing this row. */
	insert: string;
	/** The text already names this command in full, so Enter sends instead of completing. */
	exact: boolean;
}

const TAGS: Record<SlashCommand["source"], string> = {
	trivium: "Trivium",
	extension: "Extension",
	prompt: "Prompt",
	skill: "Skill",
};

/** Splits "/name rest" into the command name and, once a space was typed, its argument text. */
function parse(text: string): { name: string; args?: string } | undefined {
	const match = /^\/([^\s/]*)(?:\s([^\n]*))?$/.exec(text);
	return match ? { name: match[1]!, args: match[2] } : undefined;
}

function rank(command: SlashCommand, query: string): number {
	const name = command.name.toLowerCase();
	if (!query) return 1;
	if (name.startsWith(query)) return 0;
	if (name.includes(query)) return 1;
	if (command.description?.toLowerCase().includes(query)) return 2;
	return -1;
}

/**
 * Suggestions for the message box while it starts with "/": matching commands while the name is
 * typed, then the command's own argument suggestions once a space follows it.
 */
export function useCommandMenu(path: string, text: string, setText: (text: string) => void) {
	const [commands, setCommands] = useState<SlashCommand[]>([]);
	const [completions, setCompletions] = useState<CompletionItem[]>([]);
	const [active, setActive] = useState(0);
	const [dismissedFor, setDismissedFor] = useState<string>();
	const parsed = parse(text);
	const slashMode = parsed !== undefined;

	// Load the list when "/" is typed, so commands from extensions that just loaded show up.
	useEffect(() => {
		if (text !== "/") return;
		let current = true;
		void trivium
			.commands(path)
			.then((list) => current && setCommands(list))
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [text === "/", path]);

	useEffect(() => {
		if (!slashMode && dismissedFor) setDismissedFor(undefined);
	}, [slashMode, dismissedFor]);

	const command = parsed ? commands.find((c) => c.name === parsed.name) : undefined;
	const wantsArgs = parsed?.args !== undefined && Boolean(command?.completes);

	useEffect(() => {
		if (!wantsArgs || !parsed) {
			setCompletions([]);
			return;
		}
		let current = true;
		const timer = setTimeout(() => {
			void trivium
				.completeCommand(path, parsed.name, parsed.args ?? "")
				.then((items) => current && setCompletions(items))
				.catch(() => {});
		}, 100);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [wantsArgs, parsed?.name, parsed?.args, path]);

	const items: MenuItem[] = useMemo(() => {
		if (!parsed) return [];
		if (parsed.args === undefined) {
			const query = parsed.name.toLowerCase();
			return commands
				.map((c) => ({ c, score: rank(c, query) }))
				.filter((entry) => entry.score >= 0)
				.sort((a, b) => a.score - b.score)
				.slice(0, 40)
				.map(({ c }) => ({
					key: c.name,
					label: `/${c.name}`,
					hint: c.argumentHint,
					description: c.description,
					tag: TAGS[c.source],
					insert: `/${c.name} `,
					exact: c.name === parsed.name,
				}));
		}
		return completions.map((item) => ({
			key: item.value,
			label: item.label,
			description: item.description,
			insert: `/${parsed.name} ${item.value}`,
			exact: false,
		}));
	}, [parsed?.name, parsed?.args, commands, completions]);

	useEffect(() => setActive(0), [items.length, parsed?.name, parsed?.args === undefined]);

	const open = slashMode && items.length > 0 && dismissedFor !== text;

	const choose = (item: MenuItem | undefined) => {
		if (item) setText(item.insert);
	};

	/** Handles a key in the message box. Returns true when the menu used it. */
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!open) return false;
		const item = items[active];
		if (event.key === "ArrowDown") setActive((index) => (index + 1) % items.length);
		else if (event.key === "ArrowUp") setActive((index) => (index - 1 + items.length) % items.length);
		else if (event.key === "Tab") choose(item);
		else if (event.key === "Enter" && !event.shiftKey && !event.altKey && !item?.exact) choose(item);
		else if (event.key === "Escape") setDismissedFor(text);
		else return false;
		event.preventDefault();
		return true;
	};

	return { open, items, active, setActive, choose, onKeyDown, argsMode: parsed?.args !== undefined };
}

export function CommandMenu({
	items,
	active,
	argsMode,
	onHover,
	onChoose,
}: {
	items: MenuItem[];
	active: number;
	argsMode: boolean;
	onHover: (index: number) => void;
	onChoose: (item: MenuItem) => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);
	return (
		<div className="cmd-menu" role="listbox" aria-label={argsMode ? "Suggestions" : "Commands"}>
			<div className="cmd-head">
				<span>{argsMode ? "Suggestions" : "Commands"}</span>
			</div>
			<div className="cmd-list" ref={list}>
				{items.map((item, index) => (
					<div
						key={item.key}
						data-index={index}
						role="option"
						aria-selected={index === active}
						className={`cmd-item${index === active ? " active" : ""}`}
						onMouseMove={() => index !== active && onHover(index)}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onChoose(item)}
					>
						<span className="cmd-name mono">{item.label}</span>
						{item.hint && (
							<span className="cmd-hint mono" title={item.hint}>
								{item.hint}
							</span>
						)}
						<span className="cmd-desc">{item.description}</span>
						{item.tag && <span className="cmd-tag">{item.tag}</span>}
					</div>
				))}
			</div>
		</div>
	);
}
