import { encode } from "cborg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConnection } from "../src/worker/beszel/agent-do";
import { normalizeSmart, decodeResponse } from "../src/worker/beszel/protocol";
import { failingDisks, smartHash } from "../src/worker/beszel/smart";
import { evaluateSystemAlerts } from "../src/worker/beszel/alerts";
import { buildInstall } from "../src/shared/install";
import { MIGRATIONS } from "../src/worker/db";
import { fakeD1 } from "./fake-env";

const sent = vi.hoisted(() => [] as { title: string; body: string; status: string }[]);
vi.mock("../src/worker/notify", () => ({ notify: async (_env: unknown, _t: unknown, m: { title: string; body: string; status: string }) => void sent.push(m) }));

const attr = (id: number, name: string, value: number, threshold: number, raw: number, whenFailed?: string) =>
	new Map<number, unknown>([[0, id], [1, name], [2, value], [3, value], [4, threshold], [5, raw], ...(whenFailed ? ([[7, whenFailed]] as [number, unknown][]) : [])]);

const disk = (status: string, attrs: Map<number, unknown>[] = [], extra: [number, unknown][] = []) =>
	new Map<number, unknown>([[1, "WDC WD80EFZZ"], [2, "SN1"], [3, "81.00A81"], [4, 8_001_563_222_016], [5, status], [7, "sat"], [8, 34], [9, attrs], ...extra]);

const healthy = () => disk("PASSED", [attr(9, "Power_On_Hours", 60, 0, 31_200), attr(12, "Power_Cycle_Count", 100, 0, 41), attr(5, "Reallocated_Sector_Ct", 100, 5, 0)]);
const worn = () => disk("PASSED", [attr(5, "Reallocated_Sector_Ct", 98, 5, 24), attr(9, "Power_On_Hours", 60, 0, 31_198)]);
const dead = () => disk("FAILED", [attr(5, "Reallocated_Sector_Ct", 3, 5, 4000, "FAILING_NOW")]);

describe("normalizeSmart", () => {
	it("reads SmartDataResponse{0: devices, 1: complete} and flags the attributes that matter", () => {
		const r = normalizeSmart(new Map<number, unknown>([[0, new Map([["/dev/sda", healthy()], ["/dev/sdb", worn()], ["/dev/sdc", dead()]])], [1, true]]));
		expect(r.complete).toBe(true);
		const [a, b, c] = r.devices;
		expect(a).toMatchObject({ key: "/dev/sda", name: "/dev/sda", model: "WDC WD80EFZZ", status: "PASSED", temp: 34, hours: 31_200, cycles: 41, type: "sat", capacity: 8_001_563_222_016 });
		expect(a.flags).toBeUndefined(); // a zero reallocated count is not worth flagging
		expect(b.flags).toEqual([{ id: 5, name: "Reallocated_Sector_Ct", value: 98, threshold: 5, raw: 24, when_failed: undefined }]);
		expect(c.status).toBe("FAILED");
		expect(c.flags?.[0]).toMatchObject({ name: "Reallocated_Sector_Ct", when_failed: "FAILING_NOW" });
		expect(failingDisks(r.devices).map((d) => d.key)).toEqual(["/dev/sdc"]);
	});
	it("accepts older agents' bare {key: SmartData} map and the disk name field", () => {
		const r = normalizeSmart(new Map([["/dev/nvme0", disk("passed", [], [[6, "nvme0"]])]]));
		expect(r.complete).toBe(false);
		expect(r.devices[0]).toMatchObject({ key: "/dev/nvme0", name: "nvme0", status: "PASSED" });
		expect(normalizeSmart(undefined).devices).toEqual([]);
	});
	it("survives a real CBOR round trip through decodeResponse (uint64 raw values)", () => {
		const bytes = encode(new Map<number, unknown>([[0, 7], [7, new Map<number, unknown>([[0, new Map([["/dev/sda", disk("PASSED", [attr(241, "Total_LBAs_Written", 100, 0, 2 ** 40)])]])]])]]));
		const res = decodeResponse(bytes, "raw");
		expect(res.id).toBe(7);
		expect(normalizeSmart(res.payload).devices[0].status).toBe("PASSED");
	});
	it("the stored hash ignores temperature and power-on counters", () => {
		const a = normalizeSmart(new Map([["/dev/sda", healthy()]])).devices;
		const b = a.map((d) => ({ ...d, temp: 50, hours: (d.hours ?? 0) + 5 }));
		expect(smartHash(a)).toBe(smartHash(b));
		expect(smartHash(a)).not.toBe(smartHash([{ ...a[0], status: "FAILED" }]));
	});
});

