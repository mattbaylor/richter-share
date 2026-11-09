import { Hono } from "hono";
import { authenticate } from "./access";
import { liveSystems } from "./beszel/live";
import { ensureSchema } from "./db";
import type { Env } from "./env";
import { overlay } from "./hub";
import { hub, hubView } from "./hub-client";
import type { MonitorRow } from "./monitors/engine";
import { admin } from "./routes/admin";
import { hostInfo, pub } from "./routes/public";
import { flushBatches } from "./notify";

export { AgentConnection } from "./beszel/agent-do";
export { Hub } from "./hub";

const app = new Hono<{ Bindings: Env }>();

const isDashboardHost = (env: Env, host: string) => host === env.DASHBOARD_HOST || host === "localhost" || host === "127.0.0.1";

app.use("*", async (c, next) => {
	await ensureSchema(c.env.DB);
	await next();
	const path = new URL(c.req.url).pathname;
	// Only /embed may be framed; everything else refuses framing.
	if (!path.startsWith("/embed/")) c.header("x-frame-options", "DENY");
	c.header("x-content-type-options", "nosniff");
	c.header("referrer-policy", "strict-origin-when-cross-origin");
});

app.get("/healthz", (c) => c.json({ ok: true, at: Date.now() }));

app.get("/api/whoami-host", async (c) => c.json(await hostInfo(c.env, new URL(c.req.url).hostname)));

// Admin API is only reachable on the Access-protected dashboard host.
app.use("/api/admin/*", async (c, next) => {
	if (!isDashboardHost(c.env, new URL(c.req.url).hostname)) return c.json({ error: "Not found" }, 404);
	await next();
});
app.route("/api/admin", admin);

app.get("/metrics", async (c) => {
	if (!isDashboardHost(c.env, new URL(c.req.url).hostname)) return c.text("Not found", 404);
	if (!(await authenticate(c.req.raw, c.env))) return c.text("Unauthorized", 401);
	const db = c.env.DB;
	const [rows, view] = await Promise.all([db.prepare("SELECT * FROM monitors").all<MonitorRow>(), hubView(c.env)]);
	const mons = { results: rows.results.map((m) => overlay(m, view?.live[m.id])) };
	const systems = { results: await liveSystems(c.env, (await db.prepare("SELECT id, name, status, info, last_seen FROM systems").all<{ id: string; name: string; status: string; info: string | null; last_seen: number | null }>()).results) };
	const lbl = (s: string) => s.replace(/["\\\n]/g, "_");
	const lines = [
		"# HELP richter_monitor_up 1 if the monitor is up or degraded, 0 if down.",
		"# TYPE richter_monitor_up gauge",
		...mons.results.filter((m) => !m.paused).map((m) => `richter_monitor_up{name="${lbl(m.name)}",type="${m.type}"} ${m.status === "down" ? 0 : 1}`),
		"# TYPE richter_monitor_latency_ms gauge",
		...mons.results.filter((m) => m.last_latency_ms != null).map((m) => `richter_monitor_latency_ms{name="${lbl(m.name)}"} ${m.last_latency_ms}`),
		"# TYPE richter_system_up gauge",
		...systems.results.map((s) => `richter_system_up{name="${lbl(s.name)}"} ${s.status === "up" ? 1 : 0}`),
	];
	for (const [metric, key] of [
		["cpu_percent", "cpu"],
		["mem_percent", "mp"],
		["disk_percent", "dp"],
	] as const) {
		lines.push(`# TYPE richter_system_${metric} gauge`);
		for (const s of systems.results) {
			const v = s.infoObj[key];
			if (typeof v === "number") lines.push(`richter_system_${metric}{name="${lbl(s.name)}"} ${v}`);
		}
	}
	return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4" });
});

app.route("/", pub);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// SPA: the asset binding serves index.html for unknown paths.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
	fetch: app.fetch,
	async scheduled(event, env) {
		// All per-minute work (checks, groups, D1 flushes, retention) runs inside the Hub Durable Object.
		// Connected systems are polled from here too, so AgentConnections need no per-minute alarm
		// (each setAlarm is a billed storage write).
		// The polls return each system's latest CPU % for the public sparkline. The tick waits for them at
		// most POLL_WAIT_MS (they only send a request on an open socket), then runs with what arrived.
		const cpu: Record<string, number> = {};
		const polling = pollAgents(env, cpu);
		await Promise.race([polling, new Promise((r) => setTimeout(r, POLL_WAIT_MS))]);
		const [r, polled] = await Promise.all([hub(env).tick(event.scheduledTime, { ...cpu }), polling]);
		// Batched channels (ntfy): send what queued up during the last window as one digest per channel.
		const digests = await flushBatches(env, Date.now());
		console.log(`cron: ${r.ran} checks, ${r.skipped} deferred${r.busy ? " (previous tick still running)" : ""}, ${polled} systems polled${digests ? `, ${digests} digests sent` : ""}`);
	},
} satisfies ExportedHandler<Env>;

const POLL_WAIT_MS = 3000;

/** Ask every connected system's AgentConnection for fresh data; their latest CPU % lands in `cpu`. */
async function pollAgents(env: Env, cpu: Record<string, number>): Promise<number> {
	try {
		const { results } = await env.DB.prepare("SELECT id, details IS NULL no_details FROM systems WHERE status = 'up'").all<{ id: string; no_details: number }>();
		const out = await Promise.allSettled(
			results.map(async (s) => {
				const v = await env.AGENT.get(env.AGENT.idFromName(s.id)).poll(!!s.no_details);
				if (typeof v === "number") cpu[s.id] = v;
			}),
		);
		for (const o of out) if (o.status === "rejected") console.error("agent poll failed", (o.reason as Error)?.message);
		return results.length;
	} catch (e) {
		console.error("agent polls failed", (e as Error).message);
		return 0;
	}
}
