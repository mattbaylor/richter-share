import type { DayBar, HttpConfig, Maintenance, PublicItem, PublicPage, StatusPageGroup } from "../shared/types";
import { parseJson } from "./db";
import type { Env } from "./env";
import { toAnnouncement, toPage, type PageRow, type SystemRow } from "./mappers";
import { utcDay, type MonitorRow } from "./monitors/engine";
import { LAT_SLOT_MS } from "./monitors/history";

/** Built inside the Hub Durable Object from its live state; D1 only supplies pages, systems, incidents and announcements. */
export interface PageSource {
	monitors(ids: string[]): MonitorRow[];
	daily(ids: string[], fromDay: string, now: number): { monitor_id: string; day: string; up: number; down: number; degraded: number; maint: number }[];
	latency(ids: string[], since: number): Map<string, { ts: number; ms: number }[]>;
	maintenance(now: number): { list: Maintenance[] };
	/** system_daily minutes for days >= fromDay (90 d cached in the Hub), today's from live state. */
	systemDaily(ids: string[], fromDay: string, now: number): { system_id: string; day: string; up: number; down: number; maint: number; outages?: number }[];
	/** 15-minute CPU % averages since `since` and the newest sample (null if stale), from the Hub's state. */
	cpu?(ids: string[], since: number, now: number): Map<string, { series: { ts: number; pct: number }[]; now: number | null }>;
	/** When the Hub saw the system's current (real) outage start; `now` if it has not sampled it yet, 0 if unknown/long ago. */
	systemDownSince?(id: string, now: number): number;
}

/**
 * A system's "Consider down after" (seconds) as a status-page grace in ms: 1 minute minimum and
 * default (status-page accounting is per minute). Dashboard and alerts never use it.
 */
export function pageGraceMs(downAfter: number | null | undefined): number {
	return Math.max(60, downAfter ?? 60) * 1000;
}

/**
 * What status pages show for a system: Down only once its current outage (counted from when the
 * system was really marked Down) has lasted the grace; until then it still shows Up.
 */
export function pageSystemStatus<S extends string>(status: S, downSince: number | null | undefined, graceMs: number, now: number): S | "up" {
	return status === "down" && graceMs > 0 && now - (downSince ?? 0) < graceMs ? "up" : status;
}


export async function pageFor(env: Env, host: string, slug?: string): Promise<PageRow | null> {
	const db = env.DB;
	if (slug) return db.prepare("SELECT * FROM status_pages WHERE slug = ? AND published = 1").bind(slug).first<PageRow>();
	const custom = await db.prepare("SELECT * FROM status_pages WHERE custom_domain = ? AND published = 1").bind(host).first<PageRow>();
	if (custom) return custom;
	return db.prepare("SELECT * FROM status_pages WHERE published = 1 ORDER BY is_default DESC, created_at LIMIT 1").first<PageRow>();
}

function lastDays(n: number, now = Date.now()): string[] {
	return Array.from({ length: n }, (_, i) => utcDay(now - (n - 1 - i) * 86_400_000));
}

