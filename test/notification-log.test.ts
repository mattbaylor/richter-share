import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

vi.mock("../src/worker/hub-client", () => ({ hub: vi.fn(), hubReload: vi.fn(async () => undefined), hubView: vi.fn() }));
import { MIGRATIONS } from "../src/worker/db";
import { notify } from "../src/worker/notify";
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
		for (let i = 0; i < 4; i++) await notify(env(), { systemId: "s1" }, { title: `n${i}`, body: "", status: "info", name: "web" });
		const get = async (q: string) => (await admin.request(`http://localhost/notification-log${q}`, {}, env())).json() as Promise<{ entries: { id: number; title: string; ok: boolean }[]; more: boolean }>;
		const p1 = await get("?limit=3");
		expect(p1.entries.map((e) => e.title)).toEqual(["n3", "n2", "n1"]);
		expect(p1.more).toBe(true);
		const p2 = await get(`?limit=3&before=${p1.entries[2].id}`);
		expect(p2.entries.map((e) => [e.title, e.ok])).toEqual([["n0", true], ["🔔 Richter test notification", false]]);
		expect(p2.more).toBe(false);
	});
});
