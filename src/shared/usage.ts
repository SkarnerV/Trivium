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
}

const empty = (): Tally => ({ responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

function add(tally: Tally, bucket: UsageBucket | Tally): void {
	tally.responses += bucket.responses;
	tally.input += bucket.input;
	tally.output += bucket.output;
	tally.cacheRead += bucket.cacheRead;
	tally.cacheWrite += bucket.cacheWrite;
	tally.cost += bucket.cost;
}

/** Every token a tally counts, as pi's totalTokens does. */
export const tokensOf = (tally: Tally): number => tally.input + tally.output + tally.cacheRead + tally.cacheWrite;

/** The share of input read from the provider's cache, or undefined when nothing was sent. */
export function cacheShare(tally: Tally): number | undefined {
	const sent = tally.input + tally.cacheRead + tally.cacheWrite;
	return sent ? tally.cacheRead / sent : undefined;
}

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
