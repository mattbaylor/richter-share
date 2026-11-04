import { encode } from "cborg";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConnection, PENDING_ALERT_KEY, WATCHDOG_MS } from "../src/worker/beszel/agent-do";
import { MIGRATIONS } from "../src/worker/db";
import { fakeD1 } from "./fake-env";

const sent = vi.hoisted(() => [] as { title: string; status: string }[]);
vi.mock("../src/worker/notify", () => ({ notify: async (_env: unknown, _t: unknown, m: { title: string; status: string }) => void sent.push({ title: m.title, status: m.status }) }));

/** DurableObjectState with KV + SQL storage, hibernatable sockets, and billed-row counters. */
function agentCtx() {
	const kv = new Map<string, unknown>();
	const sql = new DatabaseSync(":memory:");
	const sockets: FakeWs[] = [];
	const stats = { rowsWritten: 0, puts: [] as string[], alarms: 0 };
	let alarm: number | null = null;
	const clone = <T>(v: T): T => structuredClone(v);
	const ctx = {
		storage: {
			async get(k: string | string[]) {
				if (Array.isArray(k)) return new Map(k.filter((x) => kv.has(x)).map((x) => [x, clone(kv.get(x))]));
				return clone(kv.get(k));
			},
			async put(k: string | Record<string, unknown>, v?: unknown) {
				const e = typeof k === "string" ? [[k, v] as const] : Object.entries(k);
				for (const [a, b] of e) (kv.set(a, clone(b)), stats.rowsWritten++, stats.puts.push(a));
			},
			async delete(k: string | string[]) {
				for (const x of Array.isArray(k) ? k : [k]) if (kv.delete(x)) stats.rowsWritten++;
				return true;
			},
			async deleteAll() {
				kv.clear();
			},
			async setAlarm(t: number) {
				alarm = t;
				stats.alarms++;
				stats.rowsWritten++;
			},
			async getAlarm() {
				return alarm;
			},
			async deleteAlarm() {
				alarm = null;
			},
			sql: {
				exec(q: string, ...args: unknown[]) {
					const st = sql.prepare(q);
					const rows = /^\s*SELECT/i.test(q) ? (st.all(...(args as never[])) as unknown[]) : (st.run(...(args as never[])), []);
					return { toArray: () => rows };
				},
			},
		},
		getWebSockets: () => sockets.filter((s) => s.readyState !== 3),
		acceptWebSocket: (ws: FakeWs) => sockets.push(ws),
	};
	return { ctx, kv, sql, sockets, stats, clearAlarm: () => (alarm = null), alarmAt: () => alarm };
}

class FakeWs {
	readyState = 1;
	att: unknown = null;
	sent = 0;
	serializeAttachment(v: unknown) {
		const s = structuredClone(v);
		if (JSON.stringify(s, (_, x) => (x instanceof Uint8Array ? "x".repeat(x.byteLength) : x)).length > 16_384) throw new Error("attachment too large");
		this.att = s;
	}
	deserializeAttachment() {
		return structuredClone(this.att);
	}
	send() {
		this.sent++;
	}
	close() {
		this.readyState = 3;
	}
}

function dataMessage(cpu: number, withContainers = true): ArrayBuffer {
	const stats = new Map<number, unknown>([[0, cpu], [4, 40], [2, 8], [3, 3.2], [9, 100], [10, 40], [11, 40], [16, 1], [17, 2]]);
	const info = new Map<number, unknown>([[0, "host1"], [2, 4], [3, cpu]]);
	const containers = withContainers ? [new Map<number, unknown>([[0, "nginx"], [1, 1.5], [2, 64], [5, 2], [6, "Up 2 hours"]])] : [];
	const u8 = encode(new Map<number, unknown>([[0, 4], [1, new Map<number, unknown>([[0, stats], [1, info], [2, containers]])]]));
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function setup() {
	const f = agentCtx();
	const d1 = fakeD1();
	d1.sql.exec("CREATE TABLE systems (id TEXT PRIMARY KEY, name TEXT, token TEXT, fingerprint TEXT, status TEXT, details TEXT, info TEXT, last_seen INTEGER, agent_version TEXT, connected_at INTEGER, down_after INTEGER NOT NULL DEFAULT 10)");
	// Schema is current (ensureSchema in alarm() is then a no-op on this fake).
	d1.sql.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
	d1.sql.exec(`INSERT INTO settings VALUES ('schema_version', '${MIGRATIONS.length}')`);
	d1.sql.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, ref_id TEXT, message TEXT)");
	d1.sql.exec("CREATE TABLE system_alerts (id TEXT, system_id TEXT, metric TEXT, threshold REAL, minutes INTEGER, triggered INTEGER NOT NULL DEFAULT 0, last_value REAL, updated_at INTEGER)");
	d1.sql.exec("INSERT INTO systems (id, name, token, status, details, agent_version) VALUES ('sys1', 'box', 't', 'up', '{}', '0.18.0')");
	const agent = new AgentConnection(f.ctx as never, { DB: d1.db } as never);
	const ws = new FakeWs();
	ws.serializeAttachment({ systemId: "sys1", agentVersion: "0.18.0", verified: true, fpRequestId: 1, openedAt: Date.now() });
	f.sockets.push(ws);
	f.kv.set("systemId", "sys1");
	return { ...f, d1, agent, ws };
}

