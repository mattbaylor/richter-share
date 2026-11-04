# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private **Report a vulnerability** form (Security tab) on this repository, with steps to reproduce.

## How Richter is protected

- The dashboard and `/api/admin` answer only on `DASHBOARD_HOST`, which must sit behind a Cloudflare Access application. The Worker also verifies the `Cf-Access-Jwt-Assertion` JWT against `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, so a missing Access policy fails closed.
- Read-only users get `403` on every change, and secrets (notification credentials, agent and push tokens) are masked for them.
- `PUBLIC_HOST` serves only status pages, badges, embeds, the Atom feed, `/metrics`, heartbeat pings and the agent WebSocket. Items with "Link to site" off never expose their URL or hostname in public payloads.
- Requests whose hostname is `localhost`/`127.0.0.1` skip Access for `cf dev`. Keep `workersDev` and `previewUrls` off (the default) so the Worker is reachable only on your custom domains.

## Operator checklist

- Never commit `richter.config.json`, `.dev.vars` or API tokens.
- Give `CF_ACCESS_API_TOKEN` only **Access: Apps and Policies → Edit** on one account.
- Treat agent tokens and heartbeat ping URLs as passwords; regenerate one from the dashboard if it leaks.
- Removing a dashboard user refuses their requests immediately, but their Access session lasts until it expires; revoke it in Zero Trust if needed.
