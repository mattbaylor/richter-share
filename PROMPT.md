# Richter — build prompt

> Paste everything below the line into a coding agent. It is self-contained.
> Companion notes (why each decision was made) live in `docs/DECISIONS.md`.

---

You are building **Richter**, a serverless infrastructure monitor that runs entirely on Cloudflare (Workers, Durable Objects, D1, Cron Triggers, static assets, Cloudflare Access). It combines three existing tools:

| Borrowed from | What Richter takes |
| --- | --- |
| **Beszel** (henrygd/beszel) | Server metrics dashboard: systems table, per-system charts (CPU, memory, disk, disk I/O, network, temperatures, load, GPU, containers), threshold alerts. Richter is a drop-in **hub replacement**: the unmodified `henrygd/beszel-agent` connects to it. |
| **FlareWatch** (saminnet/flarewatch) | Uptime checks every minute from Cloudflare's edge (HTTP/keyword/JSON/header, TCP, DNS, domain expiry), heartbeat ("ping me when the job finishes") monitors, status page look and features (uptime bars, incidents, maintenance, announcements, Atom feed, badges, embeds). **Difference:** everything is managed in a UI backed by a database, never by editing config and committing to git. |
| **Uptime Kuma** | Multiple status pages with custom domains, monitor groups, tags, upside-down mode, retries, notification resend, per-monitor notification routing, Prometheus `/metrics`, cloning, pause/resume, container monitors. |

The monitor must never go down itself: no VPS, no container, no origin server. Everything runs on Cloudflare.

## 0. Hard constraints

1. **Runtime:** one Cloudflare Worker (TypeScript, ES modules) plus static assets. Use the `cf` CLI (`cf` npm package, 1.0 beta) with a typed `cloudflare.config.ts` and `@cloudflare/vite-plugin@beta`. Do **not** create a Wrangler config file.
2. **Storage:** D1 (SQLite) for all app data. One SQLite-backed Durable Object class per connected Beszel agent. No KV, no R2, no external DB.
3. **Frontend:** React 19 + Vite + TypeScript + Tailwind CSS v4 + shadcn/ui-style components (Radix primitives, `lucide-react` icons) + Recharts. Dark mode by default with a light toggle. Visual reference: Beszel's dashboard for the private side, FlareWatch's status page for the public side.
4. **Router:** Hono on the Worker.
5. **Must fit the Workers Free plan** at small scale. The binding limits are 50 subrequests per cron invocation, and D1 Free's 100k rows written/day, which index updates also count against. That works out to about 10–15 one-minute monitors plus a few agents. Keep writes per check minimal. Every design choice that would break on the Free plan must be called out in code comments, with the Paid-plan alternative.
6. **No secrets in git.** Secrets go in Worker secrets; generated keys go in D1.

## 1. Hostnames and auth

Two hostnames, both served by the **same Worker**, selected by the `Host` header:

| Host (configurable via env) | Purpose | Auth |
| --- | --- | --- |
| `DASHBOARD_HOST` e.g. `richter.example.com` | Private dashboard SPA + `/api/admin/*` | Cloudflare Access on the whole hostname |
| `PUBLIC_HOST` e.g. `status.example.com` | Public status pages, badges, feed, heartbeat pings, Beszel agent WebSocket | none (public) |
| any extra host mapped to a status page | That status page at `/` | none |

Rules:

