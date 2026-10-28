import ja from "./locales/ja.ts";
import zhCN from "./locales/zh-CN.ts";

export const LOCALES = ["en", "zh-CN", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
/** What the user picked in Settings; "system" follows the operating system's language when Trivium has it. */
export type Language = Locale | "system";

/** Each language in its own words, as the language menu lists it. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文", ja: "日本語" };

/** Translations keyed by the English text the code passes to t(); English has none of its own. */
export const TABLES: Record<Exclude<Locale, "en">, Record<string, string>> = { "zh-CN": zhCN, ja };

/** The language to show, from the setting and the system's preferred languages, most preferred first. */
export function resolveLocale(language: Language | undefined, preferred: readonly string[]): Locale {
	if (language && language !== "system") return language;
	for (const tag of preferred) {
		const lower = tag.toLowerCase();
		if (lower.startsWith("en")) return "en";
		// Traditional Chinese readers get Simplified, which is closer for them than English.
		if (lower.startsWith("zh")) return "zh-CN";
		if (lower.startsWith("ja")) return "ja";
	}
	return "en";
}

let current: Locale = "en";

export function setLocale(locale: Locale): void {
	current = locale;
}

export function getLocale(): Locale {
	return current;
}

/** Sentences as one text: English puts a space between them, Chinese and Japanese don't. */
export function sentences(...parts: (string | false | undefined)[]): string {
	return parts.filter(Boolean).join(current === "en" ? " " : "");
}

/**
 * English text in the current language. `{name}` in the text is replaced with `vars.name`, in every language, so a
 * translation can put it where its grammar needs. Text with no translation shows in English.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
	const translated = current === "en" ? text : (TABLES[current][text] ?? text);
	if (!vars) return translated;
	return translated.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
