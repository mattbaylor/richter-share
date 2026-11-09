import type { SmartDevice } from "../../shared/types";
import { addEvent } from "../db";
import type { Env } from "../env";
import { type NotifyMessage, notify } from "../notify";
import { type AlertRow, hash } from "./update-alerts";

/**
 * S.M.A.R.T. disk health from the stock agent's GetSmartData (smartctl). Richter asks about once an
 * hour per connection, like Beszel's hub, keeps the latest list in D1 (written only when it changes)
 * and raises the SmartFailed event alert when any disk reports FAILED or WARNING.
 */

export const SMART_REFRESH_MS = 3_600_000;
export const SMART_REPLY_MS = 90_000; // smartctl across many disks can be slow

/** Disks that need attention: smartctl's overall verdict, not individual attribute noise. */
export function failingDisks(devices: SmartDevice[]): SmartDevice[] {
	return devices.filter((d) => d.status === "FAILED" || d.status === "WARNING");
}

/** Stored form: without temperature and the ever-growing hour/cycle counters, so the hash only moves on real changes. */
export function smartHash(devices: SmartDevice[]): string {
	return hash(JSON.stringify(devices.map(({ temp: _t, hours: _h, cycles: _c, ...rest }) => rest)));
}

export function smartUpsert(env: Env, systemId: string, devices: SmartDevice[], now: number): D1PreparedStatement {
	// Counters and temperature still refresh, at most hourly, because a changed checked_at day forces a write.
	return env.DB.prepare(
		`INSERT INTO system_smart(system_id, devices, hash, updated_at, checked_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(system_id) DO UPDATE SET devices = excluded.devices, hash = excluded.hash, checked_at = excluded.checked_at,
		   updated_at = CASE WHEN system_smart.hash IS excluded.hash THEN system_smart.updated_at ELSE excluded.updated_at END
		 WHERE system_smart.hash IS NOT excluded.hash OR system_smart.checked_at IS NULL OR excluded.checked_at - system_smart.checked_at >= ?`,
	).bind(systemId, JSON.stringify(devices), smartHash(devices), now, now, 6 * SMART_REFRESH_MS - 60_000);
}

const describe = (d: SmartDevice) => `${d.name}${d.model ? ` (${d.model})` : ""}: ${d.status}${d.flags?.length ? `, ${d.flags.map((f) => f.name).slice(0, 3).join(", ")}` : ""}`;

export function smartAlertMessage(action: "trigger" | "resolve", systemName: string, failing: SmartDevice[]): NotifyMessage {
	if (action === "resolve") return { title: `Disks healthy on ${systemName} ✅`, body: `Every disk on ${systemName} passes its S.M.A.R.T. check again.`, status: "up", name: systemName };
	const n = failing.length;
	return {
		title: `Disk health problem on ${systemName} 🔴`,
		body: `${n} disk${n === 1 ? "" : "s"} failing S.M.A.R.T. on ${systemName}:\n${failing.map(describe).join("\n")}`,
		status: "down",
		name: systemName,
	};
}

/** SmartFailed: notify when the set of failing disks goes from empty to non-empty, or back. */
export async function evaluateSmartAlerts(env: Env, systemId: string, systemName: string, devices: SmartDevice[], alerts: AlertRow[]): Promise<void> {
	const failing = failingDisks(devices);
	for (const a of alerts.filter((x) => x.metric === "SmartFailed")) {
		const now = failing.length > 0;
		if (now === !!a.triggered && a.last_value === failing.length) continue;
		await env.DB.prepare("UPDATE system_alerts SET triggered = ?, last_value = ?, updated_at = ? WHERE id = ?").bind(now ? 1 : 0, failing.length, Date.now(), a.id).run();
		const changed = now !== !!a.triggered;
		a.triggered = now ? 1 : 0;
		a.last_value = failing.length;
		if (!changed) continue;
		const msg = smartAlertMessage(now ? "trigger" : "resolve", systemName, failing);
		await addEvent(env.DB, now ? "system_alert" : "system_alert_resolved", systemId, `${msg.title}: ${msg.body.split("\n")[0]}`);
		await notify(env, { systemId }, msg);
	}
}
