import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLatency, decodeBucket, encodeBucket, HOUR, hourOf, LAT_SLOT_MS, type LatSlot } from "../src/worker/monitors/history";
import { fakeCtx, fakeD1 } from "./fake-env";

vi.mock("../src/worker/notify", () => ({ notify: vi.fn(async () => undefined) }));
vi.mock("../src/worker/seed", () => ({ seedOnce: vi.fn(async () => undefined) }));
vi.mock("../src/worker/beszel/keys", () => ({ getHubKey: vi.fn(async () => ({ publicSsh: "ssh-ed25519 test" })) }));
import { notify } from "../src/worker/notify";
import { MIGRATIONS } from "../src/worker/db";
import { Hub } from "../src/worker/hub";

describe("check buckets", () => {
	it("round-trips and carries messages forward", () => {
		const h = hourOf(Date.UTC(2026, 9, 30, 12, 30));
		const pts = [
			{ ts: h + 1000, status: 1 as const, latency_ms: 50, message: "OK" },
			{ ts: h + 61_000, status: 1 as const, latency_ms: 70, message: "OK" },
			{ ts: h + 121_000, status: 0 as const, latency_ms: null, message: "timeout" },
		];
		const enc = encodeBucket(h, pts);
		expect(JSON.parse(enc)[1]).toHaveLength(3); // repeated message omitted
		expect(decodeBucket(h, enc)).toEqual(pts);
		expect(decodeBucket(h, "not json")).toEqual([]);
	});
	it("decodes rows produced by the SQL migration (message always present)", () => {
		const h = 3 * HOUR;
		expect(decodeBucket(h, JSON.stringify([[5, 2, null, "late"], [1, 1, 10, "ok"]]))).toEqual([
			{ ts: h + 1, status: 1, latency_ms: 10, message: "ok" },
			{ ts: h + 5, status: 2, latency_ms: null, message: "late" },
		]);
	});
	it("averages latency per 15-minute slot and trims old slots", () => {
		expect(LAT_SLOT_MS).toBe(900_000);
		const s: LatSlot[] = [];
		addLatency(s, 0, 10, 0);
		addLatency(s, 60_000, 30, 0);
		addLatency(s, 900_000, 5, 0);
		expect(s).toEqual([
			[0, 40, 2],
			[900_000, 5, 1],
		]);
		addLatency(s, 1_800_000, 1, 900_000);
		expect(s.map((x) => x[0])).toEqual([900_000, 1_800_000]);
	});
	it("keeps slots ordered across the switch from 20-minute slots", () => {
		// Old layout's last slot started at :40 (2_400_000); samples at :40-:44 fall in the 15-minute
		// :30 slot, so they join the :40 slot until the :45 boundary.
		const s: LatSlot[] = [[1_200_000, 10, 1], [2_400_000, 10, 1]];
		addLatency(s, 2_500_000, 20, 0);
		addLatency(s, 2_700_000, 7, 0);
		expect(s).toEqual([
			[1_200_000, 10, 1],
			[2_400_000, 30, 2],
			[2_700_000, 7, 1],
		]);
	});
});

