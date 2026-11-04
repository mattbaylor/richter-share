import { encode } from "cborg";
import { describe, expect, it, vi } from "vitest";
import { decodeResponse, normalizeCombinedData, normalizePackageUpdates, packageUpdatesRequest } from "../src/worker/beszel/protocol";
import {
	type AlertRow,
	evaluatePackageAlert,
	evaluatePackageAlerts,
	evaluateSystemdAlerts,
	failedServices,
	packageAlertMessage,
	packageCounts,
	packageThreshold,
	systemdAction,
	systemdAlertMessage,
} from "../src/worker/beszel/update-alerts";

vi.mock("../src/worker/notify", () => ({ notify: vi.fn(async () => undefined) }));
import { notify } from "../src/worker/notify";

const M = (e: [number, unknown][]) => new Map<number, unknown>(e);

function pkgReply(id: number, wrapped = false) {
	const list = [
		M([[0, "curl"], [1, "8.5.0-2ubuntu10.6"], [2, "8.5.0-2ubuntu10.7"], [3, false]]),
		M([[0, "openssl"], [1, "3.0.13-0ubuntu3.5"], [2, "3.0.13-0ubuntu3.6"], [3, true]]),
	];
	const inner = M([[0, "apt"], [1, 1_761_840_000], [2, true], [3, list]]);
	// The agent embeds key 7 as inline CBOR (cbor.RawMessage), not as a byte string.
	return encode(M([[0, id], [7, wrapped ? encode(inner) : inner]]));
}

describe("package updates protocol", () => {
	it("encodes GetPackageUpdates (action 8) with no data", () => {
		const bytes = packageUpdatesRequest(42);
		expect(bytes).toEqual(encode(M([[0, 8], [2, 42]])));
	});

	it("does not mistake a PackageUpdates reply for system data when routed as raw", () => {
		// Shape-sniffing (the old behaviour) would treat {0: manager, 1: checkedAt} as CombinedData.
		expect(decodeResponse(pkgReply(7)).systemData).toBeDefined();
		const res = decodeResponse(pkgReply(7), "raw");
		expect(res.id).toBe(7);
		expect(res.systemData).toBeUndefined();
		const snap = normalizePackageUpdates(res.payload)!;
		expect(snap).toMatchObject({ manager: "apt", checkedAt: 1_761_840_000_000, securityKnown: true });
		expect(snap.packages.map((p) => p.n)).toEqual(["openssl", "curl"]); // security first
		expect(snap.packages[0]).toEqual({ n: "openssl", c: "3.0.13-0ubuntu3.5", a: "3.0.13-0ubuntu3.6", s: true });
		// A byte-string-wrapped payload decodes the same way.
		expect(normalizePackageUpdates(decodeResponse(pkgReply(7, true), "raw").payload)).toEqual(snap);
	});

	it("reads services only from a fresh systemd snapshot", () => {
		const svc = [M([[0, "nginx.service"], [1, 0], [5, 1]]), M([[0, "backup.service"], [1, 2], [5, 3]])];
		const base = M([[0, M([[0, 1]])], [1, M([[22, [2, 1]], [25, [3, 1]]])], [3, svc]]);
		expect(normalizeCombinedData(base).services).toBeUndefined();
		base.set(5, true);
		const n = normalizeCombinedData(base);
		expect(n.services).toEqual([{ n: "backup.service", s: 2, ss: 3 }, { n: "nginx.service", s: 0, ss: 1 }]);
		expect(n.info.sv).toEqual([2, 1]);
		expect(n.info.pu).toEqual([3, 1]);
		const empty = M([[0, M([[0, 1]])], [1, M([])], [5, true]]);
		expect(normalizeCombinedData(empty).services).toEqual([]);
	});
});