export async function buildPublicPage(env: Env, row: PageRow, src: PageSource): Promise<PublicPage> {
	const db = env.DB;
	const page = toPage(env, row);
	const showSystemUptime = !!(row as PageRow & { show_system_uptime?: number }).show_system_uptime;
	// Default ON (migration 5); a row from before the column existed counts as on.
	const showSystemCpu = ((row as PageRow & { show_system_cpu?: number }).show_system_cpu ?? 1) !== 0;
	const layout: StatusPageGroup[] = page.layout;
	const hiddenIds = new Set<string>();
	const hiddenTerms = new Set<string>();
	const noteHidden = (id: string, url: string | null) => {
		hiddenIds.add(id);
		for (const t of hostTerms(url)) hiddenTerms.add(t);
	};
	const monitorIds = layout.flatMap((g) => g.items.filter((i) => i.kind === "monitor").map((i) => i.id));
	const systemIds = layout.flatMap((g) => g.items.filter((i) => i.kind === "system").map((i) => i.id));
	const now = Date.now();
	const days = lastDays(90, now);
	const ph = (n: number) => Array(n).fill("?").join(",") || "''";

	const monitors = src.monitors(monitorIds);
	const systems = systemIds.length
		? (await db.prepare(`SELECT * FROM systems WHERE id IN (${ph(systemIds.length)})`).bind(...systemIds).all<SystemRow>()).results
		: [];
	// 90 days of per-day counts, today's including the heartbeat time not yet attributed.
	const daily = src.daily(monitorIds, days[0], now);
	const incidents = monitorIds.length
		? (
				await db
					.prepare(
						`SELECT i.id, i.monitor_id, m.name, i.started_at, i.resolved_at, i.cause FROM incidents i JOIN monitors m ON m.id = i.monitor_id
						 WHERE i.monitor_id IN (${ph(monitorIds.length)}) AND (i.resolved_at IS NULL OR i.started_at >= ?) ORDER BY i.started_at DESC`,
					)
					.bind(...monitorIds, now - 90 * 86_400_000)
					.all<{ id: string; monitor_id: string; name: string; started_at: number; resolved_at: number | null; cause: string | null }>()
			).results
		: [];
	// Latency chart: 96 x 15-minute slot averages per monitor, kept live by the Hub.
	const latencyIds = monitors.filter((m) => m.type === "http" || m.type === "tcp" || m.type === "dns").map((m) => m.id);
	const bucketStart = Math.floor((now - 86_400_000) / LAT_SLOT_MS) * LAT_SLOT_MS;
	const latency = page.show_latency ? src.latency(latencyIds, bucketStart) : new Map<string, { ts: number; ms: number }[]>();
	// Systems: per-day connected vs down minutes (maintenance excluded, as for monitors). Opt-in per page.
	const cpu = showSystemCpu && systemIds.length && src.cpu ? src.cpu(systemIds, bucketStart, now) : null;
	const sysDaily = showSystemUptime && systemIds.length ? src.systemDaily(systemIds, days[0], now) : [];
	const sysBarsFor = (id: string): { bars: DayBar[]; uptime: number | null } => {
		let down = 0;
		let total = 0;
		const byDay = new Map(sysDaily.filter((x) => x.system_id === id).map((x) => [x.day, x]));
		const bars = days.map((day) => {
			const d = byDay.get(day);
			const n = d ? d.up + d.down : 0;
			down += d ? d.down : 0;
			total += n;
			return { day, uptime: n > 0 ? 100 - (100 * (d?.down ?? 0)) / n : null, incidents: d?.outages ?? 0 };
		});
		return { bars, uptime: total > 0 ? 100 - (100 * down) / total : null };
	};
	const barsFor = (id: string): { bars: DayBar[]; uptime: number | null } => {
		let down = 0;
		let total = 0;
		const mine = daily.filter((x) => x.monitor_id === id);
		const bars = days.map((day) => {
			const d = mine.find((x) => x.day === day);
			const dayDown = d ? d.down : 0;
			const n = d ? d.up + d.degraded + d.down : 0;
			down += dayDown;
			total += n;
			const inc = incidents.filter((i) => i.monitor_id === id && utcDay(i.started_at) === day).length;
			// Computed from the down share so an all-up day is exactly 100 despite fractional tail minutes.
			return { day, uptime: n ? 100 - (100 * dayDown) / n : null, incidents: inc };
		});
		return { bars, uptime: total ? 100 - (100 * down) / total : null };
	};

	const groups = layout.map((g) => ({
		name: g.name,
		items: g.items
			.map((ref): PublicItem | null => {
				if (ref.kind === "monitor") {
					const m = monitors.find((x) => x.id === ref.id);
					if (!m) return null;
					const { bars, uptime } = barsFor(m.id);
					const rawUrl = m.type === "http" ? parseJson<HttpConfig>(m.config, { url: "" }).url : null;
					// "Link to site" off: no link, and the address is scrubbed from the whole page below.
					if (ref.link === false) noteHidden(m.id, rawUrl);
					const url = ref.link === false ? null : rawUrl;
					return {
						kind: "monitor",
						id: m.id,
						name: m.name,
						status: m.paused ? "paused" : m.status,
						url: url ? url.split("?")[0] : null,
						type: m.type,
						uptime_90d: uptime,
						bars: page.show_uptime_bars ? bars : [],
						latency: page.show_latency ? (latency.get(m.id) ?? []) : undefined,
						tags: page.show_tags ? parseJson(m.tags, []) : undefined,
					};
				}
				const s = systems.find((x) => x.id === ref.id);
				if (!s) return null;
				// Systems: status, and if enabled daily up/down uptime and a 24 h CPU % sparkline. No other metrics are public.
				const up = showSystemUptime ? sysBarsFor(s.id) : null;
				const c = cpu?.get(s.id);
				const status = pageSystemStatus(s.status, src.systemDownSince ? src.systemDownSince(s.id, now) : 0, pageGraceMs((s as { down_after?: number }).down_after), now);
				return {
					kind: "system",
					id: s.id,
					name: s.name,
					status,
					url: null,
					type: "system",
					uptime_90d: up ? up.uptime : null,
					bars: up && page.show_uptime_bars ? up.bars : [],
					cpu: c ? c.series : undefined,
					cpu_now: c ? (status === "up" ? c.now : null) : undefined,
					tags: page.show_tags ? parseJson(s.tags, []) : undefined,
				};
			})
			.filter((x): x is PublicItem => x !== null),
	}));

	const all = groups.flatMap((g) => g.items);
	const down = all.filter((i) => i.status === "down").length;
	const overall: PublicPage["overall"] =
		all.length && down / all.length > 0.5
			? "major"
			: down
				? "partial"
				: all.some((i) => i.status === "degraded")
					? "degraded"
					: all.some((i) => i.status === "maintenance")
						? "maintenance"
						: "operational";

	const anns = await db
		.prepare(
			"SELECT * FROM announcements WHERE (status_page_id IS NULL OR status_page_id = ?) AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) ORDER BY created_at DESC LIMIT 20",
		)
		.bind(row.id, now, now)
		.all<Parameters<typeof toAnnouncement>[0]>();
	const maint = src.maintenance(now);
	const relevant = maint.list.filter(
		(m) => m.next_start != null && (m.monitor_ids.some((id) => monitorIds.includes(id)) || m.system_ids.some((id) => systemIds.includes(id))),
	);

	const out: PublicPage = {
		page: {
			slug: page.slug,
			title: page.title,
			description: page.description,
			logo_url: page.logo_url,
			footer_text: page.footer_text,
			show_uptime_bars: page.show_uptime_bars,
			show_latency: page.show_latency,
			show_tags: page.show_tags,
			accent_color: page.accent_color,
			custom_css: page.custom_css,
			// Default ON (later migration); a row from before the column existed counts as on.
			show_mobile_sparklines: ((row as PageRow & { show_mobile_sparklines?: number }).show_mobile_sparklines ?? 1) !== 0,
		},
		overall,
		groups,
		announcements: anns.results.map(toAnnouncement).map(({ id, title, body, severity, created_at, ends_at }) => ({ id, title, body, severity, created_at, ends_at })),
		maintenances: relevant
			.filter((m) => m.active || (m.next_start ?? 0) - now < 14 * 86_400_000)
			.map(({ id, title, description, starts_at, ends_at, active, next_start }) => ({ id, title, description, starts_at, ends_at, active, next_start })),
		incidents: incidents
			.filter((i) => i.resolved_at == null || i.started_at >= now - 14 * 86_400_000)
			.slice(0, 50)
			.map(({ id, monitor_id, name, started_at, resolved_at, cause }) => ({ id, name, started_at, resolved_at, cause: hiddenIds.has(monitor_id) && cause ? scrubAddresses(cause) : cause })),
		generated_at: now,
	};
	return hiddenTerms.size ? scrubTerms(out, [...hiddenTerms]) : out;
}

/** Hostname variants of a URL that must not appear on a page where its item has "Link to site" off. */
export function hostTerms(url: string | null | undefined): string[] {
	if (!url) return [];
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		host = url.replace(/^[a-z]+:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
	}
	if (!host) return [];
	const bare = host.replace(/^www\./, "");
	return [...new Set([url.split("?")[0], host, bare])].filter((t) => t.length >= 3);
}

/** Incident causes of a hidden-link monitor: drop any URL or host-looking token (DNS/TLS/redirect errors quote them). */
export function scrubAddresses(text: string): string {
	return text
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, "[address hidden]")
		.replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi, "[address hidden]");
}

/** Defense in depth: replace every occurrence of the hidden hosts in every string of the page payload. */
export function scrubTerms<T>(value: T, terms: string[]): T {
	const sorted = [...terms].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const re = new RegExp(sorted.join("|"), "gi");
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") return v.replace(re, "[address hidden]");
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(value) as T;
}

