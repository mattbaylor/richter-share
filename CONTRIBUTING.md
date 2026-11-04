# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

1. `npm install`, then `npx cf dev` (no Cloudflare config needed locally) or the mock UI: `VITE_MOCK=1 npx vite --config vite.mock.config.ts`.
2. Before opening a PR: `npm test` and `npm run typecheck` must pass. Add a test for behaviour changes in `src/worker`.
3. Keep it free-plan friendly: avoid extra D1 writes, Durable Object storage writes or subrequests per cron tick, and say in the PR if a change adds any.
4. Use placeholder data in tests, fixtures and screenshots (`example.com`, `server-1`, `you@example.com`), never real hostnames, IPs, emails or tokens.
