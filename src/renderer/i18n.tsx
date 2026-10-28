import { Fragment, type ReactNode } from "react";
import { t } from "../shared/i18n.ts";

export { getLocale, t } from "../shared/i18n.ts";

/** Like t(), for text with elements in it: `{name}` is replaced with `parts.name`, wherever the translation puts it. */
export function tx(text: string, parts: Record<string, ReactNode>): ReactNode {
	return t(text)
		.split(/(\{\w+\})/)
		.map((piece, index) => {
			const name = /^\{(\w+)\}$/.exec(piece)?.[1];
			return <Fragment key={index}>{name && name in parts ? parts[name] : piece}</Fragment>;
		});
}
