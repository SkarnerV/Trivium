import { useEffect, useState } from "react";

/** Current time, refreshed on an interval. Pass 0 to stop ticking. */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!intervalMs) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}
