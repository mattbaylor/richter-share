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

/** Notification log rows for one notification (one per channel): a single D1 batch, never throws. */
export async function logNotifications(env: Env, target: LogTarget, m: NotifyMessage, results: { ch: LogChannel; error: string | null }[], now = Date.now()): Promise<void> {
	if (!results.length) return;
	try {
		await env.DB.batch(
			results.map(({ ch, error }) =>
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
 * Batching: a channel sends at most one message per BATCH_WINDOW_MS on its own. The first alert goes out at once
 * (and claims the window); alerts that arrive while the window is claimed, or while older ones are still queued,
 * wait in notification_queue and the per-minute cron sends them as one combined message (flushNotificationQueue).
 * A storm (a host reboot taking down a dozen guests) becomes a couple of messages instead of dozens, which keeps
 * push relays like ntfy.sh under their rate limits.
 */
export const BATCH_WINDOW_MS = 60_000;

/** Claim the channel's send window. True if this alert may go out now. Errors fail open (send now). */
async function claimWindow(env: Env, channelId: string, now: number): Promise<boolean> {
	try {
		const r = await env.DB.prepare(
			`INSERT INTO notification_throttle(channel_id, last_sent_at) SELECT ?1, ?2
			 WHERE NOT EXISTS (SELECT 1 FROM notification_queue WHERE channel_id = ?1)
			 ON CONFLICT(channel_id) DO UPDATE SET last_sent_at = excluded.last_sent_at WHERE last_sent_at <= ?3
			 RETURNING channel_id`,
		)
			.bind(channelId, now, now - BATCH_WINDOW_MS)
			.all();
		return r.results.length > 0;
	} catch (e) {
		console.error("notification throttle claim failed", (e as Error).message);
		return true;
	}
}

type Target = { kind: "monitor" | "system"; id: string | null };

async function enqueue(env: Env, ch: ChannelRow, target: Target, m: NotifyMessage, now: number): Promise<boolean> {
	try {
		await env.DB.prepare(
			"INSERT INTO notification_queue(ts, channel_id, title, body, status, name, url, target_kind, target_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(now, ch.id, m.title, m.body, m.status, m.name, m.url ?? null, target.kind, target.id)
			.run();
		return true;
	} catch (e) {
		console.error("notification enqueue failed, sending now", (e as Error).message);
		return false;
	}
}

async function sendLogged(ch: ChannelRow, m: NotifyMessage): Promise<string | null> {
	try {
		await sendToChannel(ch.type, parseJson(ch.config, {}), m);
		return null;
	} catch (e) {
		const error = (e as Error).message || String(e);
		console.error(`notify ${ch.type}:${ch.name} failed`, error);
		return error;
	}
}

/** Send to every enabled channel linked to a monitor or system (or queue it, see BATCH_WINDOW_MS), and log each send. Never throws. */
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
	const t: Target = target.monitorId ? { kind: "monitor", id: target.monitorId } : { kind: "system", id: target.systemId ?? null };
	const results = await Promise.all(
		rows.results.map(async (ch) => {
			if (!(await claimWindow(env, ch.id, now)) && (await enqueue(env, ch, t, m, now))) return null;
			return { ch, error: await sendLogged(ch, m) };
		}),
	);
	await logNotifications(env, t, m, results.filter((r) => r !== null), now);
}

interface QueuedRow {
	id: number;
	ts: number;
	channel_id: string;
	title: string;
	body: string;
	status: NotifyMessage["status"];
	name: string;
	url: string | null;
	target_kind: "monitor" | "system";
	target_id: string | null;
}

/** Longest combined body per channel type (Pushover caps messages at 1024 characters; the rest allow about 4000). */
const maxBody = (type: string) => (type === "pushover" ? 1000 : 3500);

/** One message summarising several queued alerts for the same channel, oldest first. */
export function combine(items: QueuedRow[], type: string): NotifyMessage {
	const toMsg = (q: QueuedRow): NotifyMessage => ({ title: q.title, body: q.body, status: q.status, name: q.name, url: q.url });
	if (items.length === 1) return toMsg(items[0]);
	const count = (s: string) => items.filter((q) => q.status === s).length;
	const parts = [
		[count("down"), "down"],
		[count("up"), "up"],
		[count("warning"), "warning"],
		[count("info"), "info"],
	]
		.filter(([n]) => n)
		.map(([n, s]) => `${n} ${s}`);
	const status: NotifyMessage["status"] = count("down") ? "down" : count("warning") ? "warning" : count("info") ? "info" : "up";
	const limit = maxBody(type);
	const lines: string[] = [];
	let used = 0;
	for (let i = 0; i < items.length; i++) {
		const q = items[i];
		const detail = q.body.replace(/\s+/g, " ").trim();
		const line = (detail ? `${q.title}: ${detail}` : q.title).slice(0, 200);
		const tail = `…and ${items.length - i} more`;
		if (used + line.length + 1 > limit - tail.length - 1) {
			lines.push(tail);
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	const urls = new Set(items.map((q) => q.url ?? ""));
	return {
		title: `Richter: ${items.length} alerts (${parts.join(", ")})`,
		body: lines.join("\n"),
		status,
		name: `${items.length} alerts`,
		url: urls.size === 1 ? items[0].url : null,
	};
}

/** Cron: send every queued alert, one combined message per channel, and log one row per alert. Never throws. */
export async function flushNotificationQueue(env: Env, now = Date.now()): Promise<number> {
	try {
		// DELETE … RETURNING claims the rows atomically, so overlapping crons cannot send an alert twice.
		const taken = await env.DB.prepare("DELETE FROM notification_queue RETURNING *").all<QueuedRow>();
		if (!taken.results.length) return 0;
		const byChannel = new Map<string, QueuedRow[]>();
		for (const q of taken.results.sort((a, b) => a.id - b.id)) byChannel.set(q.channel_id, [...(byChannel.get(q.channel_id) ?? []), q]);
		const ids = [...byChannel.keys()];
		const chans = await env.DB.prepare(`SELECT * FROM notifications WHERE id IN (${ids.map(() => "?").join(",")}) AND enabled = 1`)
			.bind(...ids)
			.all<ChannelRow>();
		await Promise.all(
			chans.results.map(async (ch) => {
				const items = byChannel.get(ch.id)!;
				const error = await sendLogged(ch, combine(items, ch.type));
				await env.DB.prepare(
					"INSERT INTO notification_throttle(channel_id, last_sent_at) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET last_sent_at = excluded.last_sent_at",
				)
					.bind(ch.id, now)
					.run()
					.catch(() => undefined);
				for (const q of items)
					await logNotifications(env, { kind: q.target_kind, id: q.target_id }, { title: q.title, body: q.body, status: q.status, name: q.name }, [{ ch, error }], now);
			}),
		);
		return taken.results.length;
	} catch (e) {
		console.error("notification queue flush failed", (e as Error).message);
		return 0;
	}
}
