
/**
 * Heartbeat history is sparse: a checks row is only written when the status changes,
 * the UTC day rolls over, or HB_FLUSH_MS has passed. monitor_daily counts for heartbeats
 * are minutes spent in each state, attributed when the next row is written. These helpers
 * add the not-yet-attributed tail (time since the latest checks row) so uptime stays exact.
 */
export const HB_FLUSH_MS = 3600_000;
const DAY = 86_400_000;
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export interface DailyCounts {
	monitor_id: string;
	day: string;
	up: number;
	down: number;
	degraded: number;
	latency_sum?: number;
	latency_n?: number;
}

export interface LatestCheck {
	ts: number;
	status: number;
}

/** Minutes of the current UTC day not yet written to monitor_daily for a heartbeat. */
export function heartbeatTail(m: { type: string; paused?: number | boolean }, latest: LatestCheck | null | undefined, now = Date.now()): { status: number; minutes: number } | null {
	if (m.type !== "heartbeat" || m.paused || !latest) return null;
	const midnight = Math.floor(now / DAY) * DAY;
	const from = Math.max(latest.ts, midnight, now - 2 * HB_FLUSH_MS);
	const minutes = Math.max(0, (now - from) / 60_000);
	return minutes > 0 ? { status: latest.status, minutes } : null;
}

/** Split [from, to) into per-UTC-day minute chunks. */
export function minutesByDay(from: number, to: number): [string, number][] {
	const out: [string, number][] = [];
	for (let t = from; t < to; ) {
		const end = Math.min((Math.floor(t / DAY) + 1) * DAY, to);
		out.push([utcDay(t), (end - t) / 60_000]);
		t = end;
	}
	return out;
}

/**
 * Approximate rolling-24h uptime from today's and yesterday's monitor_daily rows:
 * yesterday is weighted by the share of it that falls inside the window.
 */
export function uptime24h(rows: DailyCounts[], tail: { status: number; minutes: number } | null, now = Date.now()): { uptime: number | null; latency: number | null } {
	const today = utcDay(now);
	const yesterday = utcDay(now - DAY);
	const f = 1 - (now - Math.floor(now / DAY) * DAY) / DAY;
	let down = 0;
	let total = 0;
	let latSum = 0;
	let latN = 0;
	for (const r of rows) {
		const w = r.day === today ? 1 : r.day === yesterday ? f : 0;
		if (!w) continue;
		down += w * r.down;
		total += w * (r.up + r.degraded + r.down);
		latSum += w * (r.latency_sum ?? 0);
		latN += w * (r.latency_n ?? 0);
	}
	if (tail && tail.status !== 3) {
		total += tail.minutes;
		if (tail.status === 0) down += tail.minutes;
	}
	return { uptime: total > 0 ? 100 - (100 * down) / total : null, latency: latN > 0 ? Math.round(latSum / latN) : null };
}
