import type { AppId } from "../shared/protocol.ts";

export interface AppTheme {
	name: string;
	/** Window chrome around the white card. */
	chrome: string;
	/** Switcher track, rail button and progress track. */
	tab: string;
	border: string;
	muted: string;
	secondary: string;
	accent: string;
	/** Text on light accent backgrounds. */
	accentText: string;
	/** Light accent fill: user bubbles, selected rows, inline code. */
	soft: string;
	/** Hairline around the card and the composer. */
	edge: string;
	/** Separators inside the card. */
	line: string;
	/** Tray and side panel background. */
	tray: string;
	ringTrack: string;
	dot: string;
}

export const THEMES: Record<AppId, AppTheme> = {
	code: {
		name: "Code",
		chrome: "#EEEFFA",
		tab: "#E2E3F6",
		border: "#D9DBF0",
		muted: "#5C6091",
		secondary: "#34374F",
		accent: "#5457E8",
		accentText: "#3B3EC4",
		soft: "#EEEFFC",
		edge: "#DEDFF3",
		line: "#E8E9F8",
		tray: "#F7F7FE",
		ringTrack: "#E6E7F7",
		dot: "#8F92FF",
	},
	research: {
		name: "Research",
		chrome: "#EAF4F1",
		tab: "#DBEBE7",
		border: "#CFE3DE",
		muted: "#4A6A64",
		secondary: "#2D403C",
		accent: "#0B7A6E",
		accentText: "#075E55",
		soft: "#E4F2EF",
		edge: "#D3E6E1",
		line: "#E2EFEC",
		tray: "#F4FAF8",
		ringTrack: "#DCEDE9",
		dot: "#4FB3A6",
	},
	write: {
		name: "Write",
		chrome: "#F6F0E6",
		tab: "#ECE2D2",
		border: "#E2D5C1",
		muted: "#735F48",
		secondary: "#43382B",
		accent: "#A65A08",
		accentText: "#844705",
		soft: "#FAF0E3",
		edge: "#E6DACA",
		line: "#F0E7DA",
		tray: "#FBF7F1",
		ringTrack: "#ECE2D2",
		dot: "#D9964A",
	},
};

/** For pages that are not about one mode. */
export const NEUTRAL: AppTheme = {
	name: "Settings",
	chrome: "#F1F1F3",
	tab: "#E6E6EA",
	border: "#DCDCE1",
	muted: "#5E616B",
	secondary: "#34363D",
	accent: "#16171B",
	accentText: "#16171B",
	soft: "#F2F2F5",
	edge: "#E4E4E9",
	line: "#F0F0F3",
	tray: "#F7F7F9",
	ringTrack: "#E6E6EA",
	dot: "#8B8D97",
};

/** Each Settings page that isn't about one mode has its own color, on the neutral theme. */
export const SECTION_COLORS: Record<string, { accent: string; accentText: string }> = {
	general: { accent: "#2563EB", accentText: "#1D4ED8" },
	models: { accent: "#0891B2", accentText: "#0E7490" },
	usage: { accent: "#7C3AED", accentText: "#6D28D9" },
	shortcuts: { accent: "#EA580C", accentText: "#C2410C" },
	about: { accent: "#475569", accentText: "#334155" },
};

/** Each Memory page has its own color too. */
export const MEMORY_COLORS: Record<"global" | "project" | "daily" | "deleted", { accent: string; accentText: string }> = {
	global: { accent: "#DB2777", accentText: "#BE185D" },
	project: { accent: "#16A34A", accentText: "#15803D" },
	daily: { accent: "#D97706", accentText: "#B45309" },
	deleted: { accent: "#DC2626", accentText: "#B91C1C" },
};

export function sectionTheme(section: string): AppTheme {
	return { ...NEUTRAL, ...SECTION_COLORS[section] };
}

export function themeVars(app: AppId | AppTheme): Record<string, string> {
	const theme = typeof app === "string" ? THEMES[app] : app;
	return {
		"--chrome": theme.chrome,
		"--tab": theme.tab,
		"--border": theme.border,
		"--muted": theme.muted,
		"--secondary": theme.secondary,
		"--accent": theme.accent,
		"--accent-text": theme.accentText,
		"--accent-ring": `${theme.accent}2E`,
		"--soft": theme.soft,
		"--edge": theme.edge,
		"--line": theme.line,
		"--tray": theme.tray,
		"--ring-track": theme.ringTrack,
		"--dot": theme.dot,
	};
}
