import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";
import { MIGRATIONS } from "../src/worker/db";
import { BATCH_WINDOW_MS, digest, flushBatches, notify } from "../src/worker/notify";

/** ntfy alerts are batched: one send per window, the rest go out as one digest from the cron. */
describe("ntfy batching", () => {
	let d1: ReturnType<typeof fakeD1>;
	let sends: { url: string; title: string | null; body: string }[];
	const env = () => ({ DB: d1.db }) as never;
	const log = () => d1.sql.prepare("SELECT channel_id, title, target_id, ok FROM notification_log ORDER BY id").all() as Record<string, unknown>[];
	const pending = () => (d1.sql.prepare("SELECT COUNT(*) n FROM notify_pending").get() as { n: number }).n;
	const down = (n: string) => ({ title: `🔴 ${n} is DOWN`, body: "timeout", status: "down" as const, name: n });
	const up = (n: string) => ({ title: `🟢 ${n} is UP`, body: "", status: "up" as const, name: n });

	beforeEach(() => {
		d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.exec(`INSERT INTO notifications(id, name, type, config, enabled, apply_default, created_at) VALUES
			('n', 'Phone', 'ntfy', '{"server":"https://ntfy.test","topic":"richter"}', 1, 0, 0),
			('d', 'Discord', 'discord', '{"webhook_url":"https://discord.test/hook"}', 1, 0, 0)`);
		for (const m of ["a", "b", "c"]) d1.sql.exec(`INSERT INTO monitor_notifications(monitor_id, notification_id) VALUES ('${m}', 'n'), ('${m}', 'd')`);
		sends = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				const h = new Headers(init.headers);
				sends.push({ url: String(url), title: h.get("Title"), body: String(init.body) });
				return new Response("ok");
			}),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	const ntfySends = () => sends.filter((s) => s.url.startsWith("https://ntfy.test"));

	it("sends the first alert at once and queues the burst behind it", async () => {
		const t = 1_000_000;
		await notify(env(), { monitorId: "a" }, down("A"), t);
		await notify(env(), { monitorId: "b" }, down("B"), t + 1000);
		await notify(env(), { monitorId: "c" }, down("C"), t + 2000);
		expect(ntfySends()).toHaveLength(1);
		expect(sends.filter((s) => s.url.includes("discord"))).toHaveLength(3); // other channels unchanged
		expect(pending()).toBe(2);
		// Too early: still inside the window.
		expect(await flushBatches(env(), t + 30_000)).toBe(0);
		expect(await flushBatches(env(), t + BATCH_WINDOW_MS)).toBe(1);
		expect(ntfySends()).toHaveLength(2);
		expect(ntfySends()[1].body).toBe("🔴 B is DOWN: timeout\n🔴 C is DOWN: timeout");
		expect(pending()).toBe(0);
		expect(log().filter((r) => r.channel_id === "n").map((r) => [r.target_id, r.ok])).toEqual([["a", 1], ["b", 1], ["c", 1]]);
	});

	it("keeps queueing while a digest is pending, even after the window passes", async () => {
		const t = 1_000_000;
		await notify(env(), { monitorId: "a" }, down("A"), t);
		await notify(env(), { monitorId: "b" }, down("B"), t + 1000);
		await notify(env(), { monitorId: "a" }, up("A"), t + BATCH_WINDOW_MS + 5000);
		expect(ntfySends()).toHaveLength(1);
		await flushBatches(env(), t + BATCH_WINDOW_MS + 10_000);
		expect(ntfySends()[1].body).toBe("🔴 B is DOWN: timeout\n🟢 A is UP");
	});

	it("sends a lone queued alert unchanged and a quiet channel immediately", async () => {
		const t = 1_000_000;
		await notify(env(), { monitorId: "a" }, down("A"), t);
		await notify(env(), { monitorId: "b" }, down("B"), t + 1000);
		await flushBatches(env(), t + BATCH_WINDOW_MS + 1000);
		expect(ntfySends()[1].body).toBe("timeout");
		await notify(env(), { monitorId: "c" }, up("C"), t + 3 * BATCH_WINDOW_MS);
		expect(ntfySends()).toHaveLength(3);
	});

	it("summarises a digest by status and caps its length", () => {
		const m = digest([down("A"), up("B"), down("C"), { title: "⚠️ D: CPU high", body: "95%", status: "warning", name: "D" }]);
		expect(m).toMatchObject({ title: "4 alerts (2 down, 1 warning, 1 up)", status: "down", name: "Richter" });
		const big = digest(Array.from({ length: 500 }, (_, i) => down(`monitor-${i}`)));
		expect(big.body.length).toBeLessThan(4000);
		expect(big.body).toMatch(/\.\.\.and \d+ more/);
	});
});