describe("AgentConnection storage", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-30T12:01:05Z"));
	});
	afterEach(() => vi.useRealTimers());

	it("buffers samples in the socket attachment and persists ~once per 10 minutes", async () => {
		const t = setup();
		const start = Date.now();
		for (let i = 0; i < 120; i++) {
			vi.setSystemTime(start + i * 60_000);
			await t.agent.poll(false);
			await t.agent.webSocketMessage(t.ws as never, dataMessage(i));
		}
		const hotWrites = t.stats.puts.filter((k) => k === "hot").length;
		// 2 hours: ~13 flushes (one per 10m boundary + the first), not 120.
		expect(hotWrites).toBeGreaterThanOrEqual(12);
		expect(hotWrites).toBeLessThanOrEqual(14);
		expect(t.stats.puts.filter((k) => k === "t:20m").length).toBeLessThanOrEqual(7);
		// Watchdog alarm: armed once (fake getAlarm keeps returning it), not every poll.
		expect(t.stats.alarms).toBe(1);
		expect(t.alarmAt()).toBe(start + WATCHDOG_MS);
		expect(t.stats.rowsWritten).toBeLessThan(30);
		expect(t.ws.sent).toBe(120);

		// Charts see persisted + buffered samples, same shape as before.
		const now = Date.now();
		const s1 = await t.agent.stats("s", "1m", now - 3600_000);
		expect(s1.length).toBe(61);
		expect((s1[s1.length - 1].stats as { cpu: number }).cpu).toBe(119);
		const c1 = await t.agent.stats("c", "1m", now - 3600_000);
		expect(c1.length).toBe(61);
		const t10 = await t.agent.stats("s", "10m", now - 12 * 3600_000);
		expect(t10.length).toBeGreaterThanOrEqual(10);
		const avg = (t10[1].stats as { cpu: number }).cpu;
		expect(avg).toBeGreaterThan(0);
		expect((await t.agent.stats("c", "20m", 0)).length).toBeGreaterThanOrEqual(4);
		expect((await t.agent.live()).last_seen).toBe(now);
		expect((await t.agent.latestContainers())?.created_at).toBe(now);
		// Attachment stays well under the 16 KiB limit.
		expect(((t.ws.att as { buf: Uint8Array }).buf?.byteLength ?? 0) < 10_000).toBe(true);
	});

	it("flushes buffered samples when the socket closes", async () => {
		const t = setup();
		const start = Date.now();
		for (let i = 0; i < 5; i++) {
			vi.setSystemTime(start + i * 60_000);
			await t.agent.webSocketMessage(t.ws as never, dataMessage(i));
		}
		const before = (t.kv.get("hot") as { s1: unknown[] }).s1.length;
		expect(before).toBe(1); // first message flushed (no due time yet), the rest buffered
		t.ws.readyState = 3;
		await t.agent.webSocketClose(t.ws as never, 1006, "gone");
		expect((t.kv.get("hot") as { s1: unknown[] }).s1.length).toBe(5);
		// A second close event writes nothing new.
		const w = t.stats.puts.length;
		await t.agent.webSocketClose(t.ws as never, 1006, "gone");
		expect(t.stats.puts.filter((k) => k === "hot").length).toBe(t.stats.puts.slice(0, w).filter((k) => k === "hot").length);
		// No socket: live() falls back to storage.
		expect((await t.agent.live()).last_seen).toBe(start + 4 * 60_000);
	});

	it("migrates the v1 layout (hot + c1 keys, SQLite tiers) once", async () => {
		const t = setup();
		const now = Date.now();
		t.sql.exec("CREATE TABLE stats (kind TEXT NOT NULL, type TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, type, ts)) WITHOUT ROWID");
		const ins = t.sql.prepare("INSERT INTO stats VALUES (?, ?, ?, ?)");
		for (let i = 1; i <= 3; i++) {
			ins.run("s", "10m", now - i * 600_000, JSON.stringify({ cpu: i }));
			ins.run("c", "10m", now - i * 600_000, JSON.stringify([{ n: "nginx" }]));
			ins.run("s", "120m", now - i * 7_200_000, JSON.stringify({ cpu: 10 + i }));
		}
		t.kv.set("hot", { info: { h: "old" }, last_seen: now - 30_000, d1_seen: 1, version: null, s1: [[now - 60_000, { cpu: 5 }]], rolled: { s10m: now - 600_000 }, retAt: 0 });
		t.kv.set("c1", [[now - 60_000, [{ n: "nginx" }]]]);
		t.ws.readyState = 3; // no live socket: reads come from storage

		const s10 = await t.agent.stats("s", "10m", 0);
		expect(s10.map((r) => (r.stats as { cpu: number }).cpu)).toEqual([3, 2, 1]);
		expect((await t.agent.stats("c", "10m", 0)).length).toBe(3);
		expect((await t.agent.stats("s", "120m", 0)).length).toBe(3);
		expect((await t.agent.stats("c", "1m", 0)).length).toBe(1);
		expect(await t.agent.live()).toEqual({ info: { h: "old" }, last_seen: now - 30_000 });
		expect(t.kv.has("c1")).toBe(false);
		expect((t.kv.get("hot") as { v: number }).v).toBe(2);
		expect(t.sql.prepare("SELECT name FROM sqlite_master WHERE name = 'stats'").all()).toEqual([]);

		// A fresh instance on the migrated storage does not migrate again.
		const w = t.stats.rowsWritten;
		const again = new AgentConnection(t.ctx as never, { DB: t.d1.db } as never);
		expect((await again.stats("s", "120m", 0)).length).toBe(3);
		expect(t.stats.rowsWritten).toBe(w);
	});

	it("poll() closes a silent agent and arms the down-grace alarm when nothing is connected", async () => {
		const t = setup();
		vi.setSystemTime(Date.now() + 101_000);
		await t.agent.poll(false);
		expect(t.ws.readyState).toBe(3);
		expect(t.alarmAt()).toBe(Date.now() + 10_000);
		t.clearAlarm();
		await t.agent.poll(false);
		expect(t.alarmAt()).toBe(Date.now() + 10_000);
	});

	it("falls back to alarm polling when the cron stops", async () => {
		const t = setup();
		const start = Date.now();
		await t.agent.poll(false);
		await t.agent.webSocketMessage(t.ws as never, dataMessage(1));
		// Watchdog fires while the cron is healthy: nothing happens.
		vi.setSystemTime(start + 60_000);
		await t.agent.poll(false);
		await t.agent.webSocketMessage(t.ws as never, dataMessage(2));
		t.clearAlarm();
		await t.agent.alarm();
		expect(t.alarmAt()).toBe(null);
		// Cron silent for 3 minutes (agent still sending): the alarm polls and re-arms every minute.
		vi.setSystemTime(start + 60_000 + 180_000);
		await t.agent.webSocketMessage(t.ws as never, dataMessage(3));
		const sent = t.ws.sent;
		await t.agent.alarm();
		expect(t.ws.sent).toBe(sent + 1);
		expect(t.alarmAt()).toBe(Date.now() + 60_000);
	});
	describe("Status alert (Beszel-like: DOWN after `minutes`, UP only if DOWN was sent)", () => {
		const status = (t: ReturnType<typeof setup>) => (t.d1.sql.prepare("SELECT status FROM systems WHERE id = 'sys1'").get() as { status: string }).status;
		const events = (t: ReturnType<typeof setup>) => (t.d1.sql.prepare("SELECT kind FROM events").all() as { kind: string }[]).map((e) => e.kind);
		const triggered = (t: ReturnType<typeof setup>) => (t.d1.sql.prepare("SELECT triggered FROM system_alerts WHERE metric = 'Status'").get() as { triggered: number }).triggered;
		const withAlert = (minutes: number) => {
			const t = setup();
			t.d1.sql.exec(`INSERT INTO system_alerts (id, system_id, metric, threshold, minutes) VALUES ('a1', 'sys1', 'Status', NULL, ${minutes})`);
			sent.length = 0;
			return t;
		};
		/** Socket closes, the 10 s grace alarm marks the system Down (the real state). Returns that time. */
		const goDown = async (t: ReturnType<typeof setup>) => {
			t.ws.readyState = 3;
			await t.agent.webSocketClose(t.ws as never, 1006, "gone");
			vi.setSystemTime(Date.now() + 10_000);
			await t.agent.alarm();
			return Date.now();
		};
		const reconnect = async (t: ReturnType<typeof setup>) => {
			const ws = new FakeWs();
			const att = { systemId: "sys1", agentVersion: "0.18.0", verified: false, fpRequestId: 1, openedAt: Date.now() };
			ws.serializeAttachment(att);
			t.sockets.push(ws);
			await (t.agent as unknown as { handleFingerprint(w: unknown, a: unknown, fp: string): Promise<void> }).handleFingerprint(ws, att, "fp");
			return ws;
		};

		it("the real state still flips after the 10 s grace, whatever the alert delay", async () => {
			const t = withAlert(10);
			const at = await goDown(t);
			expect(status(t)).toBe("down");
			expect(events(t)).toEqual(["system_down"]);
			expect(sent).toEqual([]);
			expect(t.kv.get(PENDING_ALERT_KEY)).toMatchObject({ id: "a1", due: at + 600_000, minutes: 10 });
			expect(t.alarmAt()).toBe(at + 600_000);
		});

		it("still down after `minutes`: sends DOWN once, then UP on reconnect", async () => {
			const t = withAlert(1);
			const at = await goDown(t);
			vi.setSystemTime(at + 60_000);
			await t.agent.alarm();
			expect(sent).toEqual([{ title: "🔴 box is DOWN", status: "down" }]);
			expect(triggered(t)).toBe(1);
			expect(t.kv.has(PENDING_ALERT_KEY)).toBe(false);
			await t.agent.alarm(); // a stray alarm sends nothing more
			expect(sent.length).toBe(1);
			vi.setSystemTime(at + 300_000);
			await reconnect(t);
			expect(status(t)).toBe("up");
			expect(sent.map((x) => x.status)).toEqual(["down", "up"]);
			expect(triggered(t)).toBe(0);
		});

		it("a flap inside the window sends nothing (no DOWN, no UP) but still logs the events", async () => {
			const t = withAlert(10);
			const at = await goDown(t);
			vi.setSystemTime(at + 120_000);
			await reconnect(t);
			expect(t.kv.has(PENDING_ALERT_KEY)).toBe(false);
			vi.setSystemTime(at + 600_000);
			await t.agent.alarm(); // the old due alarm finds a live socket
			expect(sent).toEqual([]);
			expect(events(t)).toEqual(["system_down", "system_up"]);
		});

		it("an early alarm re-arms for the due time; the pending alert survives a new instance (eviction)", async () => {
			const t = withAlert(5);
			const at = await goDown(t);
			vi.setSystemTime(at + 30_000);
			t.clearAlarm();
			const fresh = new AgentConnection(t.ctx as never, { DB: t.d1.db } as never);
			await fresh.alarm();
			expect(t.alarmAt()).toBe(at + 300_000);
			expect(sent).toEqual([]);
			vi.setSystemTime(at + 300_000);
			await fresh.alarm();
			expect(sent.map((x) => x.status)).toEqual(["down"]);
		});

		it("pausing (or removing the alert) during the window drops it", async () => {
			const t = withAlert(1);
			const at = await goDown(t);
			t.d1.sql.exec("UPDATE systems SET status = 'paused'");
			vi.setSystemTime(at + 60_000);
			await t.agent.alarm();
			expect(sent).toEqual([]);
			expect(t.kv.has(PENDING_ALERT_KEY)).toBe(false);

			const u = withAlert(1);
			const at2 = await goDown(u);
			u.d1.sql.exec("DELETE FROM system_alerts");
			vi.setSystemTime(at2 + 60_000);
			await u.agent.alarm();
			expect(sent).toEqual([]);
		});

		it("re-saving the alerts dialog (new row id) keeps the pending DOWN", async () => {
			const t = withAlert(1);
			const at = await goDown(t);
			t.d1.sql.exec("UPDATE system_alerts SET id = 'a2'");
			vi.setSystemTime(at + 60_000);
			await t.agent.alarm();
			expect(sent.map((x) => x.status)).toEqual(["down"]);
		});

		it("a verify-timeout close puts the pending alert's alarm back", async () => {
			const t = withAlert(5);
			const at = await goDown(t);
			const bad = new FakeWs();
			bad.serializeAttachment({ systemId: "sys1", verified: false, fpRequestId: 1, openedAt: at + 1000 });
			t.sockets.push(bad);
			vi.setSystemTime(at + 1000 + 60_000);
			await t.agent.alarm();
			expect(bad.readyState).toBe(3);
			expect(t.alarmAt()).toBe(at + 300_000);
		});

		it("no Status alert: nothing pending, nothing sent", async () => {
			const t = setup();
			sent.length = 0;
			await goDown(t);
			expect(t.kv.has(PENDING_ALERT_KEY)).toBe(false);
			expect(sent).toEqual([]);
			expect(events(t)).toEqual(["system_down"]);
		});
	});
});
