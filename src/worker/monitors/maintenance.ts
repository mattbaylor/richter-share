import type { Maintenance } from "../../shared/types";
import { parseJson } from "../db";

export interface MaintenanceRow {
	id: string;
	title: string;
	description: string | null;
	starts_at: number;
	ends_at: number;
	repeat: string | null;
	monitor_ids: string;
	system_ids: string;
	created_at: number;
}

type Repeat = Maintenance["repeat"];

function addPeriod(t: number, every: "day" | "week" | "month", k: number): number {
	if (every === "day") return t + k * 86_400_000;
	if (every === "week") return t + k * 7 * 86_400_000;
	const d = new Date(t);
	d.setUTCMonth(d.getUTCMonth() + k);
	return d.getTime();
}

/** Current (or next) occurrence of a window. Repeats are UTC-anchored. */
export function occurrence(starts: number, ends: number, repeat: Repeat, now: number): { active: boolean; start: number | null; end: number | null } {
	const dur = ends - starts;
	if (!repeat) {
		if (now < starts) return { active: false, start: starts, end: ends };
		if (now < ends) return { active: true, start: starts, end: ends };
		return { active: false, start: null, end: null };
	}
	if (now < starts) return { active: false, start: starts, end: ends };
	let k: number;
	if (repeat.every === "month") {
		const a = new Date(starts);
		const b = new Date(now);
		k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
		if (addPeriod(starts, "month", k) > now) k--;
	} else {
		k = Math.floor((now - starts) / (repeat.every === "day" ? 86_400_000 : 7 * 86_400_000));
	}
	const cur = addPeriod(starts, repeat.every, k);
	const until = repeat.until ?? Infinity;
	if (now < cur + dur && cur <= until) return { active: true, start: cur, end: cur + dur };
	const next = addPeriod(starts, repeat.every, k + 1);
	if (next > until) return { active: false, start: null, end: null };
	return { active: false, start: next, end: next + dur };
}

export function toMaintenance(r: MaintenanceRow, now = Date.now()): Maintenance {
	const repeat = parseJson<Repeat>(r.repeat, null);
	const occ = occurrence(r.starts_at, r.ends_at, repeat, now);
	return {
		id: r.id,
		title: r.title,
		description: r.description,
		starts_at: r.starts_at,
		ends_at: r.ends_at,
		repeat,
		monitor_ids: parseJson(r.monitor_ids, []),
		system_ids: parseJson(r.system_ids, []),
		active: occ.active,
		next_start: occ.active ? occ.start : occ.start,
		created_at: r.created_at,
	};
}

/** Sets of monitor ids and system ids currently under maintenance. */
export async function activeMaintenance(db: D1Database, now = Date.now()): Promise<{ monitors: Set<string>; systems: Set<string>; list: Maintenance[] }> {
	const rows = await db.prepare("SELECT * FROM maintenances").all<MaintenanceRow>();
	const monitors = new Set<string>();
	const systems = new Set<string>();
	const list = rows.results.map((r) => toMaintenance(r, now));
	for (const m of list) {
		if (!m.active) continue;
		m.monitor_ids.forEach((id) => monitors.add(id));
		m.system_ids.forEach((id) => systems.add(id));
	}
	return { monitors, systems, list };
}
