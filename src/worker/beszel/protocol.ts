import { decode, encode } from "cborg";
import type { ContainerStat, PackageUpdate, ServiceState, SystemDetails, SystemdService, SystemInfo, SystemStats } from "../../shared/types";

/** Beszel WebSocket actions (internal/common/common-ws.go). */
export const Action = {
	GetData: 0,
	CheckFingerprint: 1,
	GetContainerLogs: 2,
	GetContainerInfo: 3,
	GetSmartData: 4,
	GetSystemdInfo: 5,
	GetZfsData: 6,
	SyncNetworkMonitors: 7,
	GetPackageUpdates: 8,
	GetSystemdLogs: 9,
} as const;

/** HubRequest{0: action, 1: data, 2: id} with integer keys, encoded as CBOR maps. */
export function encodeRequest(action: number, data: Map<number, unknown> | undefined, id: number): Uint8Array {
	const m = new Map<number, unknown>([[0, action]]);
	if (data !== undefined) m.set(1, data);
	m.set(2, id);
	return encode(m);
}

export function fingerprintRequest(signature: Uint8Array, id: number): Uint8Array {
	return encodeRequest(Action.CheckFingerprint, new Map<number, unknown>([[0, signature], [1, false]]), id);
}

export function packageUpdatesRequest(id: number): Uint8Array {
	return encodeRequest(Action.GetPackageUpdates, undefined, id);
}

export function getDataRequest(id: number, includeDetails: boolean, cacheTimeMs = 60000): Uint8Array {
	return encodeRequest(Action.GetData, new Map<number, unknown>([[0, cacheTimeMs], [1, includeDetails]]), id);
}

type Raw = Map<unknown, unknown>;

export interface AgentResponse {
	id?: number;
	systemData?: Raw;
	fingerprint?: { fingerprint: string; hostname?: string; port?: string; name?: string };
	error?: string;
	/** Decoded 0.18+ generic payload (key 7), whatever the request was. */
	payload?: unknown;
}

function num(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "bigint") return Number(v);
	return 0;
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function asMap(v: unknown): Raw | undefined {
	return v instanceof Map ? (v as Raw) : undefined;
}
function numArr(v: unknown): number[] | undefined {
	if (v instanceof Uint8Array) return Array.from(v);
	if (Array.isArray(v)) return v.map(num);
	return undefined;
}

/**
 * Decode an agent response. Key 7 is a generic payload whose shape depends on the request,
 * so callers that know the request id was not GetData must pass `generic: "raw"`; otherwise
 * a payload such as PackageUpdates{0: manager, 1: checkedAt, ...} would look like CombinedData.
 */