- **Use Cloudflare Access, not an in-app auth system.** The Access application covers `DASHBOARD_HOST` entirely, and you can enforce its policy with email OTP, GitHub, Google, or passkeys. Richter never stores passwords.
- **Defense in depth:** every `/api/admin/*` request must carry a valid `Cf-Access-Jwt-Assertion` header. Verify it in the Worker: RS256 against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cache the JWKS in memory for 10 minutes), `aud` must contain `ACCESS_AUD`, `exp` must be in the future, `iss` must be `https://<ACCESS_TEAM_DOMAIN>`. Expose the email from the token to the UI (`GET /api/admin/me`).
- `/api/admin/*` on any host other than `DASHBOARD_HOST` returns 404. The dashboard SPA is never served on public hosts.
- Dev escape hatch: if `ACCESS_AUD` is unset **and** the request is from `localhost`, skip verification and use the identity `dev@localhost`. Never skip it in production.
- **Agents and pings stay off the Access-protected host.** Agents connect to `wss://PUBLIC_HOST/api/beszel/agent-connect` and pings go to `https://PUBLIC_HOST/ping/...`. This avoids Access service tokens. (Beszel's `HUB_HEADERS` env var can send `CF-Access-Client-Id/Secret` if someone does want them behind Access; document it.)

## 2. Architecture

```
                    ┌──────────── Cloudflare ─────────────────────────────────────────┐
 browser ──Access──▶│ Worker "richter"                                                │
 (dashboard)        │  ├─ fetch: Hono router (host-based)                             │
                    │  │    ├─ static SPA assets (dashboard + public status page)     │
 public visitors ──▶│  │    ├─ /api/admin/*   (Access JWT verified)                   │
                    │  │    ├─ /api/public/*  /feed.atom /badge/* /embed/* /metrics   │
 cron jobs ────────▶│  │    ├─ /ping/:token[...]  (heartbeats)                        │
                    │  │    └─ /api/beszel/agent-connect ──▶ DO AgentConnection(id)   │
 beszel-agent ─wss─▶│  ├─ scheduled (cron "* * * * *"): run due checks, heartbeat     │
                    │  │    deadlines, maintenance, incidents, alerts, rollups,       │
                    │  │    retention                                                 │
                    │  ├─ DO AgentConnection (1 per system, hibernatable WebSocket,  │
                    │  │    alarm polls agent every 60s, writes stats to D1)          │
                    │  └─ D1 "richter-db"                                             │
                    └─────────────────────────────────────────────────────────────────┘
```

`cloudflare.config.ts` must declare:

- the Worker: entrypoint `src/worker/index.ts`, `compatibilityFlags: ["nodejs_compat"]`, `observability.enabled = true`
- `assets`: `notFoundHandling: "single-page-application"`, `runWorkerFirst: ["/api/*", "/ping/*", "/feed.atom", "/badge/*", "/embed/*", "/metrics", "/s/*", "/healthz"]`
- `domains: [DASHBOARD_HOST, PUBLIC_HOST]`
- `triggers: [triggers.scheduled({ schedule: "* * * * *" })]`
- `env.DB = bindings.d1({ name: "richter-db" })`
- `env.AGENT = bindings.durableObject({ worker: <self>, exportName: "AgentConnection" })` and `exports.AgentConnection = exports.durableObject({ storage: "sqlite" })`
- text vars: `DASHBOARD_HOST`, `PUBLIC_HOST`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`

The SPA decides public versus dashboard mode at boot by calling `GET /api/whoami-host`, which returns `{ mode: "dashboard" | "public", pageSlug?: string }`. On public hosts the SPA renders only the status-page routes.

**Schema management:** the Worker applies idempotent migrations on first use per isolate. Keep a `schema_version` row in `settings` and an ordered `MIGRATIONS: string[]` array. Never rely on someone running a CLI migration step.

## 3. Data model (D1)

All timestamps are integer **unix milliseconds**. IDs are 15-character lowercase alphanumeric strings, like PocketBase/Beszel. JSON columns are `TEXT`.

```sql
settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)
-- keys: schema_version, hub_private_jwk, hub_public_ssh (e.g. "ssh-ed25519 AAAA..."), site_title, timezone

systems(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
  fingerprint TEXT,                         -- bound on first successful connect
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | up | down | paused
  info TEXT,                                -- latest Beszel Info, normalized (see §4.5)
  details TEXT,                             -- Beszel Details (hostname, kernel, cpu model, cores, os, arch, mem total)
  agent_version TEXT, last_seen INTEGER, connected_at INTEGER,
  tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)

system_stats(system_id TEXT, type TEXT, created_at INTEGER, stats TEXT NOT NULL,
  PRIMARY KEY(system_id, type, created_at))       -- type: 1m | 10m | 20m | 120m | 480m
container_stats(system_id TEXT, type TEXT, created_at INTEGER, stats TEXT NOT NULL,
  PRIMARY KEY(system_id, type, created_at))       -- stats = JSON array of containers

system_alerts(id TEXT PRIMARY KEY, system_id TEXT NOT NULL,
  metric TEXT NOT NULL,         -- Status | CPU | Memory | Disk | Temperature | LoadAvg5 | Bandwidth | GPU
  threshold REAL, minutes INTEGER NOT NULL DEFAULT 10,
  triggered INTEGER NOT NULL DEFAULT 0, last_value REAL, updated_at INTEGER)

monitors(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  type TEXT NOT NULL,           -- http | tcp | dns | heartbeat | domain | system | container | group
  config TEXT NOT NULL,         -- type-specific JSON (see §5)
  parent_id TEXT,               -- group membership (one level of nesting is enough)
  interval_s INTEGER NOT NULL DEFAULT 60, retries INTEGER NOT NULL DEFAULT 0,
  retry_interval_s INTEGER NOT NULL DEFAULT 60, timeout_ms INTEGER NOT NULL DEFAULT 10000,
  max_latency_ms INTEGER,       -- slower => degraded (no alert, no incident, still "up" for uptime)
  upside_down INTEGER NOT NULL DEFAULT 0, resend_every INTEGER NOT NULL DEFAULT 0,  -- resend "still down" every N failed checks (0 = never)
  paused INTEGER NOT NULL DEFAULT 0, description TEXT, tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | up | degraded | down | maintenance | paused | running
  fail_streak INTEGER NOT NULL DEFAULT 0, down_checks INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER, next_check_at INTEGER, last_latency_ms INTEGER, last_message TEXT,
  push_token TEXT UNIQUE,       -- heartbeat only
  last_ping_at INTEGER, run_started_at INTEGER, cert_expires_at INTEGER, domain_expires_at INTEGER,
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)