describe("package alert decisions", () => {
	it("parses counts", () => {
		expect(packageCounts(undefined)).toBeNull();
		expect(packageCounts([4])).toEqual({ total: 4, security: null });
		expect(packageCounts([4, 1])).toEqual({ total: 4, security: 1 });
		expect(packageThreshold(null)).toBe(1);
		expect(packageThreshold(0)).toBe(1);
		expect(packageThreshold(10)).toBe(10);
	});

	it("security: trigger, rise re-alert, no repeat, resolve", () => {
		expect(evaluatePackageAlert("SecurityUpdates", false, 0, 1, null)).toBe("none");
		expect(evaluatePackageAlert("SecurityUpdates", false, 1, 1, 0)).toBe("trigger");
		expect(evaluatePackageAlert("SecurityUpdates", true, 1, 1, 1)).toBe("none");
		expect(evaluatePackageAlert("SecurityUpdates", true, 3, 1, 1)).toBe("rise");
		expect(evaluatePackageAlert("SecurityUpdates", true, 2, 1, 3)).toBe("none"); // falling but still over
		expect(evaluatePackageAlert("SecurityUpdates", true, 0, 1, 2)).toBe("resolve");
	});

	it("packages: threshold, no rise re-alert, resolve below threshold", () => {
		expect(evaluatePackageAlert("PackageUpdates", false, 9, 10, null)).toBe("none");
		expect(evaluatePackageAlert("PackageUpdates", false, 10, 10, 9)).toBe("trigger");
		expect(evaluatePackageAlert("PackageUpdates", true, 25, 10, 10)).toBe("none");
		expect(evaluatePackageAlert("PackageUpdates", true, 9, 10, 25)).toBe("resolve");
	});

	it("builds messages with status mapping and package lists", () => {
		const pkgs = Array.from({ length: 12 }, (_, i) => ({ n: `lib${i}`, c: "1", a: "2", s: i !== 0 }));
		const t = packageAlertMessage("SecurityUpdates", "trigger", "server-1", 11, 1, pkgs);
		expect(t).toMatchObject({ title: "Security updates on server-1 🔴", status: "down" });
		expect(t.body.split("\n")[0]).toBe("11 security updates pending on server-1.");
		expect(t.body).toContain("lib1 (1 → 2)");
		expect(t.body).not.toContain("lib0 ");
		expect(t.body).toContain("and 1 more");
		expect(packageAlertMessage("SecurityUpdates", "rise", "server-1", 3, 1, null).title).toBe("More security updates on server-1 🔴");
		expect(packageAlertMessage("SecurityUpdates", "resolve", "server-1", 0, 1, null)).toMatchObject({
			title: "Security updates cleared on server-1 ✅",
			body: "No security updates are pending on server-1.",
			status: "up",
		});
		expect(packageAlertMessage("PackageUpdates", "resolve", "server-1", 4, 10, null).body).toBe("4 package updates on server-1, below the alert threshold of 10.");
		expect(packageAlertMessage("PackageUpdates", "trigger", "server-1", 12, 10, null)).toMatchObject({ title: "Package updates on server-1 🟡", status: "warning" });
	});
});

describe("systemd alert decisions", () => {
	it("fails and recovers on change only", () => {
		const svcs = [
			{ n: "a.service", s: 0 as const, ss: 1 },
			{ n: "b.service", s: 2 as const, ss: 3 },
		];
		expect(failedServices(svcs)).toEqual(["b.service"]);
		expect(systemdAction(false, [])).toBe("none");
		expect(systemdAction(false, ["b.service"])).toBe("trigger");
		expect(systemdAction(true, ["b.service", "c.service"])).toBe("none");
		expect(systemdAction(true, [])).toBe("resolve");
		expect(systemdAlertMessage("trigger", "server-1", ["b.service"])).toMatchObject({ title: "Failed services on server-1 🔴", body: "1 failed service on server-1: b.service", status: "down" });
		expect(systemdAlertMessage("resolve", "server-1", [])).toMatchObject({ title: "Services recovered on server-1 ✅", status: "up" });
	});
});

