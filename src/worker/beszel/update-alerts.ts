import type { PackageUpdate, SystemdService } from "../../shared/types";
import { addEvent } from "../db";
import type { Env } from "../env";
import { type NotifyMessage, notify } from "../notify";

/**
 * Package update and systemd alerts, ported from the mattzab/beszel fork (SecurityUpdates, PackageUpdates)
 * and henrygd/beszel (SystemdFailed). They notify on state changes only and write to D1 only
 * when an alert's state or last seen count changes.
 */

export const UPDATE_METRICS = ["SecurityUpdates", "PackageUpdates"] as const;
export const EVENT_METRICS = ["Status", "SecurityUpdates", "PackageUpdates", "SystemdFailed", "SmartFailed"] as const;
const MAX_LISTED = 10;

export interface AlertRow {
	id: string;
	metric: string;
	threshold: number | null;
	minutes: number;
	triggered: number;
	last_value: number | null;
}

export type PackageAction = "none" | "trigger" | "rise" | "resolve";

/** [total] or [total, security] from Info.PackageUpdates; null when the agent has not reported. */
export function packageCounts(pu: number[] | undefined): { total: number; security: number | null } | null {
	if (!pu || pu.length === 0) return null;
	return { total: pu[0], security: pu.length > 1 ? pu[1] : null };
}

export function packageThreshold(v: number | null): number {
	if (v == null || !(v >= 1)) return 1;
	return Math.min(65535, Math.floor(v));
}

/** Only the security alert re-notifies when the count rises while triggered. */
export function evaluatePackageAlert(metric: string, wasTriggered: boolean, count: number, threshold: number, lastCount: number | null): PackageAction {
	const over = count >= threshold;
	if (over && !wasTriggered) return "trigger";
	if (!over && wasTriggered) return "resolve";
	if (over && metric === "SecurityUpdates" && lastCount != null && count > lastCount) return "rise";
	return "none";
}

const plural = (n: number, kind: string) => `${n} ${kind} update${n === 1 ? "" : "s"}`;

export function formatPackage(p: PackageUpdate): string {
	if (p.c && p.a) return `${p.n} (${p.c} → ${p.a})`;
	if (p.a) return `${p.n} (${p.a})`;
	return p.n;
}

export function formatList(names: string[], sep = "\n"): string {
	if (names.length <= MAX_LISTED) return names.join(sep);
	return `${names.slice(0, MAX_LISTED).join(sep)}${sep}and ${names.length - MAX_LISTED} more`;
}

export function packageAlertMessage(
	metric: string,
	action: Exclude<PackageAction, "none">,
	systemName: string,
	count: number,
	threshold: number,
	packages: PackageUpdate[] | null,
): NotifyMessage {
	const security = metric === "SecurityUpdates";
	const kind = security ? "security" : "package";
	const Kind = security ? "Security" : "Package";
	if (action === "resolve") {
		return {
			title: `${Kind} updates cleared on ${systemName} ✅`,
			body: count === 0 ? `No ${kind} updates are pending on ${systemName}.` : `${plural(count, kind)} on ${systemName}, below the alert threshold of ${threshold}.`,
			status: "up",
			name: systemName,
		};
	}
	const emoji = security ? "🔴" : "🟡";
	let body = `${plural(count, kind)} pending on ${systemName}.`;
	const names = (packages ?? []).filter((p) => !security || p.s).map(formatPackage);
	if (names.length) body += `\n${formatList(names)}`;
	return {
		title: `${action === "rise" ? `More ${kind}` : Kind} updates on ${systemName} ${emoji}`,
		body,
		status: security ? "down" : "warning",
		name: systemName,
	};
}

