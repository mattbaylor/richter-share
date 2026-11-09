import type { Announcement, Monitor, NotificationChannel, StatusPage, SystemInstall, SystemRecord } from "../shared/types";
import { buildInstall } from "../shared/install";
import { parseJson } from "./db";
import type { Env } from "./env";
import type { MonitorRow } from "./monitors/engine";

export interface SystemRow {
	id: string;
	name: string;
	token: string;
	fingerprint: string | null;
	status: SystemRecord["status"];
	info: string | null;
	details: string | null;
	agent_version: string | null;
	last_seen: number | null;
	connected_at: number | null;
	tags: string;
	created_at: number;
	down_after?: number | null;
	description?: string | null;
	provides?: string | null;
	depends_on?: string | null;
	works_with?: string | null;
}

export function toSystem(r: SystemRow): SystemRecord {
	return {
		id: r.id,
		name: r.name,
		status: r.status,
		info: parseJson(r.info, null),
		details: parseJson(r.details, null),
		agent_version: r.agent_version,
		last_seen: r.last_seen,
		connected_at: r.connected_at,
		fingerprint_bound: !!r.fingerprint,
		tags: parseJson(r.tags, []),
		created_at: r.created_at,
		down_after: Math.max(60, r.down_after ?? 60),
		description: r.description ?? null,
		provides: parseJson(r.provides ?? null, []),
		depends_on: parseJson(r.depends_on ?? null, []),
		works_with: parseJson(r.works_with ?? null, []),
	};
}

export function installFor(env: Env, token: string, key: string): SystemInstall {
	return buildInstall(`https://${env.PUBLIC_HOST}`, token, key);
}

export function toMonitor(env: Env, r: MonitorRow, notificationIds: string[] = []): Monitor {
	return {
		id: r.id,
		name: r.name,
		type: r.type,
		config: parseJson(r.config, {}),
		parent_id: r.parent_id,
		interval_s: r.interval_s,
		retries: r.retries,
		retry_interval_s: r.retry_interval_s,
		timeout_ms: r.timeout_ms,
		max_latency_ms: r.max_latency_ms,
		upside_down: !!r.upside_down,
		resend_every: r.resend_every,
		paused: !!r.paused,
		description: r.description,
		tags: parseJson(r.tags, []),
		status: r.paused ? "paused" : r.status,
		last_check_at: r.last_check_at,
		next_check_at: r.next_check_at,
		last_latency_ms: r.last_latency_ms,
		last_message: r.last_message,
		push_token: r.push_token,
		ping_url: r.push_token ? `https://${env.PUBLIC_HOST}/ping/${r.push_token}` : null,
		last_ping_at: r.last_ping_at,
		domain_expires_at: r.domain_expires_at,
		notification_ids: notificationIds,
		created_at: r.created_at,
	};
}

export interface PageRow {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	logo_url: string | null;
	custom_domain: string | null;
	footer_text: string | null;
	layout: string;
	show_uptime_bars: number;
	show_latency: number;
	show_tags: number;
	published: number;
	is_default: number;
	accent_color: string | null;
	custom_css: string | null;
	created_at: number;
}

export function toPage(env: Env, r: PageRow): StatusPage {
	return {
		id: r.id,
		slug: r.slug,
		title: r.title,
		description: r.description,
		logo_url: r.logo_url,
		custom_domain: r.custom_domain,
		footer_text: r.footer_text,
		layout: parseJson(r.layout, []),
		show_uptime_bars: !!r.show_uptime_bars,
		show_latency: !!r.show_latency,
		show_tags: !!r.show_tags,
		published: !!r.published,
		is_default: !!r.is_default,
		accent_color: r.accent_color,
		custom_css: r.custom_css,
		created_at: r.created_at,
		url: r.custom_domain ? `https://${r.custom_domain}/` : r.is_default ? `https://${env.PUBLIC_HOST}/` : `https://${env.PUBLIC_HOST}/s/${r.slug}`,
	};
}

export function toChannel(r: { id: string; name: string; type: string; config: string; enabled: number; apply_default: number; created_at: number }): NotificationChannel {
	return {
		id: r.id,
		name: r.name,
		type: r.type as NotificationChannel["type"],
		config: parseJson(r.config, {}),
		enabled: !!r.enabled,
		apply_default: !!r.apply_default,
		created_at: r.created_at,
	};
}

export function toAnnouncement(r: Omit<Announcement, "pinned"> & { pinned: number }): Announcement {
	return { ...r, pinned: !!r.pinned };
}