checks(monitor_id TEXT, ts INTEGER, status INTEGER, latency_ms INTEGER, message TEXT,
  PRIMARY KEY(monitor_id, ts))       -- status: 0 down, 1 up, 2 degraded, 3 maintenance; keep 7 days
monitor_daily(monitor_id TEXT, day TEXT, up INTEGER, down INTEGER, degraded INTEGER,
  maint INTEGER, latency_sum INTEGER, latency_n INTEGER, PRIMARY KEY(monitor_id, day))  -- keep 400 days
incidents(id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  resolved_at INTEGER, cause TEXT, last_notified_at INTEGER, reminders INTEGER DEFAULT 0)

notifications(id TEXT PRIMARY KEY, name TEXT, type TEXT, config TEXT, enabled INTEGER DEFAULT 1,
  apply_default INTEGER DEFAULT 0, created_at INTEGER)
-- type: discord | slack | telegram | ntfy | gotify | pushover | webhook | email
monitor_notifications(monitor_id TEXT, notification_id TEXT, PRIMARY KEY(monitor_id, notification_id))
system_notifications(system_id TEXT, notification_id TEXT, PRIMARY KEY(system_id, notification_id))

status_pages(id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
  description TEXT, logo_url TEXT, custom_domain TEXT UNIQUE, footer_text TEXT,
  layout TEXT NOT NULL DEFAULT '[]',  -- [{ "name": "Websites", "items": [{ "kind": "monitor"|"system", "id": "..." }] }]
  show_uptime_bars INTEGER DEFAULT 1, show_latency INTEGER DEFAULT 1, show_tags INTEGER DEFAULT 0,
  published INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0, accent_color TEXT,
  custom_css TEXT, created_at INTEGER)

maintenances(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
  repeat TEXT,               -- null | {"every":"day"|"week"|"month","until":ms|null}; each run lasts (ends_at - starts_at) ≤ 24h
  monitor_ids TEXT NOT NULL DEFAULT '[]', system_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER)

announcements(id TEXT PRIMARY KEY, status_page_id TEXT,  -- null = all pages
  title TEXT NOT NULL, body TEXT NOT NULL,                -- body is Markdown, rendered sanitized
  severity TEXT NOT NULL DEFAULT 'info',                  -- info | warning | danger | success
  pinned INTEGER DEFAULT 1, starts_at INTEGER, ends_at INTEGER, created_at INTEGER, updated_at INTEGER)