/** Minimal D1 stand-in that records statements. */
function fakeEnv() {
	const writes: { sql: string; args: unknown[] }[] = [];
	const DB = {
		prepare(sql: string) {
			return {
				bind: (...args: unknown[]) => ({
					run: async () => {
						writes.push({ sql, args });
						return { success: true };
					},
				}),
			};
		},
	};
	return { env: { DB } as never, writes };
}

const row = (metric: string, threshold: number | null, triggered = 0, last: number | null = null): AlertRow => ({ id: metric, metric, threshold, minutes: 1, triggered, last_value: last });

describe("evaluatePackageAlerts / evaluateSystemdAlerts (no real notifications)", () => {
	it("trigger → rise → steady (no writes) → resolve", async () => {
		const n = vi.mocked(notify);
		n.mockClear();
		const { env, writes } = fakeEnv();
		const alerts = [row("SecurityUpdates", 1), row("PackageUpdates", 10)];
		const getPkgs = vi.fn(async () => [{ n: "openssl", c: "1", a: "2", s: true }]);

		await evaluatePackageAlerts(env, "sys", "server-1", [5, 1], alerts, getPkgs);
		expect(n).toHaveBeenCalledTimes(1);
		expect(n.mock.calls[0][2]).toMatchObject({ title: "Security updates on server-1 🔴", status: "down" });
		expect(n.mock.calls[0][2].body).toContain("openssl (1 → 2)");
		expect(alerts[0]).toMatchObject({ triggered: 1, last_value: 1 });
		expect(alerts[1]).toMatchObject({ triggered: 0, last_value: 5 }); // count tracked, no alert

		const before = writes.filter((w) => w.sql.startsWith("UPDATE")).length;
		await evaluatePackageAlerts(env, "sys", "server-1", [5, 1], alerts, getPkgs);
		expect(writes.filter((w) => w.sql.startsWith("UPDATE")).length).toBe(before); // unchanged → 0 writes
		expect(n).toHaveBeenCalledTimes(1);

		await evaluatePackageAlerts(env, "sys", "server-1", [12, 3], alerts, getPkgs);
		expect(n.mock.calls.map((c) => c[2].title)).toEqual(["Security updates on server-1 🔴", "More security updates on server-1 🔴", "Package updates on server-1 🟡"]);

		await evaluatePackageAlerts(env, "sys", "server-1", [20, 3], alerts, getPkgs); // packages rising: no re-alert
		expect(n).toHaveBeenCalledTimes(3);

		await evaluatePackageAlerts(env, "sys", "server-1", [0, 0], alerts, getPkgs);
		expect(n.mock.calls.slice(3).map((c) => [c[2].title, c[2].status])).toEqual([
			["Security updates cleared on server-1 ✅", "up"],
			["Package updates cleared on server-1 ✅", "up"],
		]);
	});

	it("skips security alerts when the manager cannot flag security updates", async () => {
		const n = vi.mocked(notify);
		n.mockClear();
		const { env, writes } = fakeEnv();
		await evaluatePackageAlerts(env, "sys", "server-1", [40], [row("SecurityUpdates", 1)], async () => null);
		await evaluatePackageAlerts(env, "sys", "server-1", undefined, [row("SecurityUpdates", 1)], async () => null);
		expect(n).not.toHaveBeenCalled();
		expect(writes).toHaveLength(0);
	});

	it("systemd: fail then recover, no repeat while failed", async () => {
		const n = vi.mocked(notify);
		n.mockClear();
		const { env } = fakeEnv();
		const alerts = [row("SystemdFailed", null)];
		const bad = [{ n: "backup.service", s: 2 as const, ss: 3 }];
		await evaluateSystemdAlerts(env, "sys", "server-1", bad, alerts);
		await evaluateSystemdAlerts(env, "sys", "server-1", bad, alerts);
		await evaluateSystemdAlerts(env, "sys", "server-1", [], alerts);
		expect(n.mock.calls.map((c) => c[2].title)).toEqual(["Failed services on server-1 🔴", "Services recovered on server-1 ✅"]);
	});
});
