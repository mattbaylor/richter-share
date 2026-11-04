import type { ContainerStat, SystemStats } from "../../shared/types";
import { parseJson } from "../db";
import type { Env } from "../env";

/** Beszel's tiers: [type, source type, period minutes, retention ms]. */
export const TIERS = [
	["10m", "1m", 10, 12 * 3600_000],
	["20m", "10m", 20, 24 * 3600_000],
	["120m", "20m", 120, 7 * 86_400_000],
	["480m", "120m", 480, 30 * 86_400_000],
] as const;
export const RETENTION_1M = 3600_000;

/** Average every numeric leaf across records (objects and arrays recurse; missing keys average over present values). */
export function averageDeep(values: unknown[]): unknown {
	const present = values.filter((v) => v !== undefined && v !== null);
	if (!present.length) return undefined;
	const first = present[0];
	if (typeof first === "number") {
		const nums = present.filter((v): v is number => typeof v === "number");
		return nums.reduce((a, b) => a + b, 0) / nums.length;
	}
	if (Array.isArray(first)) {
		const len = Math.max(...present.map((v) => (Array.isArray(v) ? v.length : 0)));
		return Array.from({ length: len }, (_, i) => averageDeep(present.map((v) => (Array.isArray(v) ? v[i] : undefined))));
	}
	if (typeof first === "object") {
		const keys = new Set(present.flatMap((v) => (typeof v === "object" ? Object.keys(v as object) : [])));
		const out: Record<string, unknown> = {};
		for (const k of keys) out[k] = averageDeep(present.map((v) => (v as Record<string, unknown>)[k]));
		return out;
	}
	return first; // strings: keep first
}

export function rollupStats(records: SystemStats[]): SystemStats {
	const avg = averageDeep(records) as SystemStats;
	avg.cpum = Math.max(...records.map((r) => r.cpum ?? r.cpu));
	avg.nsm = Math.max(...records.map((r) => r.nsm ?? r.ns));
	avg.nrm = Math.max(...records.map((r) => r.nrm ?? r.nr));
	avg.drm = Math.max(...records.map((r) => r.drm ?? r.dr));
	avg.dwm = Math.max(...records.map((r) => r.dwm ?? r.dw));
	return avg;
}

export function rollupContainers(records: ContainerStat[][]): ContainerStat[] {
	const byName = new Map<string, ContainerStat[]>();
	for (const list of records) for (const c of list) byName.set(c.n, [...(byName.get(c.n) ?? []), c]);
	return [...byName.entries()].map(([n, cs]) => {
		const last = cs[cs.length - 1];
		const avg = averageDeep(cs) as ContainerStat;
		return { ...avg, n, s: last.s, h: last.h, id: last.id, i: last.i };
	});
}
