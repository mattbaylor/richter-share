import { encode, decode } from "cborg";
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DT_CARRY_MS, dashboardTemp, decodeResponse, fingerprintRequest, getDataRequest, normalizeCombinedData } from "../src/worker/beszel/protocol";
import { sshPublicKey } from "../src/worker/beszel/keys";
import { nextState } from "../src/worker/monitors/state";
import { jsonPath, parseAcceptedCodes } from "../src/worker/monitors/checks";
import { occurrence } from "../src/worker/monitors/maintenance";
import { averageDeep } from "../src/worker/beszel/rollup";

describe("beszel protocol", () => {
	it("encodes HubRequest with integer keys", () => {
		const sig = new Uint8Array(64).fill(7);
		const m = decode(fingerprintRequest(sig, 5), { useMaps: true }) as Map<number, unknown>;
		expect(m.get(0)).toBe(1);
		expect(m.get(2)).toBe(5);
		const data = m.get(1) as Map<number, unknown>;
		expect(data.get(0)).toEqual(sig);
		expect(data.get(1)).toBe(false);
		const g = decode(getDataRequest(9, true), { useMaps: true }) as Map<number, unknown>;
		expect(g.get(0)).toBe(0);
		expect((g.get(1) as Map<number, unknown>).get(0)).toBe(60000);
	});

	it("decodes fingerprint + combined data responses", () => {
		const fp = encode(new Map<number, unknown>([[0, 3], [2, new Map<number, unknown>([[0, "abc123"]])]]));
		expect(decodeResponse(fp)).toMatchObject({ id: 3, fingerprint: { fingerprint: "abc123" } });

		const stats = new Map<number, unknown>([
			[0, 12.5], [4, 40], [9, 100], [10, 25], [11, 25], [26, [1000, 2000]], [28, [0.5, 0.4, 0.3]],
			[32, [10, 20]], [41, [8e9, 3.2e9, 1e9, 0]], [20, new Map([["cpu_thermal", 51.2]])], [34, new Uint8Array([10, 90])],
		]);
		const info = new Map<number, unknown>([[0, "host1"], [5, 3600], [6, 12.5], [7, 40], [8, 25], [10, "0.21.1"]]);
		const containers = [new Map<number, unknown>([[0, "nginx"], [1, 1.5], [2, 64], [9, [5, 6]], [5, 2], [6, "Up 2 hours"]])];
		const combined = new Map<number, unknown>([[0, stats], [1, info], [2, containers]]);
		const res = decodeResponse(encode(new Map<number, unknown>([[0, 4], [1, combined]])));
		const n = normalizeCombinedData(res.systemData!);
		expect(n.stats.cpu).toBe(12.5);
		expect(n.stats.mu).toBe(3.2e9);
		expect(n.stats.d).toBe(100 * 1024 ** 3);
		expect(n.stats.ns).toBe(1000);
		expect(n.stats.cpus).toEqual([10, 90]);
		expect(n.stats.t).toEqual({ cpu_thermal: 51.2 });
		expect(n.info.h).toBe("host1");
		expect(n.containers[0]).toMatchObject({ n: "nginx", c: 1.5, m: 64, ns: 5, nr: 6, h: 2 });
	});

	it("produces an OpenSSH ed25519 key whose signatures verify", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
		const ssh = sshPublicKey(raw);
		expect(ssh).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/);
		const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode("tok")));
		const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]), format: "der", type: "spki" });
		expect(verify(null, Buffer.from("tok"), pub, Buffer.from(sig))).toBe(true);
	});
});

describe("monitor state machine", () => {
	const base = { prev: "up" as const, fail_streak: 0, down_checks: 0, retries: 2, upside_down: false, max_latency_ms: 500, resend_every: 3 };
	const fail = { ok: false, latency_ms: null, message: "boom" };
	it("retries before going down", () => {
		const a = nextState(base, fail, false);
		expect(a).toMatchObject({ status: "up", retrying: true, transition: null });
		const b = nextState({ ...base, fail_streak: 2 }, fail, false);
		expect(b).toMatchObject({ status: "down", transition: "down" });
	});
	it("upside down inverts", () => {
		expect(nextState({ ...base, upside_down: true }, { ok: true, latency_ms: 5, message: "ok" }, false).retrying).toBe(true);
	});
	it("degraded when slow; recovery transition; reminders", () => {
		expect(nextState(base, { ok: true, latency_ms: 900, message: null }, false).status).toBe("degraded");
		expect(nextState({ ...base, prev: "down" }, { ok: true, latency_ms: 10, message: null }, false).transition).toBe("up");
		expect(nextState({ ...base, prev: "down", down_checks: 2 }, fail, false).reminder).toBe(true);
		expect(nextState(base, fail, true).status).toBe("maintenance");
	});
});

describe("helpers", () => {
	it("accepted codes", () => {
		const f = parseAcceptedCodes(["200-299", "301"]);
		expect([f(200), f(204), f(301), f(302), f(500)]).toEqual([true, true, true, false, false]);
	});
	it("json path", () => {
		expect(jsonPath({ a: { b: [{ c: "pass" }] } }, "$.a.b[0].c")).toBe("pass");
		expect(jsonPath({ a: 1 }, "$.x.y")).toBeUndefined();
	});
	it("repeating maintenance", () => {
		const start = Date.UTC(2026, 0, 1, 3);
		const end = start + 1800_000;
		const at = Date.UTC(2026, 4, 10, 3, 10);
		expect(occurrence(start, end, { every: "day", until: null }, at).active).toBe(true);
		expect(occurrence(start, end, { every: "day", until: null }, at + 3600_000).active).toBe(false);
		expect(occurrence(start, end, null, at).start).toBeNull();
	});
	it("averages nested stats", () => {
		expect(averageDeep([{ a: 1, t: { x: 2 }, la: [1, 2, 3] }, { a: 3, t: { x: 4 }, la: [3, 4, 5] }])).toEqual({ a: 2, t: { x: 3 }, la: [2, 3, 4] });
	});
});

describe("dashboardTemp", () => {
	const base = { cpu: 1, mp: 1, mt: 1, mu: 1, mb: 0, mz: 0, sw: 0, swu: 0, d: 1, du: 1, dp: 1, dr: 0, dw: 0, ns: 0, nr: 0 };
	it("keeps the agent's dt", () => {
		expect(dashboardTemp({ dt: 45 }, { ...base, t: { a: 70 } }, undefined, 1000)).toEqual({ dt: 45, at: 1000, src: "agent" });
	});
	it("falls back to the hottest sensor when dt is missing or 0 (macOS)", () => {
		expect(dashboardTemp({}, { ...base, t: { TC0P: 61.5, TG0P: 72.03, bad: 0 } }, undefined, 1000)).toEqual({ dt: 72.03, at: 1000, src: "sensors" });
		expect(dashboardTemp({ dt: 0 }, { ...base, t: { x: 50 } }, undefined, 1000).dt).toBe(50);
	});
	it("carries the last value briefly when a poll has no temperatures", () => {
		expect(dashboardTemp({}, base, { dt: 72, at: 1000 }, 1000 + DT_CARRY_MS)).toEqual({ dt: 72, at: 1000, src: "carried" });
		expect(dashboardTemp({}, base, { dt: 72, at: 1000 }, 1001 + DT_CARRY_MS)).toEqual({ src: "none" });
		expect(dashboardTemp({}, base, { dt: 72 }, 1000)).toEqual({ src: "none" });
	});
	it("leaves systems without sensors blank", () => {
		expect(dashboardTemp({}, base, undefined, 1000)).toEqual({ src: "none" });
	});
});
