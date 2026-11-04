import type { Env } from "./env";

/** Ordered, idempotent migrations. Append only — never edit a shipped entry. */
export const MIGRATIONS: string[] = [
	`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'pending', info TEXT, details TEXT, agent_version TEXT,
  last_seen INTEGER, connected_at INTEGER, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_stats (system_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL,
  stats TEXT NOT NULL, PRIMARY KEY (system_id, type, created_at));
CREATE TABLE IF NOT EXISTS container_stats (system_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL,
  stats TEXT NOT NULL, PRIMARY KEY (system_id, type, created_at));
CREATE TABLE IF NOT EXISTS system_alerts (id TEXT PRIMARY KEY, system_id TEXT NOT NULL, metric TEXT NOT NULL,
  threshold REAL, minutes INTEGER NOT NULL DEFAULT 10, triggered INTEGER NOT NULL DEFAULT 0, last_value REAL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, parent_id TEXT,
  interval_s INTEGER NOT NULL DEFAULT 60, retries INTEGER NOT NULL DEFAULT 0, retry_interval_s INTEGER NOT NULL DEFAULT 60,
  timeout_ms INTEGER NOT NULL DEFAULT 10000, max_latency_ms INTEGER, upside_down INTEGER NOT NULL DEFAULT 0,
  resend_every INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, description TEXT,
  tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', fail_streak INTEGER NOT NULL DEFAULT 0,
  down_checks INTEGER NOT NULL DEFAULT 0, last_check_at INTEGER, next_check_at INTEGER, last_latency_ms INTEGER,
  last_message TEXT, push_token TEXT UNIQUE, last_ping_at INTEGER, run_started_at INTEGER,
  domain_expires_at INTEGER, warned_expiry INTEGER, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checks (monitor_id TEXT NOT NULL, ts INTEGER NOT NULL, status INTEGER NOT NULL,
  latency_ms INTEGER, message TEXT, PRIMARY KEY (monitor_id, ts));
CREATE TABLE IF NOT EXISTS monitor_daily (monitor_id TEXT NOT NULL, day TEXT NOT NULL, up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0, degraded INTEGER NOT NULL DEFAULT 0, maint INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0, latency_n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (monitor_id, day));
CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  resolved_at INTEGER, cause TEXT, last_notified_at INTEGER, reminders INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, apply_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS monitor_notifications (monitor_id TEXT NOT NULL, notification_id TEXT NOT NULL,
  PRIMARY KEY (monitor_id, notification_id));
CREATE TABLE IF NOT EXISTS system_notifications (system_id TEXT NOT NULL, notification_id TEXT NOT NULL,
  PRIMARY KEY (system_id, notification_id));
CREATE TABLE IF NOT EXISTS status_pages (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  description TEXT, logo_url TEXT, custom_domain TEXT UNIQUE, footer_text TEXT, layout TEXT NOT NULL DEFAULT '[]',
  show_uptime_bars INTEGER NOT NULL DEFAULT 1, show_latency INTEGER NOT NULL DEFAULT 1, show_tags INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0, accent_color TEXT, custom_css TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS maintenances (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, repeat TEXT, monitor_ids TEXT NOT NULL DEFAULT '[]',
  system_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, status_page_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info', pinned INTEGER NOT NULL DEFAULT 1, starts_at INTEGER, ends_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  ref_id TEXT, message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
CREATE INDEX IF NOT EXISTS idx_monitors_next ON monitors(next_check_at);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`,
	// Latest-only snapshots (no history). Rows are rewritten only when the content hash changes.
	`
CREATE TABLE IF NOT EXISTS system_packages (system_id TEXT PRIMARY KEY, manager TEXT, checked_at INTEGER,
  security_known INTEGER NOT NULL DEFAULT 0, packages TEXT NOT NULL DEFAULT '[]', hash TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_services (system_id TEXT PRIMARY KEY, services TEXT NOT NULL DEFAULT '[]', hash TEXT,
  updated_at INTEGER NOT NULL);
`,
	// Storage redesign: check history packed into one JSON row per monitor per hour, a per-system daily
	// up/down rollup, monitor_daily rebuilt WITHOUT ROWID (one write per upsert instead of two), and the
	// indexes nothing needs dropped. Live monitor state lives in the Hub Durable Object (hub.ts).
	`
CREATE TABLE IF NOT EXISTS check_buckets (monitor_id TEXT NOT NULL, hour INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (monitor_id, hour)) WITHOUT ROWID;
INSERT OR REPLACE INTO check_buckets(monitor_id, hour, data)
  SELECT monitor_id, h, json_group_array(json(s)) FROM (
    SELECT monitor_id, (ts / 3600000) * 3600000 h, json_array(ts % 3600000, status, latency_ms, message) s FROM checks ORDER BY monitor_id, ts
  ) GROUP BY monitor_id, h;
CREATE TABLE IF NOT EXISTS system_daily (system_id TEXT NOT NULL, day TEXT NOT NULL, up REAL NOT NULL DEFAULT 0,
  down REAL NOT NULL DEFAULT 0, maint REAL NOT NULL DEFAULT 0, PRIMARY KEY (system_id, day)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS monitor_daily_v3 (monitor_id TEXT NOT NULL, day TEXT NOT NULL, up REAL NOT NULL DEFAULT 0,
  down REAL NOT NULL DEFAULT 0, degraded REAL NOT NULL DEFAULT 0, maint REAL NOT NULL DEFAULT 0,
  latency_sum REAL NOT NULL DEFAULT 0, latency_n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (monitor_id, day)) WITHOUT ROWID;
INSERT OR REPLACE INTO monitor_daily_v3(monitor_id, day, up, down, degraded, maint, latency_sum, latency_n)
  SELECT monitor_id, day, up, down, degraded, maint, latency_sum, latency_n FROM monitor_daily;
DROP TABLE monitor_daily;
ALTER TABLE monitor_daily_v3 RENAME TO monitor_daily;
DROP INDEX IF EXISTS idx_checks_ts;
DROP INDEX IF EXISTS idx_monitors_next;
DROP INDEX IF EXISTS idx_events_ts;
DROP TABLE IF EXISTS checks
`,
	// Optional 90-day uptime bars for systems on status pages (off by default), with outage counts per day.
	`
ALTER TABLE status_pages ADD COLUMN show_system_uptime INTEGER NOT NULL DEFAULT 0;
ALTER TABLE system_daily ADD COLUMN outages INTEGER NOT NULL DEFAULT 0
`,
	// 24 h CPU sparkline for systems on status pages (on by default).
	`
ALTER TABLE status_pages ADD COLUMN show_system_cpu INTEGER NOT NULL DEFAULT 1
`,
	// Per-system "Consider down after" (seconds disconnected/silent before Down); 10 s = previous behavior.
	`
ALTER TABLE systems ADD COLUMN down_after INTEGER NOT NULL DEFAULT 10
`,
	// "Consider down after" now only affects status pages, in whole minutes (1 min minimum and default;
	// rows still at the column's old 10 s default are read as 60 s too, see pageGraceMs/toSystem).
	`
UPDATE systems SET down_after = 60 WHERE down_after < 60
`,
	// Log of every notification send (one row per channel per notification, incl. tests); 90 days.
	`
CREATE TABLE IF NOT EXISTS notification_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	channel_id TEXT,
	channel_name TEXT NOT NULL,
	channel_type TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	status TEXT NOT NULL,
	target_kind TEXT NOT NULL,
	target_id TEXT,
	target_name TEXT NOT NULL,
	ok INTEGER NOT NULL,
	error TEXT
);
CREATE INDEX IF NOT EXISTS notification_log_ts ON notification_log(ts)
`,
	// Dashboard users besides the owner (OWNER_EMAIL), mirrored into the Access app's managed policy.
	`
CREATE TABLE IF NOT EXISTS users (
	email TEXT PRIMARY KEY,
	role TEXT NOT NULL CHECK (role IN ('full', 'read')),
	added_by TEXT,
	created_at INTEGER NOT NULL
)
`,
	// Status pages: show sparklines on phones too, on their own row (on by default).
	`
ALTER TABLE status_pages ADD COLUMN show_mobile_sparklines INTEGER NOT NULL DEFAULT 1
`,
];

