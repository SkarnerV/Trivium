import { getLocale, t } from "../shared/i18n.ts";

export function duration(ms: number | undefined): string {
	if (ms === undefined || ms < 0) return "";
	if (ms < 100) return "<0.1s";
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
	const minutes = Math.floor((now - timestamp) / 60_000);
	if (minutes < 1) return t("now");
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const date = new Date(timestamp);
	const days = Math.floor(hours / 24);
	if (days < 2) return t("Yesterday");
	if (days < 7) return date.toLocaleDateString(getLocale(), { weekday: "short" });
	return date.toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

export function tokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 100_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function baseName(path: string): string {
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export function shortPath(path: string): string {
	const home = /^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(path)?.[1];
	return home ? `~${path.slice(home.length)}` : path;
}

export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}