export function decodeResponse(bytes: Uint8Array, generic: "system" | "raw" = "system"): AgentResponse {
	const m = decode(bytes, { useMaps: true }) as Raw;
	if (!(m instanceof Map)) throw new Error("agent response is not a map");
	const out: AgentResponse = {};
	if (m.has(0)) out.id = num(m.get(0));
	const sys = asMap(m.get(1));
	if (sys) out.systemData = sys;
	const fp = asMap(m.get(2));
	if (fp) {
		out.fingerprint = {
			fingerprint: str(fp.get(0)) ?? "",
			hostname: str(fp.get(1)),
			port: str(fp.get(2)),
			name: str(fp.get(3)),
		};
	}
	const err = str(m.get(3));
	if (err) out.error = err;
	// 0.18+ generic payload in key 7. The agent embeds it as inline CBOR (cbor.RawMessage),
	// so it normally decodes straight to a map; tolerate a wrapped byte string as well.
	const raw7 = m.get(7);
	if (raw7 instanceof Uint8Array) {
		try {
			out.payload = decode(raw7, { useMaps: true });
		} catch {
			/* undecodable payload */
		}
	} else if (raw7 !== undefined) {
		out.payload = raw7;
	}
	const inner = out.payload;
	if (generic === "system" && !out.systemData && inner instanceof Map && inner.has(0) && inner.has(1)) out.systemData = inner as Raw;
	return out;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function recordOf<T>(v: unknown, f: (x: unknown) => T): Record<string, T> | undefined {
	const m = asMap(v);
	if (!m || m.size === 0) return undefined;
	const out: Record<string, T> = {};
	for (const [k, val] of m) out[String(k)] = f(val);
	return out;
}

/** Keep the last dashboard temperature this long when a poll comes back without one. */
export const DT_CARRY_MS = 10 * 60_000;

/**
 * Dashboard temperature (info.dt) for the Systems list. Beszel's agent sets it to the hottest sensor
 * (or SYS_SENSORS' primary sensor) but resets it to 0 on every poll, so a slow or timed-out sensor
 * read (common with macOS SMC reads) leaves it unset for that poll while the detail charts still have
 * recent temperatures. Fill it the way the agent would: from this poll's sensors, else the last value
 * seen within DT_CARRY_MS.
 */
export function dashboardTemp(
	info: SystemInfo,
	stats: SystemStats,
	prev: { dt?: number; at?: number } | undefined,
	now: number,
): { dt?: number; at?: number; src: "agent" | "sensors" | "carried" | "none" } {
	if (info.dt != null && info.dt > 0) return { dt: info.dt, at: now, src: "agent" };
	const temps = Object.values(stats.t ?? {}).filter((v) => v > 0 && v < 200);
	if (temps.length) return { dt: Math.max(...temps), at: now, src: "sensors" };
	if (prev?.dt != null && prev.at != null && now - prev.at <= DT_CARRY_MS) return { dt: prev.dt, at: prev.at, src: "carried" };
	return { src: "none" };
}

export interface Normalized {
	stats: SystemStats;
	info: SystemInfo;
	details?: SystemDetails;
	containers: ContainerStat[];
	/** Present only when the agent marked the systemd snapshot fresh (every ~10 min). */
	services?: SystemdService[];
}

/** Map Beszel's integer-keyed CombinedData into Richter's readable shape (bytes, bytes/s, %). */
export function normalizeCombinedData(raw: Raw): Normalized {
	const s = asMap(raw.get(0)) ?? new Map();
	const i = asMap(raw.get(1)) ?? new Map();

	const memBytes = numArr(s.get(41));
	const swapBytes = numArr(s.get(42));
	const bandwidth = numArr(s.get(26));
	const diskIO = numArr(s.get(32));
	const la = numArr(s.get(28));

	const stats: SystemStats = {
		cpu: num(s.get(0)),
		mp: num(s.get(4)),
		mt: memBytes?.[0] ?? num(s.get(2)) * GB,
		mu: memBytes?.[1] ?? num(s.get(3)) * GB,
		mb: memBytes?.[2] ?? num(s.get(5)) * GB,
		mz: memBytes?.[3] ?? num(s.get(6)) * GB,
		sw: swapBytes?.[0] ?? num(s.get(7)) * GB,
		swu: swapBytes?.[1] ?? num(s.get(8)) * GB,
		d: num(s.get(9)) * GB,
		du: num(s.get(10)) * GB,
		dp: num(s.get(11)),
		dr: diskIO?.[0] ?? num(s.get(12)) * MB,
		dw: diskIO?.[1] ?? num(s.get(13)) * MB,
		ns: bandwidth?.[0] ?? num(s.get(16)) * MB,
		nr: bandwidth?.[1] ?? num(s.get(17)) * MB,
	};
	if (la && la.length === 3) stats.la = [la[0], la[1], la[2]];
	const temps = recordOf(s.get(20), num);
	if (temps) stats.t = temps;
	const efs = recordOf(s.get(21), (v) => {
		const m = asMap(v) ?? new Map();
		return { d: num(m.get(0)) * GB, du: num(m.get(1)) * GB, r: num(m.get(6)), w: num(m.get(7)) };
	});
	if (efs) stats.efs = efs;
	const gpu = recordOf(s.get(22), (v) => {
		const m = asMap(v) ?? new Map();
		return { n: str(m.get(0)) ?? "GPU", mu: num(m.get(1)), mt: num(m.get(2)), u: num(m.get(3)), p: num(m.get(4)) };
	});
	if (gpu) stats.g = gpu;
	const ni = recordOf(s.get(31), (v) => {
		const a = numArr(v) ?? [];
		return [a[0] ?? 0, a[1] ?? 0] as [number, number];
	});
	if (ni) stats.ni = ni;
	const cpub = numArr(s.get(33));
	if (cpub?.length) stats.cpub = cpub;
	const cpus = numArr(s.get(34));
	if (cpus?.length) stats.cpus = cpus;
	const fans = recordOf(s.get(36), num);
	if (fans) stats.f = fans;
	const bat = numArr(s.get(29));
	if (bat && bat.length === 2 && (bat[0] || bat[1])) stats.bat = [bat[0], bat[1]];

	const ila = numArr(i.get(19));
	const info: SystemInfo = {
		h: str(i.get(0)),
		k: str(i.get(1)),
		c: num(i.get(2)) || undefined,
		t: num(i.get(3)) || undefined,
		m: str(i.get(4)),
		u: num(i.get(5)),
		cpu: num(i.get(6)),
		mp: num(i.get(7)),
		dp: num(i.get(8)),
		v: str(i.get(10)),
		g: num(i.get(12)) || undefined,
		dt: num(i.get(13)) || undefined,
		os: num(i.get(14)),
		bb: num(i.get(18)),
		la: ila && ila.length === 3 ? [ila[0], ila[1], ila[2]] : stats.la,
		sv: numArr(i.get(22)),
		pu: numArr(i.get(25)),
		efs: recordOf(i.get(21), num),
	};

	let details: SystemDetails | undefined;
	const d = asMap(raw.get(4));
	if (d) {
		details = {
			hostname: str(d.get(0)),
			kernel: str(d.get(1)),
			cores: num(d.get(2)),
			threads: num(d.get(3)),
			cpuModel: str(d.get(4)),
			os: num(d.get(5)),
			osName: str(d.get(6)),
			arch: str(d.get(7)),
			podman: d.get(8) === true,
			memTotal: num(d.get(9)),
		};
		// Newer agents stop sending these in Info once Details exist.
		info.h ??= details.hostname;
		info.k ??= details.kernel;
		info.c ??= details.cores;
		info.t ??= details.threads;
		info.m ??= details.cpuModel;
	}

	const containers: ContainerStat[] = [];
	const rawContainers = raw.get(2);
	if (Array.isArray(rawContainers)) {
		for (const c of rawContainers) {
			const m = asMap(c);
			if (!m) continue;
			const b = numArr(m.get(9));
			containers.push({
				n: str(m.get(0)) ?? "?",
				c: num(m.get(1)),
				m: num(m.get(2)),
				ns: b?.[0] ?? num(m.get(3)) * MB,
				nr: b?.[1] ?? num(m.get(4)) * MB,
				h: num(m.get(5)),
				s: str(m.get(6)),
				id: str(m.get(7)),
				i: str(m.get(8)),
			});
		}
	}

	// systemd: key 3 is the service list, key 5 says it is a fresh snapshot (an empty fresh
	// list means "no services"). Without key 5 the agent omitted systemd data.
	let services: SystemdService[] | undefined;
	if (raw.get(5) === true) services = normalizeServices(raw.get(3));

	return { stats, info, details, containers, services };
}

export function normalizeServices(v: unknown): SystemdService[] {
	const out: SystemdService[] = [];
	if (!Array.isArray(v)) return out;
	for (const x of v) {
		const m = asMap(x);
		const n = m && str(m.get(0));
		if (!m || !n) continue;
		out.push({ n, s: Math.min(5, num(m.get(1))) as ServiceState, ss: num(m.get(5)) });
	}
	return out.sort((a, b) => a.n.localeCompare(b.n));
}

export interface NormalizedPackages {
	manager: string | null;
	checkedAt: number | null; // ms
	securityKnown: boolean;
	packages: PackageUpdate[];
}

/** PackageUpdates{0: manager, 1: checkedAt (unix s), 2: securityKnown, 3: [{0 name, 1 current, 2 available, 3 security}]}. */
export function normalizePackageUpdates(v: unknown): NormalizedPackages | null {
	const m = asMap(v);
	if (!m) return null;
	const packages: PackageUpdate[] = [];
	const list = m.get(3);
	if (Array.isArray(list)) {
		for (const x of list) {
			const p = asMap(x);
			const n = p && str(p.get(0));
			if (!p || !n) continue;
			const pkg: PackageUpdate = { n };
			const c = str(p.get(1));
			const a = str(p.get(2));
			if (c) pkg.c = c;
			if (a) pkg.a = a;
			if (p.get(3) === true) pkg.s = true;
			packages.push(pkg);
		}
	}
	packages.sort((a, b) => Number(!!b.s) - Number(!!a.s) || a.n.localeCompare(b.n));
	const checked = num(m.get(1));
	return { manager: str(m.get(0)) ?? null, checkedAt: checked ? checked * 1000 : null, securityKnown: m.get(2) === true, packages };
}