let migratedIsolate = false;

export async function ensureSchema(db: D1Database): Promise<void> {
	if (migratedIsolate) return;
	let version = 0;
	try {
		const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
		version = row ? Number(row.value) : 0;
	} catch {
		version = 0;
	}
	for (let i = version; i < MIGRATIONS.length; i++) {
		const stmts = MIGRATIONS[i]
			.split(";")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => db.prepare(s));
		// The version bump rides in the same batch (one transaction), so a migration is applied
		// exactly once even if the isolate dies right after it.
		stmts.push(
			db.prepare("INSERT INTO settings(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(i + 1)),
		);
		try {
			await db.batch(stmts);
		} catch (e) {
			// Another isolate may have migrated concurrently (its batch committed, ours then failed).
			const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>().catch(() => null);
			if (Number(row?.value ?? 0) > i) continue;
			throw e;
		}
	}
	migratedIsolate = true;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newId(len = 15): string {
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let out = "";
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return out;
}

export function newToken(len = 32): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let out = "";
	for (const b of bytes) out += chars[b % chars.length];
	return out;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.bind(key, value)
		.run();
}

export async function addEvent(db: D1Database, kind: string, refId: string | null, message: string): Promise<void> {
	await db.prepare("INSERT INTO events(ts, kind, ref_id, message) VALUES (?, ?, ?, ?)").bind(Date.now(), kind, refId, message).run();
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

export async function init(env: Env): Promise<void> {
	await ensureSchema(env.DB);
}
