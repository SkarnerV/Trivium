import { APP_IDS, type AppId, type SessionUsage, type UsageBucket, type UsageReport } from "./protocol.ts";

/** How far back the Usage page counts, in days, or everything. */
export type UsageRange = "7" | "30" | "all";

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date of a time, as YYYY-MM-DD. */
export const dayOf = (time: number | Date): string => {
	const d = new Date(time);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const parts = (day: string) => day.split("-").map(Number) as [number, number, number];

/** The day `days` after `day`, or before when negative. */
export function addDays(day: string, days: number): string {
	const [y, m, d] = parts(day);
	return dayOf(new Date(y, m - 1, d + days));
}

/** Whole days from `from` to `to`; counted in UTC so a clock change doesn't make a day short. */
export function daysBetween(from: string, to: string): number {
	const utc = (day: string) => {
		const [y, m, d] = parts(day);
		return Date.UTC(y, m - 1, d);
	};
	return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export interface Tally {
	responses: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	firstTokenMs: number;
	firstTokens: number;
	streamMs: number;
	streamed: number;
}

const empty = (): Tally => ({
	responses: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	firstTokenMs: 0,
	firstTokens: 0,
	streamMs: 0,
	streamed: 0,
});

function add(tally: Tally, bucket: UsageBucket | Tally): void {
	tally.responses += bucket.responses;
	tally.input += bucket.input;
	tally.output += bucket.output;
	tally.cacheRead += bucket.cacheRead;
	tally.cacheWrite += bucket.cacheWrite;
	tally.cost += bucket.cost;
	tally.firstTokenMs += bucket.firstTokenMs;
	tally.firstTokens += bucket.firstTokens;
	tally.streamMs += bucket.streamMs;
	tally.streamed += bucket.streamed;
}

/** Every token a tally counts, as pi's totalTokens does. */
export const tokensOf = (tally: Tally): number => tally.input + tally.output + tally.cacheRead + tally.cacheWrite;

/** The share of input read from the provider's cache, or undefined when nothing was sent. */
export function cacheShare(tally: Tally): number | undefined {
	const sent = tally.input + tally.cacheRead + tally.cacheWrite;
	return sent ? tally.cacheRead / sent : undefined;
}

/** The average milliseconds to the first token, or undefined when no reply was timed. */
export const firstTokenOf = (tally: Tally): number | undefined => (tally.firstTokens ? tally.firstTokenMs / tally.firstTokens : undefined);

/** Output tokens a second while writing, or undefined when no reply was timed. */
export const speedOf = (tally: Tally): number | undefined => (tally.streamMs ? (tally.streamed * 1000) / tally.streamMs : undefined);

export interface UsageBar {
	from: string;
	to: string;
	tally: Tally;
}

export interface UsageSummary {
	/** The first day counted; the last is today. */
	from: string;
	total: Tally;
	sessions: number;
	/** The same stretch of days just before, to compare with; absent for all time. */
	previous?: Tally;
	/** One bar a day, or a week when the range is longer than 90 days. */
	bars: UsageBar[];
	/** Every app, in sidebar order, used or not. */
	apps: { app: AppId; tally: Tally }[];
	/** Most tokens first. */
	models: { provider: string; model: string; tally: Tally }[];
	/** The five sessions that used the most, with the last day each was used. */
	top: { session: SessionUsage; last: string; tally: Tally }[];
}

const byTokens = (a: { tally: Tally }, b: { tally: Tally }) => tokensOf(b.tally) - tokensOf(a.tally);

export interface CalendarDay {
	day: string;
	tally: Tally;
	/** 0 for no replies, then 1 to 4 from the quietest busy day to the busiest. */
	level: 0 | 1 | 2 | 3 | 4;
}

export interface UsageCalendar {
	/** Columns of seven days, Sunday first, ending with this week; days after today are left out. */
	weeks: (CalendarDay | undefined)[][];
	/** Days with at least one reply. */
	active: number;
	/** Days in a row with replies, up to today, or up to yesterday when today has none yet. */
	streak: number;
}

/** A year of days for a contribution-style calendar. */
export function calendar(report: UsageReport, weeks = 53): UsageCalendar {
	const { today } = report;
	const [y, m, d] = parts(today);
	const start = addDays(today, -new Date(y, m - 1, d).getDay() - (weeks - 1) * 7);
	const totals = new Map<string, Tally>();
	for (const session of report.sessions) {
		for (const bucket of session.buckets) {
			if (bucket.day < start || bucket.day > today) continue;
			const tally = totals.get(bucket.day) ?? empty();
			add(tally, bucket);
			totals.set(bucket.day, tally);
		}
	}
	const busy = [...totals.values()].map(tokensOf).filter(Boolean).sort((a, b) => a - b);
	// By rank among the busy days, so the busiest is always darkest and one huge day doesn't wash out the rest.
	const levelOf = (tokens: number): CalendarDay["level"] => {
		if (!tokens) return 0;
		if (busy.length === 1) return 4;
		return (1 + Math.floor((3 * busy.indexOf(tokens)) / (busy.length - 1))) as CalendarDay["level"];
	};
	const columns: UsageCalendar["weeks"] = [];
	for (let week = 0; week < weeks; week++) {
		const column: (CalendarDay | undefined)[] = [];
		for (let weekday = 0; weekday < 7; weekday++) {
			const day = addDays(start, week * 7 + weekday);
			const tally = totals.get(day) ?? empty();
			column.push(day > today ? undefined : { day, tally, level: levelOf(tokensOf(tally)) });
		}
		columns.push(column);
	}
	let streak = 0;
	let day = totals.has(today) ? today : addDays(today, -1);
	while (totals.has(day)) {
		streak++;
		day = addDays(day, -1);
	}
	return { weeks: columns, active: busy.length, streak };
}

export function summarize(report: UsageReport, range: UsageRange): UsageSummary {
	const { today } = report;
	const days = report.sessions.flatMap((session) => session.buckets.map((bucket) => bucket.day));
	const earliest = days.reduce((min, day) => (day < min ? day : min), today);
	const from = range === "all" ? earliest : addDays(today, 1 - Number(range));
	const span = daysBetween(from, today) + 1;
	const step = span > 90 ? 7 : 1;
	const bars: UsageBar[] = [];
	for (let start = 0; start < span; start += step) {
		bars.push({ from: addDays(from, start), to: addDays(from, Math.min(start + step, span) - 1), tally: empty() });
	}
	const before = range === "all" ? undefined : addDays(from, -span);
	const previous = before ? empty() : undefined;
	const total = empty();
	const apps = new Map<AppId, Tally>(APP_IDS.map((app) => [app, empty()]));
	const models = new Map<string, { provider: string; model: string; tally: Tally }>();
	const sessions: UsageSummary["top"] = [];
	for (const session of report.sessions) {
		const tally = empty();
		let last = "";
		for (const bucket of session.buckets) {
			if (bucket.day > today) continue;
			if (bucket.day < from) {
				if (previous && before && bucket.day >= before) add(previous, bucket);
				continue;
			}
			add(tally, bucket);
			add(bars[Math.floor(daysBetween(from, bucket.day) / step)].tally, bucket);
			const key = `${bucket.provider}/${bucket.model}`;
			const model = models.get(key) ?? { provider: bucket.provider, model: bucket.model, tally: empty() };
			add(model.tally, bucket);
			models.set(key, model);
			if (bucket.day > last) last = bucket.day;
		}
		if (!tally.responses) continue;
		add(total, tally);
		add(apps.get(session.app) ?? apps.get("code")!, tally);
		sessions.push({ session, last, tally });
	}
	return {
		from,
		total,
		sessions: sessions.length,
		previous,
		bars,
		apps: [...apps].map(([app, tally]) => ({ app, tally })),
		models: [...models.values()].sort(byTokens),
		top: sessions.sort(byTokens).slice(0, 5),
	};
}