describe("Hub", () => {
	const T0 = Date.UTC(2026, 9, 30, 10, 0, 30);
	let d1: ReturnType<typeof fakeD1>;
	let dos: ReturnType<typeof fakeCtx>;
	let hubObj: Hub;
	const env = () => ({ DB: d1.db, PUBLIC_HOST: "status.test", DASHBOARD_HOST: "dash.test", SUBREQUEST_BUDGET: "40" }) as never;
	const make = () => new Hub(dos.ctx as never, env());
	const mon = () => d1.sql.prepare("SELECT status, fail_streak, last_ping_at FROM monitors WHERE id = 'hb'").get() as Record<string, unknown>;
	const incidents = () => d1.sql.prepare("SELECT started_at, resolved_at FROM incidents WHERE monitor_id = 'hb'").all() as Record<string, unknown>[];

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		vi.mocked(notify).mockClear();
		d1 = fakeD1();
		dos = fakeCtx();
		// ensureSchema migrates once per isolate; give every fresh fake D1 the full schema directly.
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
		hubObj = make();
		// Run the migrations once so the tables exist, then add a heartbeat monitor.
		await hubObj.view();
		d1.sql
			.prepare(
				`INSERT INTO monitors(id, name, type, config, interval_s, retries, retry_interval_s, timeout_ms, push_token, next_check_at, created_at, status)
				 VALUES ('hb', 'Backup', 'heartbeat', '{"period_s":60,"grace_s":120}', 60, 0, 60, 10000, 'tok', ?, ?, 'pending')`,
			)
			.run(T0, T0 - 86_400_000);
		await hubObj.reload({ reseed: true });
	});
	afterEach(() => vi.useRealTimers());

	it("daily retention drops notification log entries older than 90 days", async () => {
		const DAY = 86_400_000;
		const ins = d1.sql.prepare("INSERT INTO notification_log(ts, channel_name, channel_type, title, body, status, target_kind, target_name, ok) VALUES (?, 'c', 'discord', ?, '', 'info', 'test', 'R', 1)");
		ins.run(T0 - 91 * DAY, "old");
		ins.run(T0 - 89 * DAY, "kept");
		(hubObj as unknown as { S: { retention: string | null } }).S.retention = null;
		await (hubObj as unknown as { retention(now: number): Promise<void> }).retention(T0);
		expect(d1.sql.prepare("SELECT title FROM notification_log").all()).toEqual([{ title: "kept" }]);
	});

	const minute = async (n: number, ping = false) => {
		for (let i = 0; i < n; i++) {
			vi.advanceTimersByTime(60_000);
			if (ping) expect((await hubObj.ping("tok", "ok", true, null, null)).status).toBe(200);
			await hubObj.tick(Date.now());
		}
	};

	it("rejects unknown tokens without touching D1", async () => {
		const w = d1.stats.writes;
		expect((await hubObj.ping("nope", "ok", true, null, null)).status).toBe(404);
		expect(d1.stats.writes).toBe(w);
	});

	it("goes up, down and up again with one notification and one incident per transition", async () => {
		await minute(3, true);
		expect((await hubObj.monitorState("hb"))?.live?.status).toBe("up");
		const writesWhileUp = d1.stats.writes;
		await minute(10, true);
		// Steady pings: nothing written to D1 until the hourly flush.
		expect(d1.stats.writes - writesWhileUp).toBe(0);

		await minute(8); // no pings: late, then down
		expect((await hubObj.monitorState("hb"))?.live?.status).toBe("down");
		expect(mon().status).toBe("down"); // status changes are flushed to D1 immediately
		expect(incidents()).toHaveLength(1);
		expect(incidents()[0].resolved_at).toBeNull();
		const downs = vi.mocked(notify).mock.calls.filter((c) => (c[2] as { status: string }).status === "down");
		expect(downs).toHaveLength(1);

		await minute(2, true);
		expect(mon().status).toBe("up");
		expect(incidents()[0].resolved_at).not.toBeNull();
		const ups = vi.mocked(notify).mock.calls.filter((c) => (c[2] as { status: string }).status === "up");
		expect(ups).toHaveLength(1);
	});

	it("drops an outbox entry D1 rejects instead of blocking every later write", async () => {
		await minute(3, true);
		// A replayed incident INSERT whose row already exists (the batch wrote it, the snapshot did not see that).
		d1.sql.prepare("INSERT INTO incidents(id, monitor_id, started_at, cause) VALUES ('dup', 'hb', ?, 'old')").run(T0);
		const S = (hubObj as unknown as { S: { outbox: Record<string, { sql: string; params: unknown[] }> } }).S;
		S.outbox["i:hb:1:0"] = { sql: "INSERT INTO incidents(id, monitor_id, started_at, cause) VALUES (?, ?, ?, ?)", params: ["dup", "hb", T0, "old"] };
		await minute(8); // goes down: this flush hits the bad entry
		expect(mon().status).toBe("down");
		expect(Object.keys(S.outbox).filter((k) => k.startsWith("i:hb:1:"))).toHaveLength(0);
		await minute(2, true);
		expect(mon().status).toBe("up");
		expect(incidents().every((i) => i.resolved_at != null)).toBe(true);
	});

	it("closes incidents left open on a monitor that is up at the hourly roll", async () => {
		await minute(3, true);
		d1.sql.prepare("INSERT INTO incidents(id, monitor_id, started_at, cause) VALUES ('stale', 'hb', ?, 'HTTP 404')").run(T0);
		// An incident whose monitor row was deleted straight from D1.
		d1.sql.prepare("INSERT INTO incidents(id, monitor_id, started_at, cause) VALUES ('orphan', 'gone', ?, 'HTTP 404')").run(T0);
		expect(incidents()[0].resolved_at).toBeNull();
		await minute(60, true);
		expect(incidents()[0].resolved_at).not.toBeNull();
		expect(d1.sql.prepare("SELECT resolved_at FROM incidents WHERE id = 'orphan'").get()).not.toEqual({ resolved_at: null });
	});

	it("checkNow runs a monitor immediately, records it, and leaves paused monitors alone", async () => {
		d1.sql.prepare("INSERT INTO systems(id, name, token, status, created_at) VALUES ('s1', 'box', 't1', 'down', ?)").run(T0);
		const ins = d1.sql.prepare(
			`INSERT INTO monitors(id, name, type, config, interval_s, retries, retry_interval_s, timeout_ms, next_check_at, created_at, status, paused)
			 VALUES (?, ?, 'system', '{"system_id":"s1"}', 600, 0, 60, 10000, ?, ?, 'pending', ?)`,
		);
		ins.run("sm", "box agent", T0, T0, 0);
		ins.run("sp", "box paused", T0, T0, 1);
		await hubObj.reload({});
		await minute(1);
		expect((await hubObj.monitorState("sm")).live?.status).toBe("down");
		// The agent is back; the next scheduled check is 10 minutes away, "Check now" doesn't wait for it.
		d1.sql.prepare("UPDATE systems SET status = 'up' WHERE id = 's1'").run();
		vi.advanceTimersByTime(5_000);
		const r = await hubObj.checkNow(["sm", "sp"]);
		expect(r.checked).toBe(1);
		expect(r.live.sm.status).toBe("up");
		expect(r.live.sm.last_check_at).toBe(Date.now());
		expect(r.live.sp.last_check_at).toBeNull();
		expect(d1.sql.prepare("SELECT status FROM monitors WHERE id = 'sm'").get()).toEqual({ status: "up" });
		expect(d1.sql.prepare("SELECT resolved_at FROM incidents WHERE monitor_id = 'sm'").get()).not.toEqual({ resolved_at: null });
		expect((await hubObj.checks("sm", T0)).map((p) => p.status)).toEqual([0, 1]);
	});

	it("survives a restart from DO storage and flushes history hourly", async () => {
		await minute(5, true);
		hubObj = make(); // new isolate: state comes back from storage, not D1
		await minute(1, true);
		expect((await hubObj.monitorState("hb"))?.live?.status).toBe("up");
		await minute(60, true);
		const buckets = d1.sql.prepare("SELECT hour, data FROM check_buckets WHERE monitor_id = 'hb'").all() as { hour: number; data: string }[];
		expect(buckets.length).toBeGreaterThanOrEqual(1);
		const daily = d1.sql.prepare("SELECT up, down FROM monitor_daily WHERE monitor_id = 'hb'").get() as { up: number; down: number };
		expect(daily.up).toBeGreaterThan(50);
		expect(daily.down).toBe(0);
		// /checks: closed hours from D1 + current hour from the Hub, in order.
		const pts = await hubObj.checks("hb", T0);
		expect(pts.length).toBeGreaterThan(0);
		expect(pts.every((p, i) => i === 0 || p.ts >= pts[i - 1].ts)).toBe(true);
	});

	it("keeps D1 writes per hour tiny for a steady monitor", async () => {
		await minute(3, true);
		const w = d1.stats.writes;
		await minute(120, true);
		expect(d1.stats.writes - w).toBeLessThan(20);
	});

	it("snapshots DO state every 5 minutes, but immediately on a status change", async () => {
		d1.sql.prepare(`UPDATE monitors SET config = '{"period_s":300,"grace_s":300}' WHERE id = 'hb'`).run();
		await hubObj.reload({ reseed: true });
		await minute(3, true);
		const p = dos.stats.puts;
		await minute(60, true);
		// 60 ticks + 60 pings: a ping save every ~4 minutes + 1 hour roll (+ daily hist), not 120.
		expect(dos.stats.puts - p).toBeLessThanOrEqual(20);
		await minute(11); // goes down
		hubObj = make(); // evicted right after: the down status must already be in storage
		expect((await hubObj.monitorState("hb"))?.live?.status).toBe("down");
		await minute(1);
		expect(vi.mocked(notify).mock.calls.filter((c) => (c[2] as { status: string }).status === "down")).toHaveLength(1);
	});

	it("stays up across hibernation between every request (state restarts from the snapshot)", async () => {
		// Probe: pings every 60 s, configured 300 s + 300 s grace. Fast: 60 s + 120 s. Hourly: hourly, 1 day period.
		d1.sql.prepare(`UPDATE monitors SET config = '{"period_s":300,"grace_s":300}' WHERE id = 'hb'`).run();
		for (const [id, cfg, tok] of [
			["fast", '{"period_s":60,"grace_s":120}', "ftok"],
			["hourly", '{"period_s":86400,"grace_s":3600}', "rtok"],
		])
			d1.sql
				.prepare(
					`INSERT INTO monitors(id, name, type, config, interval_s, retries, retry_interval_s, timeout_ms, push_token, next_check_at, created_at, status)
					 VALUES (?, ?, 'heartbeat', ?, 300, 0, 60, 10000, ?, ?, ?, 'pending')`,
				)
				.run(id, id, cfg, tok, T0, T0 - 86_400_000);
		await hubObj.reload({ reseed: true });
		const fresh = () => (hubObj = make()); // the real Hub is evicted ~10 s after each request
		const run = async (minutes: number) => {
			for (let i = 0; i < minutes; i++) {
				const base = Date.now();
				vi.setSystemTime(base + 1_000);
				await fresh().ping("ftok", "ok", true, null, null);
				if (i % 60 === 0) await fresh().ping("rtok", "ok", true, null, null);
				vi.setSystemTime(base + 7_000);
				await fresh().tick(Date.now());
				vi.setSystemTime(base + 30_000);
				await fresh().ping("tok", "ok", true, null, null);
				vi.setSystemTime(base + 60_000);
			}
		};
		await run(5);
		const p = dos.stats.puts;
		const since = Date.now();
		vi.mocked(notify).mockClear();
		await run(120);
		const v = await fresh().view();
		for (const id of ["hb", "fast", "hourly"]) {
			expect(v.live[id].status).toBe("up");
			expect((v.recent[id] ?? []).filter((x) => x.ts > since && x.status !== 1)).toEqual([]);
			expect(Date.now() - v.live[id].last_ping_at!).toBeLessThan(id === "hourly" ? 61 * 60_000 : 5 * 60_000); // dashboards stay fresh
		}
		expect(vi.mocked(notify).mock.calls.filter((c) => (c[2] as { status: string }).status !== "up")).toEqual([]);
		// fast saves on every ping (its period is the ping interval); Probe every ~3 minutes; Hourly per ping.
		expect(dos.stats.puts - p).toBeLessThanOrEqual(120 + 45 + 2 + 10);
		// Probe really does go late, then down, when its pings stop.
		for (let i = 0; i < 11; i++) {
			vi.advanceTimersByTime(60_000);
			await fresh().ping("ftok", "ok", true, null, null);
			await fresh().tick(Date.now());
		}
		expect((await fresh().monitorState("hb"))?.live?.status).toBe("down");
		expect((await fresh().monitorState("fast"))?.live?.status).toBe("up");
	});

	it("evaluates heartbeats every tick: fresh last check, Late and Down on time, even with retries and evictions", async () => {
		// "hb": pings every 60 s, 60 s + 600 s grace, but a leftover (hidden) 300 s check interval. Probe-like twin with 1 retry.
		d1.sql.prepare(`UPDATE monitors SET config = '{"period_s":60,"grace_s":600}', interval_s = 300 WHERE id = 'hb'`).run();
		d1.sql
			.prepare(
				`INSERT INTO monitors(id, name, type, config, interval_s, retries, retry_interval_s, timeout_ms, push_token, next_check_at, created_at, status)
				 VALUES ('probe', 'Probe', 'heartbeat', '{"period_s":60,"grace_s":300}', 60, 1, 60, 10000, 'ctok', ?, ?, 'pending')`,
			)
			.run(T0, T0 - 86_400_000);
		await hubObj.reload({ reseed: true });
		const fresh = () => (hubObj = make()); // evicted between every request
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(60_000);
			await fresh().ping("tok", "ok", true, null, null);
			await fresh().ping("ctok", "ok", true, null, null);
			await fresh().tick(Date.now());
		}
		const lastPing = Date.now();
		const p = dos.stats.puts;
		const seen: string[] = [];
		for (let i = 1; i <= 13; i++) {
			vi.advanceTimersByTime(60_000);
			await hubObj.tick(Date.now()); // same instance: "Last check" must be this tick
			const l = (await hubObj.monitorState("hb")).live!;
			expect(l.last_check_at).toBe(Date.now());
			seen.push(`${i}:${l.status}`);
			fresh(); // and the next tick starts from storage
		}
		// Late from the first tick past the 60 s period, down from the first tick past 11 min.
		expect(seen.slice(0, 2)).toEqual(["1:up", "2:degraded"]);
		expect(seen.slice(9, 13)).toEqual(["10:degraded", "11:degraded", "12:down", "13:down"]);
		expect(Date.now() - lastPing).toBe(13 * 60_000);
		expect((await fresh().monitorState("probe")).live?.status).toBe("down");
		expect(incidents()).toHaveLength(1);
		// Only status changes and retry steps were saved, not every heartbeat tick.
		expect(dos.stats.puts - p).toBeLessThanOrEqual(8);
	});

	it("adds 90-day system uptime bars to the public page only when the page opts in", async () => {
		const yday = new Date(T0 - 86_400_000).toISOString().slice(0, 10);
		d1.sql.prepare("INSERT INTO systems(id, name, token, status, created_at) VALUES ('sys', 'Server', 'stok', 'up', ?)").run(T0 - 5 * 86_400_000);
		d1.sql.prepare("INSERT INTO system_daily(system_id, day, up, down, maint, outages) VALUES ('sys', ?, 1380, 60, 0, 1)").run(yday);
		d1.sql
			.prepare(
				`INSERT INTO status_pages(id, slug, title, layout, show_system_uptime, is_default, created_at) VALUES ('p', 'main', 'Status', ?, 1, 1, ?)`,
			)
			.run(JSON.stringify([{ name: "Infrastructure", items: [{ kind: "system", id: "sys" }] }]), T0);
		await minute(3, true);
		const item = async () => {
			const page = JSON.parse((await hubObj.publicPage("status.test", "main"))!);
			return page.groups[0].items[0] as { bars: { day: string; uptime: number | null; incidents: number }[]; uptime_90d: number | null };
		};
		const on = await item();
		expect(on.bars).toHaveLength(90);
		const y = on.bars[88];
		expect(y.day).toBe(yday);
		expect(y.uptime).toBeCloseTo(100 - (100 * 60) / 1440, 5);
		expect(y.incidents).toBe(1);
		expect(on.bars[89].uptime).toBe(100); // today, from the Hub's live minutes
		expect(on.bars[0].uptime).toBeNull(); // no data
		expect(on.uptime_90d).toBeGreaterThan(95);
		expect(on.uptime_90d).toBeLessThan(100);

		d1.sql.prepare("UPDATE status_pages SET show_system_uptime = 0").run();
		vi.advanceTimersByTime(61_000);
		const off = await item();
		expect(off.bars).toEqual([]);
		expect(off.uptime_90d).toBeNull();
	});
	it("folds polled CPU % into a 24 h public sparkline without extra storage writes, behind show_system_cpu", async () => {
		d1.sql.prepare("INSERT INTO systems(id, name, token, status, created_at) VALUES ('sys', 'Server', 'stok', 'up', ?)").run(T0 - 86_400_000);
		d1.sql
			.prepare(`INSERT INTO status_pages(id, slug, title, layout, is_default, created_at) VALUES ('p', 'main', 'Status', ?, 1, ?)`)
			.run(JSON.stringify([{ name: "Infrastructure", items: [{ kind: "system", id: "sys" }] }]), T0);
		for (let i = 0; i < 90; i++) {
			vi.advanceTimersByTime(60_000);
			await hubObj.tick(Date.now(), { sys: 10 + (i % 3) * 10, gone: 50 });
		}
		hubObj = make(); // the series must survive a restart from the snapshot
		const item = async () => {
			const page = JSON.parse((await hubObj.publicPage("status.test", "main"))!);
			return page.groups[0].items[0] as { cpu?: { ts: number; pct: number }[]; cpu_now?: number | null };
		};
		const on = await item();
		expect(on.cpu!.length).toBeGreaterThanOrEqual(4);
		expect(on.cpu!.length).toBeLessThanOrEqual(73);
		for (const p of on.cpu!) expect(p.pct).toBeGreaterThanOrEqual(10), expect(p.pct).toBeLessThanOrEqual(30);
		expect([10, 20, 30]).toContain(on.cpu_now);

		d1.sql.prepare("UPDATE status_pages SET show_system_cpu = 0").run();
		vi.advanceTimersByTime(61_000);
		const off = await item();
		expect(off.cpu).toBeUndefined();
		expect(off.cpu_now).toBeUndefined();
	});

	it("Link to site off: no link and the site's address appears nowhere in the public payload", async () => {
		const SECRET = "hidden-site.example";
		d1.sql
			.prepare(
				`INSERT INTO monitors(id, name, type, config, interval_s, retries, retry_interval_s, timeout_ms, push_token, next_check_at, created_at, status, tags)
				 VALUES ('web', 'Private site', 'http', ?, 60, 0, 60, 10000, NULL, ?, ?, 'up', ?)`,
			)
			.run(JSON.stringify({ url: `https://www.${SECRET}/play?x=1` }), T0, T0 - 86_400_000, JSON.stringify([`www.${SECRET}`]));
		d1.sql
			.prepare("INSERT INTO incidents(id, monitor_id, started_at, resolved_at, cause) VALUES ('i1', 'web', ?, NULL, ?)")
			.run(T0 - 60_000, `getaddrinfo ENOTFOUND www.${SECRET.toUpperCase()} (https://www.${SECRET}/play)`);
		const layout = (link?: boolean) => JSON.stringify([{ name: "Sites", items: [{ kind: "monitor", id: "web", ...(link === undefined ? {} : { link }) }] }]);
		d1.sql
			.prepare(`INSERT INTO status_pages(id, slug, title, layout, show_tags, is_default, published, created_at) VALUES ('p', 'main', 'Status', ?, 1, 1, 1, ?)`)
			.run(layout(false), T0);
		d1.sql
			.prepare(`INSERT INTO status_pages(id, slug, title, layout, show_tags, is_default, published, created_at) VALUES ('q', 'other', 'Other', ?, 1, 0, 1, ?)`)
			.run(layout(), T0);
		await hubObj.reload({ reseed: true });
		const raw = (await hubObj.publicPage("status.test", "main"))!;
		expect(raw.toLowerCase()).not.toContain("hidden-site");
		const page = JSON.parse(raw);
		const it0 = page.groups[0].items[0];
		expect(it0).toMatchObject({ id: "web", name: "Private site", status: "up", url: null });
		expect(it0.uptime_90d === null || typeof it0.uptime_90d === "number").toBe(true);
		expect(page.incidents).toHaveLength(1);
		expect(page.incidents[0].name).toBe("Private site");
		expect(page.incidents[0].cause).toContain("getaddrinfo ENOTFOUND");
		// Default (no flag, existing layouts) still links, query string stripped.
		const other = JSON.parse((await hubObj.publicPage("status.test", "other"))!);
		expect(other.groups[0].items[0].url).toBe(`https://www.${SECRET}/play`);
	});

	it("scrubs hidden hosts and address-looking tokens", async () => {
		const { hostTerms, scrubAddresses, scrubTerms } = await import("../src/worker/public-page");
		expect(hostTerms("https://www.a-b.example/x?y")).toEqual(["https://www.a-b.example/x", "www.a-b.example", "a-b.example"]);
		expect(hostTerms(null)).toEqual([]);
		expect(scrubAddresses("TLS error for foo.example.org: see http://x.y/z")).toBe("TLS error for [address hidden]: see [address hidden]");
		expect(scrubAddresses("timeout after 10000 ms")).toBe("timeout after 10000 ms");
		expect(scrubTerms({ a: ["Visit A-B.example now"], n: 3 }, ["a-b.example"])).toEqual({ a: ["Visit [address hidden] now"], n: 3 });
	});

	it("passes show_mobile_sparklines (default on, incl. existing rows) through the public page", async () => {
		d1.sql
			.prepare(`INSERT INTO status_pages(id, slug, title, layout, is_default, created_at) VALUES ('p', 'main', 'Status', '[]', 1, ?)`)
			.run(T0);
		const flag = async () => JSON.parse((await hubObj.publicPage("status.test", "main"))!).page.show_mobile_sparklines;
		expect(await flag()).toBe(true);
		d1.sql.prepare("UPDATE status_pages SET show_mobile_sparklines = 0").run();
		vi.advanceTimersByTime(61_000);
		expect(await flag()).toBe(false);
	});

	describe("status pages: Consider down after (dashboard and alerts keep the real status)", () => {
		const sysStatus = (st: string) => d1.sql.prepare("UPDATE systems SET status = ? WHERE id = 'sys'").run(st);
		const day = () => (hubObj as unknown as { S: { sysDaily: Record<string, { up: number; down: number; outages?: number }> } }).S.sysDaily.sys;
		const item = async () => {
			vi.advanceTimersByTime(61_000); // past the page cache
			await hubObj.tick(Date.now());
			const page = JSON.parse((await hubObj.publicPage("status.test", "main"))!);
			return page.groups[0].items[0] as { status: string };
		};
		const tickN = async (n: number) => {
			for (let i = 0; i < n; i++) {
				vi.advanceTimersByTime(60_000);
				await hubObj.tick(Date.now());
			}
		};
		beforeEach(() => {
			d1.sql.prepare("INSERT INTO systems(id, name, token, status, created_at, down_after) VALUES ('sys', 'Server', 'stok', 'up', ?, 300)").run(T0 - 86_400_000);
			d1.sql
				.prepare(`INSERT INTO status_pages(id, slug, title, layout, show_system_uptime, is_default, created_at) VALUES ('p', 'main', 'Status', ?, 1, 1, ?)`)
				.run(JSON.stringify([{ name: "Infrastructure", items: [{ kind: "system", id: "sys" }] }]), T0);
		});

		it("an outage shorter than down_after shows Up on the page and adds no down minutes or outage", async () => {
			await tickN(3);
			sysStatus("down");
			await tickN(1);
			expect((await item()).status).toBe("up"); // really down for ~2 min, page grace is 5
			await tickN(1);
			sysStatus("up");
			await tickN(3);
			expect(day().down).toBe(0);
			expect(day().outages ?? 0).toBe(0);
			expect(day().up).toBeGreaterThan(7);
		});

		it("a longer outage shows Down once it has lasted down_after; only the minutes after the grace count, one outage", async () => {
			await tickN(2);
			sysStatus("down");
			await tickN(1);
			const start = Date.now(); // the Hub saw it go down here
			await tickN(3);
			expect((await item()).status).toBe("up"); // ~4 min in
			await tickN(1);
			expect((await item()).status).toBe("down"); // >= 5 min
			await tickN(4);
			sysStatus("up");
			await tickN(1); // the Hub counts down until the sample that sees it up
			const downFor = Date.now() - start;
			expect(day().outages).toBe(1);
			expect(day().down).toBeCloseTo((downFor - 300_000) / 60_000, 5);
			expect((await item()).status).toBe("up");
		});

		it("rows at the old 10 s value act as the 1 minute minimum", async () => {
			d1.sql.prepare("UPDATE systems SET down_after = 10").run();
			await tickN(1);
			sysStatus("down");
			await tickN(1);
			await tickN(2);
			expect(day().outages).toBe(1);
			expect(day().down).toBeCloseTo(1, 5); // 2 min down minus the 1 min grace
		});
	});
});