describe("AgentConnection SMART", () => {
	beforeEach(() => {
		sent.length = 0;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
	});
	afterEach(() => vi.useRealTimers());

	function setup() {
		const kv = new Map<string, unknown>();
		const ctx = {
			storage: {
				get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => kv.has(x)).map((x) => [x, kv.get(x)])) : kv.get(k)),
				put: async (k: string | Record<string, unknown>, v?: unknown) => void (typeof k === "string" ? kv.set(k, v) : Object.entries(k).forEach(([a, b]) => kv.set(a, b))),
				delete: async () => true,
				getAlarm: async () => 1,
				setAlarm: async () => {},
				sql: { exec: () => ({ toArray: () => [] }) },
			},
			getWebSockets: () => [ws],
		};
		const ws = {
			readyState: 1,
			att: { systemId: "sys1", agentVersion: "0.21.1", verified: true, fpRequestId: 1, openedAt: Date.now() } as Record<string, unknown>,
			frames: [] as Uint8Array[],
			serializeAttachment(v: Record<string, unknown>) {
				this.att = structuredClone(v);
			},
			deserializeAttachment() {
				return structuredClone(this.att);
			},
			send(b: Uint8Array) {
				this.frames.push(b);
			},
		};
		const d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.exec(`INSERT OR REPLACE INTO settings VALUES ('schema_version', '${MIGRATIONS.length}')`);
		d1.sql.exec("INSERT INTO systems (id, name, token, status, details, agent_version, created_at) VALUES ('sys1', 'pve02', 't', 'up', '{}', '0.21.1', 0)");
		d1.sql.exec("INSERT INTO system_alerts (id, system_id, metric, threshold, minutes) VALUES ('a1', 'sys1', 'SmartFailed', NULL, 1)");
		const agent = new AgentConnection(ctx as never, { DB: d1.db } as never);
		return { agent, ws, d1 };
	}
	const msg = (m: Map<number, unknown>) => {
		const u8 = encode(m);
		return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
	};
	const data = () => msg(new Map<number, unknown>([[0, 1], [1, new Map<number, unknown>([[0, new Map<number, unknown>([[0, 5], [2, 8], [3, 3], [9, 100], [10, 40]])], [1, new Map<number, unknown>([[0, "pve02"]])], [2, []]])]]));
	const smartReply = (id: number, devices: [string, Map<number, unknown>][]) => msg(new Map<number, unknown>([[0, id], [7, new Map<number, unknown>([[0, new Map(devices)], [1, true]])]]));

	it("asks once per connection and hourly, stores the disks, and alerts on FAILED then recovery", async () => {
		const t = setup();
		await t.agent.webSocketMessage(t.ws as never, data());
		const req = t.ws.att.smartReq as { id: number };
		expect(req?.id).toBeGreaterThan(0);
		expect(t.ws.frames.length).toBe(1);
		await t.agent.webSocketMessage(t.ws as never, data()); // reply still outstanding: no second request
		expect(t.ws.frames.length).toBe(1);

		await t.agent.webSocketMessage(t.ws as never, smartReply(req.id, [["/dev/sda", healthy()], ["/dev/sdc", dead()]]));
		expect(t.ws.att.smartReq).toBeNull();
		const row = t.d1.sql.prepare("SELECT devices FROM system_smart WHERE system_id = 'sys1'").get() as { devices: string };
		expect(JSON.parse(row.devices).map((d: { status: string }) => d.status)).toEqual(["PASSED", "FAILED"]);
		expect(sent.map((m) => m.title)).toEqual(["Disk health problem on pve02 🔴"]);
		expect(sent[0].body).toContain("/dev/sdc (WDC WD80EFZZ): FAILED, Reallocated_Sector_Ct");

		vi.setSystemTime(Date.now() + 30 * 60_000);
		await t.agent.webSocketMessage(t.ws as never, data());
		expect(t.ws.frames.length).toBe(1); // not due yet
		vi.setSystemTime(Date.now() + 31 * 60_000);
		await t.agent.webSocketMessage(t.ws as never, data());
		expect(t.ws.frames.length).toBe(2);
		const req2 = t.ws.att.smartReq as { id: number };
		await t.agent.webSocketMessage(t.ws as never, smartReply(req2.id, [["/dev/sda", healthy()]]));
		expect(sent.map((m) => m.status)).toEqual(["down", "up"]);
	});

	it("an agent without smartctl access (no disks) leaves no row and sends nothing", async () => {
		const t = setup();
		await t.agent.webSocketMessage(t.ws as never, data());
		await t.agent.webSocketMessage(t.ws as never, smartReply((t.ws.att.smartReq as { id: number }).id, []));
		expect(t.d1.sql.prepare("SELECT COUNT(*) n FROM system_smart").get()).toEqual({ n: 0 });
		expect(sent).toEqual([]);
	});
});

describe("Steal alert", () => {
	beforeEach(() => (sent.length = 0));
	it("averages cpub[3] (steal) over the window", async () => {
		const d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.exec("INSERT INTO system_alerts (id, system_id, metric, threshold, minutes) VALUES ('s1', 'vm1', 'Steal', 10, 5)");
		const now = Date.now();
		const pts = Array.from({ length: 6 }, (_, i) => ({ at: now - (5 - i) * 60_000, s: { cpu: 50, cpub: [20, 5, 0, 25, 50, 0, 0, 0] } as never }));
		await evaluateSystemAlerts({ DB: d1.db } as never, "vm1", "web", undefined, async () => pts);
		expect(sent.map((m) => m.status)).toEqual(["warning"]);
		expect(sent[0].title).toMatch(/Steal/);
	});
});

describe("Proxmox install command", () => {
	it("gives the agent smartctl access before installing richter-pve", () => {
		const c = buildInstall("https://status.example.com", "tok", "ssh-ed25519 K").proxmox;
		expect(c).toContain("AmbientCapabilities=CAP_SYS_RAWIO CAP_SYS_ADMIN");
		expect(c).toContain("SupplementaryGroups=disk");
		expect(c).toContain('KERNEL=="nvme[0-9]*", GROUP="disk", MODE="0660"');
		expect(c.indexOf("smart.conf")).toBeLessThan(c.indexOf("richter-pve.sh install"));
		expect(c).not.toContain("sudo");
	});
});
