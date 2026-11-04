const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Human-readable bytes (1024 base, Beszel style). */
export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
	if (bytes == null || !Number.isFinite(bytes)) return "–";
	if (bytes === 0) return "0 B";
	const neg = bytes < 0;
	let v = Math.abs(bytes);
	let i = 0;
	while (v >= 1024 && i < BYTE_UNITS.length - 1) {
		v /= 1024;
		i++;
	}
	const d = i === 0 ? 0 : v >= 100 ? 0 : decimals;
	return `${neg ? "-" : ""}${v.toFixed(d)} ${BYTE_UNITS[i]}`;
}

/** Bytes per second. */
export function formatRate(bps: number | null | undefined, decimals = 1): string {
	if (bps == null || !Number.isFinite(bps)) return "–";
	return `${formatBytes(bps, decimals)}/s`;
}

export function formatPercent(v: number | null | undefined, decimals = 1): string {
	if (v == null || !Number.isFinite(v)) return "–";
	return `${v.toFixed(decimals)}%`;
}

/** Uptime percentage: keeps precision near 100 (99.95 vs 100). */
export function formatUptime(v: number | null | undefined): string {
	if (v == null || !Number.isFinite(v)) return "–";
	if (v >= 100) return "100%";
	if (v >= 99.99) return `${v.toFixed(3)}%`;
	return `${v.toFixed(2)}%`;
}

export function formatMs(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return "–";
	if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
	return `${Math.round(ms)} ms`;
}

export function formatNumber(v: number | null | undefined, decimals = 2): string {
	if (v == null || !Number.isFinite(v)) return "–";
	return v.toFixed(decimals);
}

/** Seconds → "3d 4h", "5h 12m", "42m", "12s". */
export function formatDuration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds)) return "–";
	const s = Math.max(0, Math.floor(seconds));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
	if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

export function formatDurationMs(ms: number | null | undefined): string {
	return ms == null ? "–" : formatDuration(ms / 1000);
}

/** "12s ago", "5m ago", "in 3h". */
export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
	if (ts == null) return "never";
	const diff = now - ts;
	const abs = Math.abs(diff);
	if (abs < 5_000) return "just now";
	const str = formatDuration(abs / 1000).split(" ")[0];
	return diff >= 0 ? `${str} ago` : `in ${str}`;
}

const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const tf = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const tfs = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const df = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dfl = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export const formatDateTime = (ts: number | null | undefined) => (ts == null ? "–" : dtf.format(ts));
export const formatTime = (ts: number) => tf.format(ts);
export const formatTimeSec = (ts: number) => tfs.format(ts);
export const formatDay = (ts: number) => df.format(ts);
export const formatLongDay = (ts: number) => dfl.format(ts);

/** "2026-10-29" (UTC day key) → long label. */
export function formatDayKey(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	return dfl.format(new Date(y, m - 1, d));
}

/** unix ms → value for <input type="datetime-local"> in the browser timezone. */
export function toLocalInput(ts: number | null | undefined): string {
	if (ts == null) return "";
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
	if (!v) return null;
	const t = new Date(v).getTime();
	return Number.isFinite(t) ? t : null;
}

export const OS_NAMES = ["Linux", "macOS", "Windows", "FreeBSD"];
export function osName(os: number | undefined, fallback?: string): string {
	if (fallback) return fallback;
	return os == null ? "–" : (OS_NAMES[os] ?? "Unknown");
}
