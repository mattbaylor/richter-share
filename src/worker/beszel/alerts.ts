import type { SystemStats } from "../../shared/types";
import { addEvent, parseJson } from "../db";
import type { Env } from "../env";
import { notify } from "../notify";
import { EVENT_METRICS } from "./update-alerts";

interface AlertRow {
	id: string;
	metric: string;
	threshold: number | null;
	minutes: number;
	triggered: number;
	last_value?: number | null;
	updated_at?: number | null;
}

/** last_value is display-only: refresh it at most this often unless the alert changes state. */
const LAST_VALUE_EVERY_MS = 15 * 60_000;

export type StatsLoader = (since: number) => Promise<{ at: number; s: SystemStats | null }[]>;

function metricValue(metric: string, s: SystemStats): number | null {
	switch (metric) {
		case "CPU":
			return s.cpu;
		case "Memory":
			return s.mp;
		case "Disk":
			return s.dp;
		case "Temperature":
			return s.t ? Math.max(...Object.values(s.t)) : null;
		case "LoadAvg5":
			return s.la?.[1] ?? null;
		case "Bandwidth":
			return (s.ns + s.nr) / (1024 * 1024); // MB/s
		case "GPU":
			return s.g ? Math.max(...Object.values(s.g).map((g) => g.u)) : null;
		default:
			return null;
	}
}

const UNIT: Record<string, string> = { CPU: "%", Memory: "%", Disk: "%", Temperature: "°C", LoadAvg5: "", Bandwidth: " MB/s", GPU: "%" };

/** Threshold alerts: average of 1m records over `minutes` crosses `threshold`. */
export async function evaluateSystemAlerts(env: Env, systemId: string, systemName: string, preloaded?: AlertRow[], load?: StatsLoader): Promise<void> {
	const all = preloaded ?? (await env.DB.prepare("SELECT * FROM system_alerts WHERE system_id = ?").bind(systemId).all<AlertRow>()).results;
	// Event alerts (Status, package updates, systemd) are evaluated elsewhere.
	const alerts = { results: all.filter((a) => a.threshold != null && !(EVENT_METRICS as readonly string[]).includes(a.metric)) };
	if (!alerts.results.length) return;
	const maxMinutes = Math.max(...alerts.results.map((a) => a.minutes));
	const since = Date.now() - maxMinutes * 60_000 - 30_000;
	const records = (
		load
			? await load(since)
			: (
					await env.DB.prepare("SELECT created_at, stats FROM system_stats WHERE system_id = ? AND type = '1m' AND created_at >= ? ORDER BY created_at")
						.bind(systemId, since)
						.all<{ created_at: number; stats: string }>()
				).results.map((r) => ({ at: r.created_at, s: parseJson<SystemStats | null>(r.stats, null) }))
	).filter((r) => r.s);

	for (const a of alerts.results) {
		if (a.threshold == null) continue;
		const cutoff = Date.now() - a.minutes * 60_000 - 30_000;
		const vals = records.filter((r) => r.at >= cutoff).map((r) => metricValue(a.metric, r.s!)).filter((v): v is number => v != null);
		// Need roughly a full window of data before triggering.
		if (vals.length < Math.max(1, Math.floor(a.minutes * 0.8))) continue;
		const avg = vals.reduce((x, y) => x + y, 0) / vals.length;
		const over = avg > a.threshold;
		const changes = (over && !a.triggered) || (!over && a.triggered);
		if (changes || a.last_value == null || !a.updated_at || Date.now() - a.updated_at >= LAST_VALUE_EVERY_MS) {
			await env.DB.prepare("UPDATE system_alerts SET last_value = ?, updated_at = ? WHERE id = ?").bind(avg, Date.now(), a.id).run();
		}
		if (over && !a.triggered) {
			await env.DB.prepare("UPDATE system_alerts SET triggered = 1 WHERE id = ?").bind(a.id).run();
			const msg = `${a.metric} averaged ${avg.toFixed(1)}${UNIT[a.metric]} over ${a.minutes} min (threshold ${a.threshold}${UNIT[a.metric]})`;
			await addEvent(env.DB, "system_alert", systemId, `${systemName}: ${msg}`);
			await notify(env, { systemId }, { title: `⚠️ ${systemName}: ${a.metric} high`, body: msg, status: "warning", name: systemName });
		} else if (!over && a.triggered) {
			await env.DB.prepare("UPDATE system_alerts SET triggered = 0 WHERE id = ?").bind(a.id).run();
			const msg = `${a.metric} back to ${avg.toFixed(1)}${UNIT[a.metric]} (threshold ${a.threshold}${UNIT[a.metric]})`;
			await addEvent(env.DB, "system_alert_resolved", systemId, `${systemName}: ${msg}`);
			await notify(env, { systemId }, { title: `✅ ${systemName}: ${a.metric} resolved`, body: msg, status: "up", name: systemName });
		}
	}
}

/** A Status alert's DOWN notification waiting for its `minutes` (kept in the AgentConnection DO's storage). */
export interface PendingStatusAlert {
	id: string;
	due: number;
	minutes: number;
}

interface StatusAlertRow {
	id: string;
	minutes: number;
	triggered: number;
}

/**
 * Called on every real up/down transition of a Beszel system (status pages' "Consider down after"
 * plays no part here). Logs the event; the Status alert then works like Beszel's: DOWN is only sent
 * if the system is still down after the alert's `minutes` (returned as a pending alert for the DO to
 * schedule), and UP only if that DOWN was sent (`triggered`). Flaps inside the window send nothing.
 */
export async function systemStatusChanged(env: Env, systemId: string, name: string, status: "up" | "down", now = Date.now()): Promise<PendingStatusAlert | null> {
	await addEvent(env.DB, status === "up" ? "system_up" : "system_down", systemId, `${name}: agent ${status === "up" ? "connected" : "disconnected"}`);
	const a = await env.DB.prepare("SELECT id, minutes, triggered FROM system_alerts WHERE system_id = ? AND metric = 'Status'").bind(systemId).first<StatusAlertRow>();
	if (!a) return null;
	if (status === "down") {
		const minutes = Math.max(1, a.minutes || 1);
		return { id: a.id, due: now + minutes * 60_000, minutes };
	}
	if (!a.triggered) return null;
	await env.DB.prepare("UPDATE system_alerts SET triggered = 0, updated_at = ? WHERE id = ?").bind(now, a.id).run();
	await notify(env, { systemId }, { title: `🟢 ${name} is UP`, body: "The Beszel agent reconnected.", status: "up", name });
	return null;
}

/** The pending DOWN is due and the system is still down: send it unless the alert was removed or already sent. */
export async function sendPendingStatusAlert(env: Env, systemId: string, name: string, p: PendingStatusAlert, now = Date.now()): Promise<boolean> {
	// By metric, not p.id: saving the alerts dialog re-creates rows (keeping `triggered`).
	const a = await env.DB.prepare("SELECT id, minutes, triggered FROM system_alerts WHERE system_id = ? AND metric = 'Status'").bind(systemId).first<StatusAlertRow>();
	if (!a || a.triggered) return false;
	await env.DB.prepare("UPDATE system_alerts SET triggered = 1, updated_at = ? WHERE id = ?").bind(now, a.id).run();
	await notify(env, { systemId }, { title: `🔴 ${name} is DOWN`, body: `The Beszel agent has been disconnected for ${p.minutes} min.`, status: "down", name });
	return true;
}
