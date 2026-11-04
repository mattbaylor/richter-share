# Upgrading from the original Richter

This is for an existing deployment of the original Richter (the `cloudflare.config.ts` with hard-coded
hosts, a single `AgentConnection` Durable Object, and no `HUB` binding) that already has data in its
`richter-db` D1 database. In short: your data carries over, the schema migrates itself on first
request, and the only new required setting is `ownerEmail`.

## 1. Back up first

D1 Time Travel already keeps 30 days of restore points, but take an export as well:

```sh
npx wrangler d1 export richter-db --remote --output richter-db-backup.sql
npx wrangler d1 time-travel info richter-db   # note the current bookmark in case you need to roll back
```

## 2. Configuration moved out of `cloudflare.config.ts`

Hosts and ids are no longer hard-coded. Copy the example and fill it in with the values from your old
`cloudflare.config.ts`:

```sh
cp richter.config.example.json richter.config.json   # gitignored
```

| Key | Old place | Notes |
|---|---|---|
| `accountId` | `accountId:` | same account, so the existing D1 database and Durable Objects are reused |
| `dashboardHost` | `DASHBOARD_HOST` | |
| `publicHost` | `PUBLIC_HOST` | |
| `accessTeamDomain` | `ACCESS_TEAM_DOMAIN` | |
| `accessAud` | `ACCESS_AUD` | |
| `ownerEmail` | *(new, required)* | see below |
| `accessAppId` | *(new, optional)* | only for Settings → Access policy management |
| `subrequestBudget` | `SUBREQUEST_BUDGET` | default `40` |

Keep the Worker name `richter` and the D1 name `richter-db` (both unchanged in the config) so the
deploy binds to your existing database and Durable Objects instead of creating new ones.

**`ownerEmail` is required.** The dashboard now has roles (Full / Read-only). The original let anyone
who passed Cloudflare Access in; the new code only lets in `ownerEmail` plus whoever you add under
Settings → Access. If you leave it empty you'll pass Access and then get refused by the dashboard. Set
it to the email you sign in to Access with.

Optional: set a `CF_ACCESS_API_TOKEN` Worker secret (Access: Apps and Policies, Edit) together with
`accessAppId` if you want Settings → Access to keep the Access application's allow policy in sync with
the users list. Without it you add people to the Access policy yourself, as before.

## 3. Deploy

```sh
npm install
npx cf deploy --dry-run   # check that it targets your account, hosts and existing richter-db
npx cf deploy
```

The deploy adds a second Durable Object class, `Hub`, next to `AgentConnection`. Existing agents keep
their tokens and the hub key (both stored in D1), so they reconnect without being touched.

## 4. What happens to your data

All of this runs automatically on the first request after the deploy (`ensureSchema` in
`src/worker/db.ts`). Each migration runs in one transaction together with its `schema_version` bump,
so a failed step rolls back and is retried on the next request.

- **D1 schema.** The original build is at `schema_version = 1`, and migration #1 here is byte-for-byte
  the same as the original's, so only the new steps (2 onward) run. I tested this against a database
  created by the original code with sample data in it: every step applied cleanly and nothing was lost.
- **Check history (`checks`).** Copied into the new `check_buckets` table (one JSON row per monitor per
  hour) *before* `checks` is dropped. Uptime bars and latency history stay intact.
- **Daily uptime (`monitor_daily`).** Rebuilt as a `WITHOUT ROWID` table. Every row is copied first,
  then the old table is replaced.
- **Live monitor state** (status, fail streaks, next check time) now lives in the `Hub` Durable Object.
  On first start it's seeded from the existing `monitors` columns, today's `monitor_daily` and the last
  48 h of `check_buckets`, so nothing resets.
- **System metrics (`system_stats` / `container_stats`).** These now live in each system's
  `AgentConnection` Durable Object. The first time each system connects, its rows are imported from D1
  into the object (1-minute data within retention plus all the rolled-up tiers) and then deleted from
  D1. The tables stay in place, just empty.
- **New tables/columns** (`system_packages`, `system_services`, `system_daily`, `notification_log`,
  `users`, a few `status_pages`/`systems` columns) are created empty with defaults that match the old
  behaviour.

One caveat: the storage step copies the whole `checks` table in a single D1 transaction. With the
original retention this is fine, but if your `checks` table has grown very large (millions of rows)
and the first request fails with a D1 timeout, prune old rows (for example
`DELETE FROM checks WHERE ts < <ms timestamp>`) and load the dashboard again.

If your running build is older than the last commit of the original repo (from before it had the
`schema_version` setting), deploy that last original commit once first, so the database is at version 1.

## 5. Package and security update alerts

These alerts don't need a custom or patched agent. Update checking is built into the **stock Beszel
agent from v0.21.0 onward** (`henrygd/beszel`, `agent/package_updates.go`). Richter reads the counts the
agent already reports. The install commands in the dashboard (Systems → Add system / Install) use the
stock `get.beszel.dev` script and the `henrygd/beszel-agent` image.

What you need:

1. **Agent v0.21.0 or newer on each server.** Check the version on the system page. To upgrade, run
   `sudo beszel-agent update`, or re-run the Linux install command from the dashboard (it keeps the same
   token).
2. **Linux, installed as a binary/systemd service.** The agent skips update checks on macOS, Windows
   and FreeBSD, and *inside containers*: it turns the feature off when it sees `/.dockerenv` or
   `/run/.containerenv`. If a server runs the Docker agent, switch it to the binary install to get
   update alerts. Supported package managers: apt, dnf, zypper, pacman (needs `pacman-contrib`), apk,
   xbps.
3. **Fresh package lists.** On apt systems the agent runs `apt-get -s dist-upgrade` and never refreshes
   the lists itself, so leave `apt-daily.timer` enabled (Debian/Ubuntu default) or run `apt update`
   regularly. Otherwise the counts go stale. The check runs every hour; change it with
   `PACKAGE_UPDATES_INTERVAL` (a Go duration, `0` disables it) in the agent's environment.
4. **Turn the alerts on.** Open a system, click the bell (Alerts) and enable **Security updates**
   and/or **Package updates**, then pick the notification channels. The security alert notifies again
   whenever the count goes up. The package alert fires once when it crosses your threshold and clears
   when you're back under it. The system page also gets an Updates panel listing the pending packages.

Servers on an older agent just don't show update data. Everything else keeps working.

## 6. After upgrading

- Settings → Access: add anyone else who used the dashboard (Full or Read-only).
- The Notifications page has a **Notification log** of every send, including tests.
- New status-page options (system uptime bars, CPU sparklines, mobile sparklines) are in the status
  page editor. CPU and mobile sparklines are on by default; uptime bars are off.
