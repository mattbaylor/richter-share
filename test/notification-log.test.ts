import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

vi.mock("../src/worker/hub-client", () => ({ hub: vi.fn(), hubReload: vi.fn(async () => undefined), hubView: vi.fn() }));
import { MIGRATIONS } from "../src/worker/db";
import { BATCH_WINDOW_MS, combine, flushNotificationQueue, notify } from "../src/worker/notify";
import { admin } from "../src/worker/routes/admin";

/** Notification log: every send through notify() and every test send gets one row per channel. */
describe("notification log", () => {
	let d1: ReturnType<typeof fakeD1>;
	const env = () => ({ DB: d1.db, DASHBOARD_HOST: "dash.example" }) as never;
	const rows = () => d1.sql.prepare("SELECT * FROM notification_log ORDER BY id").all() as Record<string, unknown>[];

	beforeEach(() => {
		d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
		d1.sql.exec(`INSERT INTO notifications(id, name, type, config, enabled, apply_default, created_at) VALUES
			('d', 'Ops Discord', 'discord', '{"webhook_url":"https://discord.test/hook"}', 1, 0, 0),
			('p', 'Phone', 'pushover', '{"app_token":"a","user_key":"u"}', 1, 0, 0),
			('off', 'Disabled', 'slack', '{"webhook_url":"https://slack.test"}', 0, 0, 0)`);
		d1.sql.exec(`INSERT INTO monitor_notifications(monitor_id, notification_id) VALUES ('m1', 'd'), ('m1', 'p'), ('m1', 'off')`);
		d1.sql.exec(`INSERT INTO system_notifications(system_id, notification_id) VALUES ('s1', 'd')`);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => (String(url).includes("pushover") ? new Response('{"user":"invalid","status":0}', { status: 400 }) : new Response("ok"))),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("logs each enabled channel's result, with the HTTP error for failures", async () => {
		await notify(env(), { monitorId: "m1" }, { title: "🔴 API is DOWN", body: "HTTP 503", status: "down", name: "API" });
		const r = rows();
		expect(r).toHaveLength(2);
		const by = Object.fromEntries(r.map((x) => [x.channel_id, x]));
		expect(by.d).toMatchObject({ channel_name: "Ops Discord", channel_type: "discord", title: "🔴 API is DOWN", body: "HTTP 503", status: "down", target_kind: "monitor", target_id: "m1", target_name: "API", ok: 1, error: null });
		expect(by.p).toMatchObject({ channel_type: "pushover", ok: 0 });
		expect(String(by.p.error)).toMatch(/^HTTP 400: /);
	});

	it("logs system notifications and writes nothing when no channel is linked", async () => {
		await notify(env(), { systemId: "s1" }, { title: "🔴 web is DOWN", body: "x", status: "down", name: "web" });
		await notify(env(), { systemId: "nobody" }, { title: "t", body: "b", status: "info", name: "n" });
		expect(rows().map((x) => [x.target_kind, x.target_id, x.ok])).toEqual([["system", "s1", 1]]);
	});

	it("logs test sends and pages newest first with before/more", async () => {
		const t = await admin.request("http://localhost/notifications/p/test", { method: "POST" }, env());
		expect(await t.json()).toMatchObject({ ok: false });
		expect(rows()[0]).toMatchObject({ target_kind: "test", target_id: null, channel_id: "p", ok: 0 });
		for (let i = 0; i < 4; i++) await notify(env(), { systemId: "s1" }, { title: `n${i}`, body: "", status: "info", name: "web" }, 1e9 + i * BATCH_WINDOW_MS);
		const get = async (q: string) => (await admin.request(`http://localhost/notification-log${q}`, {}, env())).json() as Promise<{ entries: { id: number; title: string; ok: boolean }[]; more: boolean }>;
		const p1 = await get("?limit=3");
		expect(p1.entries.map((e) => e.title)).toEqual(["n3", "n2", "n1"]);
		expect(p1.more).toBe(true);
		const p2 = await get(`?limit=3&before=${p1.entries[2].id}`);
		expect(p2.entries.map((e) => [e.title, e.ok])).toEqual([["n0", true], ["🔔 Richter test notification", false]]);
		expect(p2.more).toBe(false);
	});

	describe("batching", () => {
		const queued = () => d1.sql.prepare("SELECT channel_id, title FROM notification_queue ORDER BY id").all();
		const fetched = () => vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes("discord"));
		const T = 2e9;

		it("sends the first alert now and queues the rest of the window, then flushes them as one message", async () => {
			await notify(env(), { systemId: "s1" }, { title: "🔴 a is DOWN", body: "gone", status: "down", name: "a" }, T);
			await notify(env(), { systemId: "s1" }, { title: "🔴 b is DOWN", body: "gone too", status: "down", name: "b" }, T + 100);
			await notify(env(), { systemId: "s1" }, { title: "🟢 c is UP", body: "", status: "up", name: "c" }, T + 200);
			expect(fetched()).toHaveLength(1);
			expect(queued()).toEqual([
				{ channel_id: "d", title: "🔴 b is DOWN" },
				{ channel_id: "d", title: "🟢 c is UP" },
			]);
			expect(rows()).toHaveLength(1);

			expect(await flushNotificationQueue(env(), T + 30_000)).toBe(2);
			expect(queued()).toEqual([]);
			expect(fetched()).toHaveLength(2);
			const sent = JSON.parse(String((fetched()[1][1] as RequestInit).body)).embeds[0];
			expect(sent.title).toBe("Richter: 2 alerts (1 down, 1 up)");
			expect(sent.description).toBe("🔴 b is DOWN: gone too\n🟢 c is UP");
			// One log row per alert, each with its own title and target.
			expect(rows().map((r) => [r.title, r.target_id, r.ok])).toEqual([
				["🔴 a is DOWN", "s1", 1],
				["🔴 b is DOWN", "s1", 1],
				["🟢 c is UP", "s1", 1],
			]);
			expect(await flushNotificationQueue(env(), T + 60_000)).toBe(0);
		});

		it("keeps queueing within the window after a flush, and sends again once the window has passed", async () => {
			await notify(env(), { systemId: "s1" }, { title: "x1", body: "", status: "down", name: "x" }, T);
			await notify(env(), { systemId: "s1" }, { title: "x2", body: "", status: "down", name: "x" }, T + 1);
			await flushNotificationQueue(env(), T + 10_000);
			await notify(env(), { systemId: "s1" }, { title: "x3", body: "", status: "down", name: "x" }, T + 20_000);
			expect(queued()).toHaveLength(1);
			await flushNotificationQueue(env(), T + 70_000);
			await notify(env(), { systemId: "s1" }, { title: "x4", body: "", status: "up", name: "x" }, T + 70_000 + BATCH_WINDOW_MS);
			expect(queued()).toHaveLength(0);
			expect(fetched()).toHaveLength(4);
		});

		it("windows are per channel", async () => {
			await notify(env(), { monitorId: "m1" }, { title: "m", body: "", status: "down", name: "m" }, T);
			await notify(env(), { systemId: "s1" }, { title: "s", body: "", status: "down", name: "s" }, T + 1);
			// m1 → discord + pushover sent; s1 → discord queued.
			expect(queued()).toEqual([{ channel_id: "d", title: "s" }]);
			expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]).includes("pushover"))).toHaveLength(1);
		});

		it("caps the combined body and says how many were left out", () => {
			const items = Array.from({ length: 40 }, (_, i) => ({
				id: i, ts: 0, channel_id: "p", title: `🔴 guest-${i} is DOWN`, body: "x".repeat(60), status: "down" as const, name: `g${i}`, url: null, target_kind: "system" as const, target_id: null,
			}));
			const m = combine(items, "pushover");
			expect(m.body.length).toBeLessThanOrEqual(1000);
			expect(m.body).toMatch(/…and \d+ more$/);
			expect(m.title).toBe("Richter: 40 alerts (40 down)");
			expect(combine(items.slice(0, 1), "ntfy").title).toBe("🔴 guest-0 is DOWN");
		});
	});
});
