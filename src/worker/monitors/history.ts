import type { CheckPoint } from "../../shared/types";

/**
 * Check history is stored as one D1 row per monitor per UTC hour (check_buckets). Each row holds a JSON
 * array of samples: [offset_ms_in_hour, status, latency_ms, message?]. The message is only included when
 * it differs from the previous sample's message, and carries forward when decoding.
 */
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const hourOf = (ts: number) => Math.floor(ts / HOUR) * HOUR;

export function encodeBucket(hour: number, samples: CheckPoint[]): string {
	let prev: string | null | undefined;
	return JSON.stringify(
		samples.map((p) => {
			const e: (number | string | null)[] = [p.ts - hour, p.status, p.latency_ms];
			if (p.message !== prev) e.push(p.message);
			prev = p.message;
			return e;
		}),
	);
}

export function decodeBucket(hour: number, data: string): CheckPoint[] {
	let arr: unknown;
	try {
		arr = JSON.parse(data);
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const rows = (arr as unknown[]).filter((e): e is unknown[] => Array.isArray(e) && typeof e[0] === "number").sort((a, b) => (a[0] as number) - (b[0] as number));
	let msg: string | null = null;
	return rows.map((e) => {
		if (e.length > 3) msg = (e[3] as string | null) ?? null;
		return { ts: hour + (e[0] as number), status: (e[1] as CheckPoint["status"]) ?? 1, latency_ms: (e[2] as number | null) ?? null, message: msg };
	});
}

/** Average latency (or CPU %) per 15-minute slot: [slotStart, sum, n]. 96 slots = 24 h. */
export type LatSlot = [number, number, number];
export const LAT_SLOT_MS = 900_000;

export function addLatency(slots: LatSlot[], ts: number, ms: number, keepFrom: number): LatSlot[] {
	const b = Math.floor(ts / LAT_SLOT_MS) * LAT_SLOT_MS;
	const last = slots[slots.length - 1];
	// ">=": a slot from the older 20-minute layout that starts after this 15-minute boundary keeps
	// taking samples until the next boundary, so slots stay in order; old slots age out within 24 h.
	if (last && last[0] >= b) {
		last[1] += ms;
		last[2] += 1;
	} else slots.push([b, ms, 1]);
	while (slots.length && slots[0][0] < keepFrom) slots.shift();
	return slots;
}
