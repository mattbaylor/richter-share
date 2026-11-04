import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

vi.mock("../src/worker/hub-client", () => ({ hub: vi.fn(), hubReload: vi.fn(async () => undefined), hubView: vi.fn() }));
vi.mock("../src/worker/notify", () => ({ notify: vi.fn(async () => undefined) }));
import { admin } from "../src/worker/routes/admin";
import { MIGRATIONS } from "../src/worker/db";

/** "All systems" alerts tab API (mirrors Beszel's /api/beszel/user-alerts). */
describe("bulk alerts", () => {
	let d1: ReturnType<typeof fakeD1>;
	const call = async (method: string, body: unknown) => {
		const r = await admin.request("http://localhost/alerts/bulk", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } }, { DB: d1.db } as never);
		expect(r.status).toBe(200);
		return r.json() as Promise<{ system_ids?: string[] }>;
	};
	const rows = () =>
		d1.sql.prepare("SELECT system_id, metric, threshold, minutes, triggered FROM system_alerts ORDER BY system_id, metric").all() as {
			system_id: string;
			metric: string;
			threshold: number | null;
			minutes: number;
			triggered: number;
		}[];

	beforeEach(() => {
		d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
		for (const id of ["a", "b", "c"]) d1.sql.prepare("INSERT INTO systems(id, name, token, status, created_at) VALUES (?, ?, ?, 'up', 0)").run(id, id, `t-${id}`);
		// a: Status 10 min (triggered), CPU 90; b: Status 1 min; c: nothing.
		d1.sql.exec(`INSERT INTO system_alerts(id, system_id, metric, threshold, minutes, triggered) VALUES
			('1', 'a', 'Status', NULL, 10, 1), ('2', 'a', 'CPU', 90, 5, 0), ('3', 'b', 'Status', NULL, 1, 0)`);
	});

	it("adds an alert only to systems lacking it, leaving existing ones and other alerts alone", async () => {
		const r = await call("POST", { metric: "Status", threshold: null, minutes: 5 });
		expect(r.system_ids).toEqual(["c"]);
		expect(rows().filter((x) => x.metric === "Status").map((x) => [x.system_id, x.minutes, x.triggered])).toEqual([
			["a", 10, 1],
			["b", 1, 0],
			["c", 5, 0],
		]);
		expect(rows().find((x) => x.metric === "CPU")).toMatchObject({ system_id: "a", threshold: 90 });
	});

	it("overwrite updates every system; an event alert keeps its state", async () => {
		const r = await call("POST", { metric: "Status", threshold: null, minutes: 3, overwrite: true });
		expect(r.system_ids).toEqual(["a", "b", "c"]);
		expect(rows().filter((x) => x.metric === "Status").map((x) => [x.system_id, x.minutes, x.triggered])).toEqual([
			["a", 3, 1],
			["b", 3, 0],
			["c", 3, 0],
		]);
	});

	it("a changed threshold resets a threshold alert's state; system_ids re-applies to exactly those", async () => {
		d1.sql.exec("UPDATE system_alerts SET triggered = 1 WHERE metric = 'CPU'");
		await call("POST", { metric: "CPU", threshold: 80, minutes: 5, system_ids: ["a"] });
		expect(rows().filter((x) => x.metric === "CPU")).toEqual([{ system_id: "a", metric: "CPU", threshold: 80, minutes: 5, triggered: 0 }]);
	});

	it("removing takes it off the given systems only, or off all of them", async () => {
		const r = await call("POST", { metric: "Status", threshold: null, minutes: 5 });
		await call("DELETE", { metric: "Status", system_ids: r.system_ids });
		expect(rows().filter((x) => x.metric === "Status").map((x) => x.system_id)).toEqual(["a", "b"]);
		await call("DELETE", { metric: "Status" });
		expect(rows().map((x) => x.metric)).toEqual(["CPU"]);
	});
});
