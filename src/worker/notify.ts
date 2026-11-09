import { parseJson } from "./db";
import type { Env } from "./env";

export interface NotifyMessage {
	title: string; // short, e.g. "🔴 API is DOWN"
	body: string; // detail line
	status: "down" | "up" | "warning" | "info";
	name: string; // monitor or system name
	url?: string | null; // link to target or dashboard
}

interface ChannelRow {
	id: string;
	name: string;
	type: string;
	config: string;
	enabled: number;
}

const COLORS = { down: 0xef4444, up: 0x22c55e, warning: 0xf59e0b, info: 0x3b82f6 };

function render(template: string, m: NotifyMessage): string {
	const vars: Record<string, string> = {
		name: m.name,
		status: m.status,
		message: m.body,
		title: m.title,
		url: m.url ?? "",
		time: new Date().toISOString(),
	};
	return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => JSON.stringify(vars[k] ?? "").slice(1, -1));
}

async function ensureOk(res: Response): Promise<void> {
	if (!res.ok) {
		const text = (await res.text()).slice(0, 200);
		throw new Error(`HTTP ${res.status}: ${text}`);
	}
}

export async function sendToChannel(type: string, cfg: Record<string, string>, m: NotifyMessage): Promise<void> {
	const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

	switch (type) {
		case "discord":
			return ensureOk(
				await json(cfg.webhook_url, {
					username: "Richter",
					embeds: [{ title: m.title, description: m.body, color: COLORS[m.status], url: m.url || undefined, timestamp: new Date().toISOString() }],
				}),
			);
		case "slack":
			return ensureOk(await json(cfg.webhook_url, { text: `*${m.title}*\n${m.body}${m.url ? `\n<${m.url}>` : ""}` }));
		case "telegram":
			return ensureOk(
				await json(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
					chat_id: cfg.chat_id,
					text: `${m.title}\n${m.body}${m.url ? `\n${m.url}` : ""}`,
					disable_web_page_preview: true,
				}),
			);
		case "ntfy": {
			const server = (cfg.server || "https://ntfy.sh").replace(/\/$/, "");
			const headers: Record<string, string> = {
				// Header values must be ASCII; ntfy accepts RFC 2047 encoded words for emoji.
				Title: /^[\x20-\x7e]*$/.test(m.title) ? m.title : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(m.title)))}?=`,
				Priority: cfg.priority || (m.status === "down" ? "4" : "3"),
				Tags: m.status === "down" ? "red_circle" : m.status === "up" ? "green_circle" : "warning",
			};
			if (m.url) headers.Click = m.url;
			if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
			return ensureOk(await fetch(`${server}/${encodeURIComponent(cfg.topic)}`, { method: "POST", headers, body: m.body }));
		}
		case "gotify": {
			const server = cfg.server.replace(/\/$/, "");
			return ensureOk(
				await json(`${server}/message`, { title: m.title, message: m.body, priority: Number(cfg.priority || 8) }, { "X-Gotify-Key": cfg.app_token }),
			);
		}
		case "pushover":
			return ensureOk(
				await json("https://api.pushover.net/1/messages.json", {
					token: cfg.app_token,
					user: cfg.user_key,
					title: m.title,
					message: m.body,
					url: m.url || undefined,
					priority: m.status === "down" ? 1 : 0,
				}),
			);
		case "webhook": {
			const body = cfg.body_template ? render(cfg.body_template, m) : JSON.stringify({ ...m, time: new Date().toISOString() });
			return ensureOk(
				await fetch(cfg.url, { method: cfg.method || "POST", headers: { "content-type": "application/json" }, body }),
			);
		}
		default:
			throw new Error(`unknown channel type ${type}`);
	}
}

export type LogTarget = { kind: "monitor" | "system" | "test"; id: string | null };
interface LogChannel {
	id: string | null;
	name: string;
	type: string;
}

type LogEntry = { target: LogTarget; m: NotifyMessage; ch: LogChannel; error: string | null };

/** Notification log rows for one notification (one per channel): a single D1 batch, never throws. */
export async function logNotifications(env: Env, target: LogTarget, m: NotifyMessage, results: { ch: LogChannel; error: string | null }[], now = Date.now()): Promise<void> {
	await logEntries(env, results.map(({ ch, error }) => ({ target, m, ch, error })), now);
}

async function logEntries(env: Env, entries: LogEntry[], now: number): Promise<void> {
	if (!entries.length) return;
	try {
		await env.DB.batch(
			entries.map(({ target, m, ch, error }) =>
				env.DB.prepare(
					"INSERT INTO notification_log(ts, channel_id, channel_name, channel_type, title, body, status, target_kind, target_id, target_name, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).bind(now, ch.id, ch.name, ch.type, m.title.slice(0, 200), m.body.slice(0, 500), m.status, target.kind, target.id, m.name, error ? 0 : 1, error ? error.slice(0, 300) : null),
			),
		);
	} catch (e) {
		console.error("notification log insert failed", (e as Error).message);
	}
}

/**
 * Channel types whose alerts are batched: at most one message per BATCH_WINDOW_MS per channel.
 * The first alert after a quiet window goes out at once; later ones wait in notify_pending and the
 * cron sends them as one digest (flushBatches). A self-hosted ntfy relays every message to ntfy.sh
 * for iOS push, and ntfy.sh rate-limits (HTTP 429) the bursts a reboot or outage produces.
 */
const BATCHED = new Set(["ntfy"]);
export const BATCH_WINDOW_MS = 60_000;
const DIGEST_MAX_CHARS = 3500; // ntfy's message limit is 4096 bytes
const FLUSH_MAX_ROWS = 500;

/** Take the channel's send slot if the window has passed (and, for a live alert, nothing is queued). Atomic in D1. */
async function claimSlot(env: Env, channelId: string, now: number, requireEmptyQueue: boolean): Promise<boolean> {
	const r = await env.DB.prepare(
		`INSERT INTO notify_batch(channel_id, last_sent) VALUES (?1, ?2)
		 ON CONFLICT(channel_id) DO UPDATE SET last_sent = excluded.last_sent
		 WHERE notify_batch.last_sent <= ?3${requireEmptyQueue ? " AND NOT EXISTS (SELECT 1 FROM notify_pending WHERE channel_id = ?1)" : ""}`,
	)
		.bind(channelId, now, now - BATCH_WINDOW_MS)
		.run();
	return (r.meta?.changes ?? 0) > 0;
}

const ORDER: NotifyMessage["status"][] = ["down", "warning", "up", "info"];
const LABEL: Record<NotifyMessage["status"], string> = { down: "down", warning: "warning", up: "up", info: "info" };

/** One message summarising several queued alerts, oldest first. */
export function digest(ms: NotifyMessage[]): NotifyMessage {
	const count = (s: NotifyMessage["status"]) => ms.filter((m) => m.status === s).length;
	const parts = ORDER.filter((s) => count(s) > 0).map((s) => `${count(s)} ${LABEL[s]}`);
	const status = ORDER.find((s) => count(s) > 0) ?? "info";
	const lines: string[] = [];
	let len = 0;
	for (const [i, m] of ms.entries()) {
		const line = `${m.title}${m.body ? `: ${m.body}` : ""}`.replace(/\s*\n\s*/g, " ");
		if (len + line.length + 1 > DIGEST_MAX_CHARS) {
			lines.push(`...and ${ms.length - i} more (see the notification log)`);
			break;
		}
		lines.push(line);
		len += line.length + 1;
	}
	return { title: `${ms.length} alerts (${parts.join(", ")})`, body: lines.join("\n"), status, name: "Richter" };
}

async function sendLogged(ch: ChannelRow, m: NotifyMessage): Promise<{ ch: ChannelRow; error: string | null }> {
	try {
		await sendToChannel(ch.type, parseJson(ch.config, {}), m);
		return { ch, error: null };
	} catch (e) {
		const error = (e as Error).message || String(e);
		console.error(`notify ${ch.type}:${ch.name} failed`, error);
		return { ch, error };
	}
}

/** Send to every enabled channel linked to a monitor or system, and log each result. Failures are logged, never thrown. */
export async function notify(env: Env, target: { monitorId?: string; systemId?: string }, m: NotifyMessage, now = Date.now()): Promise<void> {
	const rows = target.monitorId
		? await env.DB.prepare(
				"SELECT n.* FROM notifications n JOIN monitor_notifications mn ON mn.notification_id = n.id WHERE mn.monitor_id = ? AND n.enabled = 1",
			)
				.bind(target.monitorId)
				.all<ChannelRow>()
		: await env.DB.prepare(
				"SELECT n.* FROM notifications n JOIN system_notifications sn ON sn.notification_id = n.id WHERE sn.system_id = ? AND n.enabled = 1",
			)
				.bind(target.systemId)
				.all<ChannelRow>();
	const logTarget: LogTarget = target.monitorId ? { kind: "monitor", id: target.monitorId } : { kind: "system", id: target.systemId ?? null };
	const results = await Promise.all(
		rows.results.map(async (ch) => {
			if (BATCHED.has(ch.type)) {
				try {
					if (!(await claimSlot(env, ch.id, now, true))) {
						await env.DB.prepare("INSERT INTO notify_pending(channel_id, ts, target_kind, target_id, msg) VALUES (?, ?, ?, ?, ?)")
							.bind(ch.id, now, logTarget.kind, logTarget.id, JSON.stringify(m))
							.run();
						return null; // logged when the digest goes out
					}
				} catch (e) {
					console.error(`notify batch ${ch.name}: D1 failed, sending now`, (e as Error).message);
				}
			}
			return sendLogged(ch, m);
		}),
	);
	await logNotifications(env, logTarget, m, results.filter((r) => r !== null), now);
}

/** Cron: send each batched channel's queued alerts as one message once its window has passed. Never throws. */
export async function flushBatches(env: Env, now = Date.now()): Promise<number> {
	let sent = 0;
	try {
		const { results: due } = await env.DB.prepare(
			"SELECT DISTINCT p.channel_id FROM notify_pending p LEFT JOIN notify_batch b ON b.channel_id = p.channel_id WHERE b.last_sent IS NULL OR b.last_sent <= ?",
		)
			.bind(now - BATCH_WINDOW_MS)
			.all<{ channel_id: string }>();
		for (const { channel_id } of due) {
			if (!(await claimSlot(env, channel_id, now, false))) continue; // another tick got it
			const { results: queued } = await env.DB.prepare("SELECT id, target_kind, target_id, msg FROM notify_pending WHERE channel_id = ? ORDER BY id LIMIT ?")
				.bind(channel_id, FLUSH_MAX_ROWS)
				.all<{ id: number; target_kind: LogTarget["kind"]; target_id: string | null; msg: string }>();
			if (!queued.length) continue;
			await env.DB.prepare("DELETE FROM notify_pending WHERE channel_id = ? AND id <= ?").bind(channel_id, queued[queued.length - 1].id).run();
			const ch = await env.DB.prepare("SELECT * FROM notifications WHERE id = ? AND enabled = 1").bind(channel_id).first<ChannelRow>();
			if (!ch) continue; // channel deleted or disabled meanwhile: drop its queue
			const items = queued.map((q) => ({ target: { kind: q.target_kind, id: q.target_id }, m: parseJson<NotifyMessage>(q.msg, { title: "?", body: "", status: "info", name: "?" }) }));
			const { error } = await sendLogged(ch, items.length === 1 ? items[0].m : digest(items.map((x) => x.m)));
			await logEntries(env, items.map(({ target, m }) => ({ target, m, ch, error })), now);
			sent++;
		}
	} catch (e) {
		console.error("notify batch flush failed", (e as Error).message);
	}
	return sent;
}
