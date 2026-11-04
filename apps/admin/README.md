# localDot statistics

Private dashboard: **https://admin.localdot.dev/stats**. Overview, Downloads, Audience and App
health share 24-hour, 7-day, 30-day and 90-day views. Tables and CSV exports complement the charts.
Inspired by ratemeoutof10's time-series, breakdown and health views; styled for localDot.

## Sources and limits

- Website homepage requests and successful installer script requests are counted at the edge,
  after the response, using `ctx.waitUntil`. Existing asset bodies, headers and caching survive
  unchanged. Failed database writes do not fail website or installer responses.
- Counts exclude HEAD, ranges, prefetch, known bots, DNT and GPC. Shell clients count for installer
  downloads, not website views. Counts are **requests, not unique people or completed installs**.
- D1 stores hourly totals and separate country, OS and recognised source buckets. No raw IPs,
  user agents, referral paths, query strings, persistent visitor IDs or cookies are collected.
  The bounded categories prevent attacker-controlled high-cardinality strings entering storage.
- GitHub's public release asset API supplies historical lifetime package downloads. Source ZIPs,
  container pulls and the legacy `localdot-downloads` repository are excluded. Updates, reinstalls,
  CI and repeat downloads can all count. The first import is a baseline, not today's growth.
- A six-hour GitHub Actions workflow imports public releases with its ephemeral read-only GitHub token (bounded pagination and response sizes). One bounded JSON1
  transaction records increments once even on retries, without per-package D1 round trips. Historical assets are retained at their
  last observed count if upstream deletes them. Import errors show a stale-data notice and keep
  the last successful totals. Daily increments are observed sync dates, not download timestamps.
- Existing problem reports supply counts by status/version and distinct **reporting installations**.
  Only aggregate SELECT queries run against that service's D1 database. No report content, sender
  token or installation ID is returned by this dashboard. Reports retains its own access policy.
- No telemetry is added to the local app or agent. Total installed users, active users, retention
  and task activity remain unmeasured; adding those requires a separate user-visible opt-in design.

Hourly counters and daily increments expire after 400 days. Release download totals remain.
The first request establishes the collection start; all earlier traffic history is unknown.

## Access

Set `OWNER_TOKEN` as a Worker secret (at least 32 random characters). This deployment uses the
existing localDot reports owner key, retained in the owner's private release directory. Never
put a credential in a URL, source, screenshots or logs. The login form exchanges it for an
eight-hour HMAC-authenticated HttpOnly, Secure, SameSite=Strict cookie. No client JavaScript or
localStorage is needed. Changing the secret immediately invalidates sessions. Login attempts
are limited using hourly HMAC address buckets; raw addresses are not stored and buckets expire.
POST login and logout require a same-origin Origin header. All admin HTML, JSON and
CSV use `no-store`, `same-origin` referrers, noindex and a restrictive CSP. No public collection API exists.

## Development and deployment

```sh
pnpm --filter @localdot/admin test
pnpm --filter @localdot/admin typecheck
pnpm --filter @localdot/admin exec wrangler d1 migrations apply localdot-stats --remote
pnpm --filter @localdot/admin exec wrangler deploy --dry-run
pnpm --filter @localdot/admin deploy
```

The admin Worker is separate from the local daemon, remote relay and reports service. Its D1 is
`localdot-stats`. Bind the same D1 as `STATS` on the website and downloads Workers using their
checked-in configs. Deploy those with the **existing verified assets**, not a new or holding-page
build. Downloads' `run_worker_first` targets only `/install.sh` and `/install.ps1`; catalog and
immutable bootstrap delivery retain the static-assets fast path. Future releases use the same
distribution config and retain instrumentation automatically.

Set the dedicated `GITHUB_INGEST_TOKEN` Worker secret and matching `LOCALDOT_STATS_INGEST_TOKEN` repository Actions secret. This write-only token authorizes `/internal/github`; it cannot read statistics or sign in. Run `stats-import.yml` once with workflow dispatch; it runs every six hours on the default branch. The Cloudflare cron only expires old aggregates. No personal GitHub token is stored in Cloudflare. Verify
anonymous stats/CSV requests return 401, a real login succeeds, current download counts match
GitHub, and website/installer bytes still match predeployment hashes. Never seed production with
demo traffic; browser fixtures use a local database only. Source and tests are sufficient to
rebuild the dashboard; no signing key or personal model token is needed.

References: [D1 batching](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/),
[GitHub release asset counts](https://docs.github.com/en/rest/releases/assets).
