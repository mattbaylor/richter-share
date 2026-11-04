import { getSetting, newId, newToken, setSetting } from "./db";
import type { Env } from "./env";

/** One-time demo data so a fresh deploy has something to show. Runs once, then never again. */
export async function seedOnce(env: Env): Promise<void> {
	const db = env.DB;
	if (await getSetting(db, "seeded")) return;
	await setSetting(db, "seeded", String(Date.now()));
	const hasData = await db.prepare("SELECT (SELECT COUNT(*) FROM monitors) + (SELECT COUNT(*) FROM status_pages) n").first<{ n: number }>();
	if (hasData && hasData.n > 0) return;

	const now = Date.now();
	const mk = (name: string, type: string, config: object, extra: { parent_id?: string; max_latency_ms?: number; interval_s?: number } = {}) => ({
		id: newId(),
		name,
		type,
		config: JSON.stringify(config),
		interval_s: 60,
		push_token: type === "heartbeat" ? newToken(32) : null,
		...extra,
	});
	const group = mk("Edge services", "group", {});
	const monitors = [
		mk("Cloudflare", "http", { url: "https://www.cloudflare.com/", keyword: "Cloudflare", accepted_codes: ["200-299"] }, { parent_id: group.id, max_latency_ms: 2000 }),
		mk("Example.com", "http", { url: "https://example.com/", accepted_codes: ["200-299"] }, { parent_id: group.id }),
		mk("GitHub status", "http", { url: "https://www.githubstatus.com/api/v2/status.json", json_path: "$.status.indicator", accepted_codes: ["200-299"] }),
		// Not 1.1.1.1: Workers sockets cannot connect to Cloudflare-owned IPs.
		mk("Google DNS (TCP 53)", "tcp", { host: "8.8.8.8", port: 53 }),
		mk("example.com A record", "dns", { name: "example.com", record_type: "A" }),
		mk("example.com registration", "domain", { domain: "example.com", warn_days: 30 }, { interval_s: 86400 }),
		mk("Nightly backup", "heartbeat", { period_s: 86400, grace_s: 3600 }, { interval_s: 60 }),
		group,
	];
	await db.batch(
		monitors.map((m, i) =>
			db
				.prepare(
					"INSERT INTO monitors(id, name, type, config, parent_id, interval_s, max_latency_ms, push_token, next_check_at, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(m.id, m.name, m.type, m.config, (m.parent_id as string) ?? null, m.interval_s, (m.max_latency_ms as number) ?? null, m.push_token, now + i * 2000, i, now),
		),
	);
	const layout = [
		{ name: "Websites", items: [monitors[0], monitors[1], monitors[2]].map((m) => ({ kind: "monitor", id: m.id })) },
		{ name: "Infrastructure", items: [monitors[3], monitors[4], monitors[5], monitors[6]].map((m) => ({ kind: "monitor", id: m.id })) },
	];
	await db
		.prepare(
			"INSERT INTO status_pages(id, slug, title, description, layout, is_default, published, footer_text, created_at) VALUES (?, 'main', 'Richter Status', ?, ?, 1, 1, ?, ?)",
		)
		.bind(newId(), "Live status of services monitored by Richter — running entirely on Cloudflare.", JSON.stringify(layout), "Demo deployment of Richter.", now)
		.run();
}
