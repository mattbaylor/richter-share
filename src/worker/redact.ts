/** What read-only users must not see: agent/heartbeat tokens, notification credentials, monitor auth. */

export const MASK = "••••••";
const SECRET_PARAM = /token|key|secret|sig|auth|pass|pwd|code|session|cred/i;

function maskUrl(u: string): string {
	try {
		const url = new URL(u);
		if (url.password) url.password = MASK;
		for (const k of [...url.searchParams.keys()]) if (SECRET_PARAM.test(k)) url.searchParams.set(k, MASK);
		return url.toString();
	} catch {
		return u;
	}
}

function redactMonitor(m: Record<string, unknown>) {
	m.push_token = null;
	m.ping_url = null;
	const cfg = m.config as Record<string, unknown> | undefined;
	if (cfg && typeof cfg === "object") {
		if (cfg.headers && typeof cfg.headers === "object") cfg.headers = Object.fromEntries(Object.keys(cfg.headers).map((k) => [k, MASK]));
		if (typeof cfg.body === "string" && cfg.body) cfg.body = MASK;
		if (typeof cfg.url === "string") cfg.url = maskUrl(cfg.url);
	}
}

function redactChannel(ch: Record<string, unknown>) {
	const cfg = ch.config as Record<string, unknown>;
	ch.config = Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v === "" || v == null ? v : MASK]));
}

/** Redact monitors and notification channels anywhere in a (shallow) JSON response, in place. */
export function redactForReadOnly<T>(data: T, depth = 0): T {
	if (depth > 3 || data == null || typeof data !== "object") return data;
	if (Array.isArray(data)) {
		for (const x of data) redactForReadOnly(x, depth + 1);
		return data;
	}
	const o = data as Record<string, unknown>;
	if ("push_token" in o || "ping_url" in o) redactMonitor(o);
	else if ("apply_default" in o && o.config && typeof o.config === "object") redactChannel(o);
	else for (const v of Object.values(o)) if (v && typeof v === "object") redactForReadOnly(v, depth + 1);
	return data;
}

/** Admin GET routes (relative to /api/admin) that only hand out credentials: Full users only. */
export const READ_BLOCKED_GET = [/^\/export$/, /^\/systems\/[^/]+\/install$/];
/** Admin GET routes whose JSON is redacted for read-only users. */
export const READ_REDACTED_GET = /^\/(monitors|notifications)(\/|$)/;