/** Evaluate SecurityUpdates / PackageUpdates rows. `getPackages` is called at most once, only when sending. */
export async function evaluatePackageAlerts(
	env: Env,
	systemId: string,
	systemName: string,
	pu: number[] | undefined,
	alerts: AlertRow[],
	getPackages: () => Promise<PackageUpdate[] | null>,
	dashboardUrl?: string,
): Promise<void> {
	const rows = alerts.filter((a) => (UPDATE_METRICS as readonly string[]).includes(a.metric));
	if (!rows.length) return;
	const counts = packageCounts(pu);
	if (!counts) return; // agent has not reported (or is still running its first check)
	let packages: PackageUpdate[] | null | undefined;
	const now = Date.now();
	for (const a of rows) {
		const count = a.metric === "SecurityUpdates" ? counts.security : counts.total;
		if (count == null) continue; // package manager cannot flag security updates
		const threshold = packageThreshold(a.threshold);
		const action = evaluatePackageAlert(a.metric, !!a.triggered, count, threshold, a.last_value);
		const triggered = action === "trigger" ? 1 : action === "resolve" ? 0 : a.triggered;
		if (action === "none" && a.last_value === count) continue; // nothing to write or send
		await env.DB.prepare("UPDATE system_alerts SET triggered = ?, last_value = ?, updated_at = ? WHERE id = ?").bind(triggered, count, now, a.id).run();
		a.triggered = triggered;
		a.last_value = count;
		if (action === "none") continue;
		if (action !== "resolve" && packages === undefined) packages = await getPackages().catch(() => null);
		const msg = packageAlertMessage(a.metric, action, systemName, count, threshold, packages ?? null);
		if (dashboardUrl) msg.url = dashboardUrl;
		await addEvent(env.DB, action === "resolve" ? "system_alert_resolved" : "system_alert", systemId, `${msg.title}: ${msg.body.split("\n")[0]}`);
		await notify(env, { systemId }, msg);
	}
}

export function failedServices(services: SystemdService[]): string[] {
	return services.filter((s) => s.s === 2).map((s) => s.n);
}

export function systemdAction(wasTriggered: boolean, failed: string[]): "none" | "trigger" | "resolve" {
	const now = failed.length > 0;
	if (now === wasTriggered) return "none";
	return now ? "trigger" : "resolve";
}

export function systemdAlertMessage(action: "trigger" | "resolve", systemName: string, failed: string[]): NotifyMessage {
	if (action === "trigger") {
		const n = failed.length;
		return {
			title: `Failed services on ${systemName} 🔴`,
			body: `${n} failed service${n === 1 ? "" : "s"} on ${systemName}: ${formatList(failed, ", ")}`,
			status: "down",
			name: systemName,
		};
	}
	return { title: `Services recovered on ${systemName} ✅`, body: `No services are in the failed state on ${systemName}.`, status: "up", name: systemName };
}

/** Evaluate SystemdFailed against a fresh services snapshot. */
export async function evaluateSystemdAlerts(
	env: Env,
	systemId: string,
	systemName: string,
	services: SystemdService[],
	alerts: AlertRow[],
	dashboardUrl?: string,
): Promise<void> {
	const failed = failedServices(services);
	for (const a of alerts.filter((x) => x.metric === "SystemdFailed")) {
		const action = systemdAction(!!a.triggered, failed);
		if (action === "none") continue;
		const triggered = action === "trigger" ? 1 : 0;
		await env.DB.prepare("UPDATE system_alerts SET triggered = ?, last_value = ?, updated_at = ? WHERE id = ?").bind(triggered, failed.length, Date.now(), a.id).run();
		a.triggered = triggered;
		const msg = systemdAlertMessage(action, systemName, failed);
		if (dashboardUrl) msg.url = dashboardUrl;
		await addEvent(env.DB, action === "trigger" ? "system_alert" : "system_alert_resolved", systemId, `${msg.title}: ${msg.body}`);
		await notify(env, { systemId }, msg);
	}
}

/** 32-bit FNV-1a, hex. Used to skip D1 writes when a snapshot has not changed. */
export function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}