events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, ref_id TEXT, message TEXT)
-- timeline of "important events" (status changes, alerts, agent connects), keep 90 days
```

Add indexes on `system_stats(system_id,type,created_at)`, `checks(ts)`, `monitors(next_check_at)`, `incidents(monitor_id, resolved_at)`.

## 4. Beszel agent compatibility (critical, read carefully)

Richter replaces the Beszel **hub**. It must interoperate with the unmodified agent (`henrygd/beszel-agent`, version ≥ 0.13.0) in **WebSocket mode**: the agent dials out to the hub. SSH mode, where the hub dials the agent on port 45876, is **not supported** because a Worker cannot run an SSH client reasonably. Say so in the UI.

Source of truth: `github.com/henrygd/beszel` → `internal/common/common-ws.go`, `agent/client.go`, `internal/hub/agent_connect.go`, `internal/hub/ws/*.go`, `internal/entities/system/system.go`, `internal/entities/container/container.go`.

### 4.1 Hub key

On first boot, generate an **Ed25519** key pair with WebCrypto. Store the private key as JWK in `settings.hub_private_jwk`. Store the public key in OpenSSH authorized_keys format in `settings.hub_public_ssh`:

```
"ssh-ed25519 " + base64( u32be(11) + "ssh-ed25519" + u32be(32) + <32 raw public key bytes> )
```

The agent's `KEY` env var is this string.

### 4.2 Agent setup snippet (shown in the UI when adding a system)

```yaml
services:
  beszel-agent:
    image: henrygd/beszel-agent:latest
    container_name: beszel-agent
    restart: unless-stopped
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./beszel_agent_data:/var/lib/beszel-agent
    environment:
      HUB_URL: "https://<PUBLIC_HOST>"
      TOKEN: "<system token>"
      KEY: "<hub_public_ssh>"
      LISTEN: "45876"   # agent still opens its SSH port; harmless
```

Also show the binary/systemd one-liner, with the same three env vars.

### 4.3 Handshake

1. The agent sends `GET /api/beszel/agent-connect` with `Upgrade: websocket`, `X-Token: <token>`, `X-Beszel: <agent semver>`, and a random Chrome `User-Agent`.
2. The Worker validates the request. A missing token, a token longer than 64 characters, or a missing version → 400. A token not found in `systems.token` → 401 `Invalid token`. A version that is not semver or is `< 0.13.0` → 401. Otherwise it forwards the request to `env.AGENT.get(env.AGENT.idFromName(system.id))` with the system id in a header.
3. The DO creates a `WebSocketPair` and calls `this.ctx.acceptWebSocket(server)` (hibernation API). It stores `{ systemId, agentVersion, verified: false }` with `serializeAttachment` and returns 101.
4. The DO immediately sends **CheckFingerprint**. All frames are **binary CBOR** with **integer map keys** (`keyasint`):
   ```
   HubRequest      = { 0: action(uint8), 1: data, 2: requestId(uint32) }
   action          : 0 GetData, 1 CheckFingerprint, 2 GetContainerLogs, 3 GetContainerInfo,
                     4 GetSmartData, 5 GetSystemdInfo, 6 GetZfsData, 7 SyncNetworkMonitors,
                     8 GetPackageUpdates, 9 GetSystemdLogs
   FingerprintReq  = { 0: signature(bytes, 64), 1: needSysInfo(bool) }
   ```
   `signature` is the raw Ed25519 signature of the UTF-8 bytes of the system's **token**, made with the hub private key. This matches Go `ssh.Signer.Sign(...).Blob` for ed25519. The agent verifies it against `KEY` and drops the connection if it fails.
5. The agent replies:
   ```
   AgentResponse   = { 0: requestId, 1?: CombinedData, 2?: FingerprintResp, 3?: error(string), 4?: string, 7?: rawCbor }
   FingerprintResp = { 0: fingerprint(string), 1?: hostname, 2?: port, 3?: name }
   ```
   If `systems.fingerprint` is null, store the fingerprint (first bind). If it differs, close with code 1008 and reason `fingerprint mismatch`, and record an event. Admins can "reset fingerprint" in the UI to re-bind.
6. Once verified, set status to `up` and `connected_at`. Send **GetData** at once, then every 60 s from a DO **alarm**:
   ```
   HubRequest{ 0: 0, 1: { 0: cacheTimeMs(uint16) = 60000, 1: includeDetails(bool) }, 2: id }
   ```
   Set `includeDetails = true` until `systems.details` is populated.
7. Request ids: a monotonically increasing uint32 kept in DO storage. Match responses by `0`. A GetData with no response within 30 s counts as a missed poll. After the agent has been silent for 100 s, close the socket.
8. **Down detection:** on `webSocketClose`/`webSocketError`, schedule the alarm for +10 s. If no new verified socket exists by then, set the system `down`, record an event, and evaluate `Status` alerts. A paused system closes its socket with 1000 and refuses connects until resumed.
9. Use a CBOR library that does not use `eval`/`new Function`. `cborg` with `useMaps: true` works; `cbor-x` is not allowed. Convert `Map`s with integer keys to plain objects. Normalize `bigint` to `number`. Decode byte strings (`Uint8Array`, e.g. `cpus` per-core usage) to number arrays.

### 4.4 CombinedData (agent → hub), integer keys

```
CombinedData = { 0: Stats, 1: Info, 2: [Container], 3?: [SystemdService], 4?: Details, 6?: monitors }
Stats  = { 0 cpu%, 2 memGB(deprecated), 3 memUsedGB, 4 mem%, 5 buffCacheGB, 6 zfsArcGB, 7 swapGB, 8 swapUsedGB,
           9 diskTotalGB, 10 diskUsedGB, 11 disk%, 12 diskReadMBps(legacy), 13 diskWriteMBps(legacy),
           16 netSentMBps(legacy), 17 netRecvMBps(legacy), 20 temperatures{name:°C},
           21 extraFs{name:{0 totalGB,1 usedGB,6 readBps,7 writeBps}}, 22 gpu{id:{0 name,1 memUsedMB,2 memTotalMB,3 usage%,4 powerW}},
           26 bandwidth[sentBps, recvBps], 28 loadAvg[1,5,15], 29 battery[pct,state],
           31 netIfaces{name:[upBps,downBps,totalUp,totalDown]}, 32 diskIO[readBps, writeBps],
           33 cpuBreakdown[user,system,iowait,steal,idle,irq,softirq,nice], 34 cpuCores(bytes, %/core),
           36 fans{name:rpm}, 41 memBytes[total,used,buffCache,zfsArc], 42 swapBytes[total,used] }
Info   = { 0 hostname, 1 kernel, 2 cores, 3 threads, 4 cpuModel, 5 uptimeSec, 6 cpu%, 7 mem%, 8 disk%,
           10 agentVersion, 12 gpu%, 13 dashboardTemp, 14 os(0 linux,1 darwin,2 windows,3 freebsd),
           18 bandwidthBytes, 19 loadAvg[3], 21 extraFsPct{name:%}, 22 services[total,failed], 25 packageUpdates[total,security] }
Details= { 0 hostname, 1 kernel, 2 cores, 3 threads, 4 cpuModel, 5 os, 6 osName, 7 arch, 8 podman, 9 memTotalBytes }
Container = { 0 name, 1 cpu%, 2 memMB, 3 netSentMB(legacy), 4 netRecvMB(legacy), 5 health(0 none,1 starting,2 healthy,3 unhealthy),
              6 status(string, e.g. "Up 3 days"), 7 id, 8 image, 9 bandwidth[sentBps,recvBps], 10 ports, 11 updateAvailable }
```

### 4.5 Normalization and storage

Write a pure, unit-tested `normalizeCombinedData(raw) → { stats, info, details?, containers }`. It maps integer keys to readable short names: `cpu, mp, mu, mt, mb, sw, swu, d, du, dp, dr, dw, b:[s,r], la, t, efs, g, ni, cpub, cpus, f, bat`, and `info: h, k, c, t, m, u, cpu, mp, dp, v, os, g, dt, la, bb, sv, pu`. It prefers byte fields (`memBytes`, `bandwidth`, `diskIO`) and falls back to legacy fields.

For every GetData response:

- `UPDATE systems SET info=?, status='up', last_seen=?, agent_version=?` (and `details` when present)
- `INSERT system_stats(type='1m')` and `INSERT container_stats(type='1m')` if containers exist
- evaluate system threshold alerts (§7.3)

### 4.6 Rollups and retention (same as Beszel)

| type | made from | every | keep | chart range |
| --- | --- | --- | --- | --- |
| 1m | agent | 60 s | 1 h | 1 hour |
| 10m | 1m | 10 min | 12 h | 12 hours |
| 20m | 10m | 20 min | 24 h | 24 hours |
| 120m | 20m | 2 h | 7 d | 1 week |
| 480m | 120m | 8 h | 30 d | 30 days |

A rollup averages every numeric leaf, including nested maps and arrays. It also keeps `*m` max fields for cpu, bandwidth, and disk I/O, so charts can show peaks. Containers are averaged per container name. The cron runs rollups when `minute % N == 0`.

## 5. Monitors

Common fields are listed in the `monitors` table. The `config` JSON per type:

| type | config | check |
| --- | --- | --- |
| `http` | `{ url, method="GET", headers?:{}, body?, accepted_codes=["200-299"], keyword?, invert_keyword?, json_path?, json_expected?, header_equals?:{}, follow_redirects=true }` | `fetch` with `AbortSignal.timeout(timeout_ms)`. Read at most 1 MiB. Accepted codes support ranges. The keyword is case-sensitive. `json_path` uses dots and `[i]`. Store latency. |
| `tcp` | `{ host, port }` | `connect()` from `cloudflare:sockets`; up when `opened` resolves before the timeout. Port 25 is blocked by Workers, so show a validation error. |
| `dns` | `{ name, record_type="A", expected?:string[], resolver="https://cloudflare-dns.com/dns-query" }` | DoH JSON (`accept: application/dns-json`). Any non-NOERROR status is down. With `expected`, every value must appear in the answers. |
| `heartbeat` | `{ period_s, grace_s }` | Passive. Down when `now > last_ping_at + period_s + grace_s`. Pending until the first ping. |
| `domain` | `{ domain, warn_days=30 }` | RDAP: IANA bootstrap `https://data.iana.org/rdap/dns.json` (cache 1 day), then `events[eventAction=expiration]`. Inside `warn_days` → degraded plus one warning per expiry date. Expired → down. Default interval 86400. |
| `system` | `{ system_id }` | Mirrors a Beszel system's up/down status, so a server can appear on a public page without its metrics. |
| `container` | `{ system_id, container_name }` | Up if the latest `container_stats` row for the system (≤ 3 min old) contains the container and health ≠ unhealthy. Down otherwise. |
| `group` | `{}` | Status = worst child status (down > degraded > maintenance > up). Never checked directly. |

Heartbeat ping routes on `PUBLIC_HOST`, any method (GET/POST/HEAD), rate-limited with the Workers Rate Limiting binding at 30/min per token:

| Route | Meaning |
| --- | --- |
| `/ping/:token` | success |
| `/ping/:token/start` | run started → status `running` until success, fail, or `period+grace` |
| `/ping/:token/fail` | failure; the POST body (first 1000 chars) becomes the message |
| `/ping/:token/:code` (0–255) | exit code; 0 = success |
| `?status=up\|down&msg=...&ping=<ms>` | Uptime Kuma push compatibility |

Responds `200 {"ok":true}` or `404`. The UI shows copy-ready `curl`, cron, and systemd examples (`ExecStartPre=…/start`, `ExecStopPost=…/${EXIT_STATUS}`).

### 5.1 Scheduler (cron every minute)

1. `SELECT ... WHERE paused=0 AND type IN ('http','tcp','dns','domain') AND next_check_at <= now`, ordered by `next_check_at`.
2. Budget subrequests. The Free plan allows 50 per invocation: reserve 5 for notifications and use at most 40 for checks. Run with concurrency 10. Leftover monitors wait for the next minute. Log what was skipped. Make the budget an env var (`SUBREQUEST_BUDGET`, default 40; Paid can raise it to 900).
3. Spread load: when a monitor is created, set `next_check_at = now + hash(id) % interval_s`.
4. After each check, apply `upside_down` (swap up/down; degraded stays degraded). Then apply retries: when `fail_streak < retries`, status stays the same, record it as a "pending retry" check, and set `next_check_at = now + retry_interval_s`. After that, transition the status.
5. Write a `checks` row and upsert `monitor_daily` (UTC day).
6. Evaluate the passive types: heartbeat deadlines, system/container mirrors, groups.
7. Maintenance: a monitor covered by an active window gets status `maintenance`, writes check status 3, opens no incident, and sends no alert. Uptime excludes maintenance time.
8. Status transitions drive incidents and notifications (§7).
9. Then rollups (§4.6). At 00:05 UTC: retention (`checks` > 7 d, `system_stats` per tier, `events` > 90 d, resolved incidents > 400 d).

**Same-zone caveat** (comment it in code and show it in the UI hint): a Worker's `fetch()` to a hostname in the *same Cloudflare zone* goes straight to the origin and skips the proxy. The check may not see what visitors see.

## 6. Status pages (public)

- `GET /` on `PUBLIC_HOST` renders the page with `is_default=1`. `/s/:slug` renders any published page. A request whose host equals `status_pages.custom_domain` renders that page at `/`. Custom domains are added as Worker custom domains out-of-band; document the `cf` command.
- Layout, modeled on FlareWatch and Uptime Kuma:
  - Header: logo, title, description, and a theme toggle.
  - Overall banner: "All systems operational" (green), "Partial outage" (amber), "Major outage" (red, >50% down), or "Under maintenance" (blue).
  - Active announcements (Markdown, severity color), then active and upcoming maintenance.
  - Groups, each with items. An item row shows: name (links to the target URL for http monitors unless hidden), status pill, uptime % (90 d), **90 daily bars** (color by that day's uptime: ≥99.9 green, ≥99 lime, ≥95 amber, else red, no data gray; tooltip with date, uptime, and incidents), and an optional 24 h latency sparkline. Beszel systems show only status and uptime. **Metrics are never exposed publicly.**
  - Incident history for the last 14 days: start, end, duration, cause.
  - Footer: custom text, "Powered by Richter", Atom feed link, "Last updated Xs ago". Auto-refresh every 60 s.
- Public JSON API: `GET /api/public/pages/:slug` (the full render model, cached 30 s with `Cache-Control: public, max-age=30`), `GET /api/public/pages/:slug/monitors/:id/latency?hours=24`.
- `GET /feed.atom?page=:slug`: the 50 newest incidents, maintenances, and announcements for that page.
- Badges: `GET /badge/:monitorId/status.svg`, `/uptime.svg?days=30`, `/latency.svg`. Shields-style flat SVG with optional `label`, `style`, and `color` params. Only monitors that appear on **some published page** get a badge. Everything else returns 404.
- `GET /embed/:monitorId?theme=dark|light`: a small iframe card. The embed route can be framed by anyone. Status pages can be framed only by `DASHBOARD_HOST`, for the editor's live preview: set CSP `frame-ancestors 'self' https://DASHBOARD_HOST` through a static-assets `_headers` file. Worker-handled routes send `X-Frame-Options: DENY`.

## 7. Notifications and alerts

### 7.1 Channels

Each `notifications.type` has a config shape and a sender `send(channel, message): Promise<void>`:

| type | config |
| --- | --- |
| discord | `{ webhook_url }` (embed with color by status) |
| slack | `{ webhook_url }` |
| telegram | `{ bot_token, chat_id }` |
| ntfy | `{ server="https://ntfy.sh", topic, token?, priority? }` |
| gotify | `{ server, app_token, priority? }` |
| pushover | `{ user_key, app_token }` |
| webhook | `{ url, method="POST", headers?, body_template? }`; the template supports `{{name}} {{status}} {{message}} {{url}} {{time}}`. Default body is the JSON event. |
| email | `{ to }` via Cloudflare Email Service `send_email` binding (optional, behind a feature flag) |

The UI has a "Send test" button per channel. `apply_default=1` channels are pre-selected on new monitors and systems. An "Apply to all existing" toggle (`apply_existing: true` in the POST/PATCH body) attaches the channel to every current monitor and system.

### 7.2 Monitor events

- `up → down` (after retries): open an incident, notify "🔴 {name} is DOWN: {message}".
- `down → up`: close the incident, notify "🟢 {name} is UP (down for {duration})".
- While down, when `resend_every > 0`, notify again every N failed checks ("still down, reminder #k").
- Domain or cert inside the warning window: one warning per expiry date.
- No notifications during maintenance. Dependencies: monitors in a `group` whose group is already down send one grouped alert, not N.

### 7.3 System (Beszel) alerts

These work like Beszel. Per system you can set `Status` (down/up), plus `CPU`, `Memory`, `Disk`, `Temperature` (max sensor), `LoadAvg5`, `Bandwidth` (MB/s), and `GPU`, each with a threshold and `minutes`. A threshold alert triggers when the **average over the last `minutes`** of 1m records exceeds the threshold. It resolves when the average drops below it. Each alert notifies once on trigger and once on resolve.

## 8. Admin API (`/api/admin/*`, JSON, Access-verified)

```
GET    /me                                → { email }
GET    /overview                          → counts, overall status, recent events
GET    /settings  PUT /settings           → site_title, timezone; hub_public_ssh (read-only)

GET    /systems                           → list with latest info + status
POST   /systems { name, tags? }           → { system, token, install: { compose, binary } }
GET    /systems/:id   PATCH   DELETE
POST   /systems/:id/pause | /resume | /reset-fingerprint | /rotate-token
GET    /systems/:id/stats?range=1h|12h|24h|1w|30d       → [{ created_at, stats }]
GET    /systems/:id/containers?range=...                → [{ created_at, stats:[...] }]
GET    /systems/:id/alerts   PUT /systems/:id/alerts    (replace the full set)

GET    /monitors                          → list with status, 24h uptime, last latency, sparkline (last 30 checks)
POST   /monitors  GET/PATCH/DELETE /monitors/:id
POST   /monitors/:id/pause | /resume | /clone | /check-now (runs once, returns result, saves nothing)
GET    /monitors/:id/checks?hours=24      → raw checks
GET    /monitors/:id/uptime               → { h24, d7, d30, d90, d365, avg_latency_24h, cert_days?, domain_days? }
GET    /monitors/:id/incidents

CRUD   /notifications   POST /notifications/:id/test
CRUD   /status-pages    (layout as JSON)
CRUD   /maintenances
CRUD   /announcements
GET    /events?limit=100
GET    /export   POST /import             → full JSON backup and restore (monitors, pages, channels, systems minus tokens)
```

Validate every body with **zod**. Errors are `{ error: string, field?: string }` with 400/404/409.

`GET /metrics` on `DASHBOARD_HOST` serves Prometheus text format (`richter_monitor_up{name,type}`, `richter_monitor_latency_ms`, `richter_system_cpu_percent`, `..._mem_percent`, `..._disk_percent`, `richter_system_up`). It is protected by Access; document using an Access **service token** from Prometheus.

## 9. Dashboard UI (private, Beszel look and feel)

Use a sidebar or top navigation with these sections: **Systems** · **Monitors** · **Status pages** · **Incidents & maintenance** · **Notifications** · **Settings**. Add a command palette (`Ctrl/⌘+K`) to jump to any system or monitor.

### Systems (Beszel parity)

- **Table:** status dot; name; CPU, memory, and disk as colored meters (green < 65, amber < 90, red ≥ 90); GPU; network (MB/s); load avg; temperature; agent version; uptime. Sortable columns, a search filter, and tag filter chips. Toggle between grid cards and table. Live refresh every 15 s.
- **Add system dialog:** name → shows the token, `KEY`, and the copyable docker-compose and binary snippets (§4.2). It waits, with a spinner, until the agent connects.
- **System detail page:** a header with hostname, OS, kernel, CPU model, cores/threads, uptime, and agent version. A range selector: 1 h / 12 h / 24 h / 1 w / 30 d. Charts are Recharts area charts with a synced tooltip and gradient fills:
  - CPU usage (+ breakdown stack when available), Memory (used / buff-cache / zfs arc, stacked), Swap, Disk usage, Disk I/O (read/write), Bandwidth (sent/received), Load average (1/5/15), Temperatures (one line per sensor, toggle legend), GPU usage/power/VRAM, Extra filesystems (usage and I/O each), Battery, Fans.
  - Docker containers: CPU, memory, and network stacked by container, plus a containers table (name, image, status, health, CPU, memory, network) with a filter box.
  - Per-core CPU heat strip from `cpus`.
- **Alerts dialog per system:** toggles and sliders for each metric (§7.3) and the notification channels to use.

### Monitors (Uptime Kuma parity)

- **List:** grouped by `group` parent, with tags, status, a 24 h uptime %, and a heartbeat bar of the last 30 checks as tiny colored pills, like Uptime Kuma.
- **Detail:** status, a latency chart (24 h / 7 d / 30 d), uptime cards (24 h / 7 d / 30 d / 1 y), cert/domain expiry, the last 100 checks, incidents, and buttons for check now / pause / clone / edit / delete. Heartbeat monitors show the ping URL with copy buttons and examples.
- **Create/edit form:** pick the type, then show only that type's fields; common settings sit in collapsible sections; channel checkboxes; and a "Test" button that calls `check-now` before saving.

### Status pages editor

The editor lists pages with "Open" links. It has drag-and-drop groups and items (`@dnd-kit/core`), an item picker that searches monitors and systems, page settings (slug, title, description, logo URL, custom domain, footer, accent color, custom CSS, toggles), and a live preview pane in an iframe.

### Incidents & maintenance

This section holds the open and recent incidents, the maintenance CRUD (one-off or repeating; covered monitors and systems; timezone-aware date pickers), and the announcements CRUD with a Markdown preview.

### Settings

Settings shows the site title, timezone, and hub public key (copy). It also has export/import JSON, an About section with version info, and an Access identity readout.

## 10. Quality bar

- **Tests:** `vitest` + `@cloudflare/vitest-pool-workers` for:
  - the CBOR round-trip of HubRequest/AgentResponse, using fixtures built from the Go struct tags above
  - Ed25519 signing (verify with Node's `crypto.verify` against the SSH-wire public key)
  - `normalizeCombinedData`, the rollup averaging, the status-transition state machine (retries, upside-down, maintenance, resend), the accepted-codes parser, the JSON path, and the heartbeat routes
  - Access JWT verification with a locally generated RSA key
- **Seed script** `npm run seed`: demo monitors (https://example.com, https://cloudflare.com keyword "Cloudflare", 1.1.1.1:53 TCP, DNS for example.com, one heartbeat), a default status page "Richter Status" with two groups, and one ntfy channel (disabled).
- **README:** deploy steps using `cf` only:
  1. `npm i`
  2. `cf d1 create richter-db`, or let `cf deploy` provision it
  3. Set vars
  4. Create the Access application for `DASHBOARD_HOST`
  5. `cf deploy`
  6. Add a system and paste the snippet
- No placeholder "TODO" pages. Every nav item works. The UI is responsive (status pages must look good on phones). Empty states have helpful copy. Loading states use skeletons.
- **Security:** escape all user text (Markdown is rendered via a sanitizer); the CSP; tokens generated with `crypto.getRandomValues`; heartbeat tokens 32+ chars; constant-time token comparison; never log tokens.

## 11. Delivery checklist (do these in order, verify each)

1. Scaffold (`cf init`-style layout), config, D1 binding, DO export, cron, domains.
2. DB migrations and settings bootstrap (hub key).
3. Beszel DO and handshake. Verify against a real agent: `docker run --rm -e HUB_URL=… -e TOKEN=… -e KEY="…" henrygd/beszel-agent`. Confirm stats rows appear in D1.
4. Monitors and the scheduler; verify with `cf dev` and the local cron test.
5. Admin API and Access JWT verification.
6. Dashboard UI.
7. Public status page, badges, feed, embed.
8. Notifications.
9. Tests green, `cf deploy`, smoke-test both hostnames.

## 12. Known gotchas (found while building the reference demo)

- **Hono routes:** a regex param followed by a literal suffix (`/badge/:id/:kind{status|uptime}.svg`) never matches. Match the whole segment (`/badge/:id/:file`) and parse it.
- **zod:** `.default()` survives `.partial()`. A shared create/update schema with `config: z.record(...).default({})` makes every PATCH overwrite `config` with `{}`. Keep defaults out of shared schemas.
- **CBOR:** decode with `cborg` `{ useMaps: true }`. Integer keys are otherwise rejected. Per-core CPU (`34`) arrives as a CBOR byte string (`Uint8Array`).
- **First agent sample:** network, disk I/O, and bandwidth are delta-based, so the first record reports 0. Charts must not treat that as a dip worth alerting on.
- **Durable Object WebSockets:** when a new agent connection replaces an old one, the old socket's `webSocketClose` must not reschedule the alarm. Filter `getWebSockets()` by `readyState === WebSocket.OPEN`.
- **Access before deploy:** create the Access application first, so its AUD tag is known at deploy time. Until `ACCESS_AUD` is set, the admin API must fail closed (401), never open.
- **`cf dev` auth:** requests to `localhost` skip Access verification, so the dashboard works locally. Production requests always carry the routed custom hostname.
- **Local cron test:** `POST http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=<name>` with `{"cron":"* * * * *"}`.
- **workers.dev:** set `workersDev: false` and `previewUrls: false`. Only the two custom domains should serve traffic.
- **Workers egress:** `connect()` cannot reach Cloudflare-owned IPs. A TCP check of `1.1.1.1:53` fails with "cannot connect to the specified address", so show a validation hint for that. Some APIs return 403 to Worker egress IPs without auth (e.g. `api.github.com`). Seed demo monitors with targets that accept Worker traffic.
- **Cron propagation:** a brand-new cron trigger took about 9 minutes to fire for the first time after the first deploy. Do anything the UI needs on first load (hub key, schema) lazily in `fetch`, not only in `scheduled`.
