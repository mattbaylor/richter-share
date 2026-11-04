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

/** Send to every enabled channel linked to a monitor or system, and log each result. Failures are logged, never thrown. */
export async function notify(env: Env, target: { monitorId?: string; systemId?: string }, m: NotifyMessage): Promise<void> {
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
	const results = await Promise.all(
		rows.results.map(async (ch) => {
			try {
				await sendToChannel(ch.type, parseJson(ch.config, {}), m);
				return { ch, error: null };
			} catch (e) {
				const error = (e as Error).message || String(e);
				console.error(`notify ${ch.type}:${ch.name} failed`, error);
				return { ch, error };
			}
		}),
	);
	await logNotifications(env, target.monitorId ? { kind: "monitor", id: target.monitorId } : { kind: "system", id: target.systemId ?? null }, m, results);
}
