import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n.tsx";

/**
 * Text cut to a few lines, with "Show all" when there is more. Whether there is more is measured, not guessed from
 * the length, since the panel's width and the language decide where lines break. Long plans and tasks stay one
 * glance tall until the user asks for the rest.
 */
export function Clamp({ lines, className = "", children }: { lines: number; className?: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = body.current;
		if (!element || open) return;
		const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [open, children]);
	return (
		<div className={`clamp-wrap ${className}`}>
			<div ref={body} className={open ? "clamp-body" : "clamp-body clamped"} style={{ ["--clamp-lines" as string]: lines }}>
				{children}
			</div>
			{(overflows || open) && (
				<button type="button" className="clamp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
					{t(open ? "Show less" : "Show all")}
				</button>
			)}
		</div>
	);
}
