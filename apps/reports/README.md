# localdot-reports

The Cloudflare Worker behind `https://reports.localdot.dev`: it receives localDot's problem
reports and gives the owner a page to read and track them. What a report holds and how it is
redacted is in [docs/diagnostics.md](../../docs/diagnostics.md); the bundle's schema is
`packages/protocol/src/reports.ts`, shared with the daemon, the CLI and the app.

## API

| Request | Who | What |
| --- | --- | --- |
| `POST /v1/reports` | anyone | A gzipped report (`content-type: application/vnd.localdot.report+gzip`, at most 2 MB, 4 MB inflated). Answers `201 {"id": "LD-XXXX-XXXX", "token": "…"}` |
| `GET /v1/reports/:id` | the sender (`Bearer <token>`) | `{id, status, receivedAt, updatedAt}`; never the owner's notes |
| `DELETE /v1/reports/:id` | the sender | Deletes the report and its bundle |
| `GET /v1/owner/reports?status=&q=&before=` | owner (`Bearer <OWNER_TOKEN>`) | 50 reports a page, newest first, with counts by status; `q` searches the ID, summary, description, notes, version, platform and installation ID |
| `GET /v1/owner/reports/:id` | owner | One report's details |
| `GET /v1/owner/reports/:id/bundle` | owner | The diagnostics, sent still gzipped (`content-encoding: gzip`) |
| `PATCH /v1/owner/reports/:id` | owner | `{"status": "new" \| "investigating" \| "fixed" \| "wontfix", "notes": "…"}` |
| `DELETE /v1/owner/reports/:id` | owner | Deletes the report and its bundle |
| `GET /` | owner | The owner page; it asks for the owner token and keeps it in that browser |

Reports are checked against the shared schema; anything else is refused. Each address may send
20 an hour (every attempt counts), each installation 6 an hour, and everyone together 500 a day.
Addresses are kept only as hashed hourly counters. Reports live 180 days: bundles expire from KV
on their own, and a daily cron (03:17 UTC) removes the rows and spent counters.

Storage: D1 `localdot-reports` (binding `DB`, schema in `migrations/`) holds each report's
details and the SHA-256 of its sender's token; KV (binding `BUNDLES`) holds `bundle:<id>`.

## Deploying

From `apps/reports`, signed in with `pnpm exec wrangler login` to the account in
`wrangler.jsonc`:

```sh
pnpm exec wrangler d1 create localdot-reports
# Put the printed database_id in wrangler.jsonc › d1_databases[0].database_id.
pnpm exec wrangler kv namespace create BUNDLES
# Put the printed id in wrangler.jsonc › kv_namespaces[0].id.
pnpm exec wrangler d1 migrations apply localdot-reports --remote
pnpm run deploy
# Make an owner token, keep it in a password manager, and give it to the Worker:
openssl rand -base64 32
pnpm exec wrangler secret put OWNER_TOKEN
```

`reports.localdot.dev` is a custom domain in `wrangler.jsonc`, so the deploy creates its DNS
record and certificate in the `localdot.dev` zone; remove any existing `reports` record first.
Until `OWNER_TOKEN` is set (32 characters or more), the owner page and API answer 503 and reports
are still accepted. To check the deploy:

```sh
curl -sI https://reports.localdot.dev/ | head -1                      # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://reports.localdot.dev/v1/reports  # 415
```

Then open `https://reports.localdot.dev/` and enter the owner token. Deploy the Worker before a
release whose reports carry new fields: it refuses fields it doesn't know.

## Developing

```sh
pnpm test:reports                       # builds, then runs test/ against Miniflare with D1 and KV
cd apps/reports
pnpm exec wrangler d1 migrations apply localdot-reports --local
printf 'OWNER_TOKEN=%s\n' "$(openssl rand -hex 24)" > .dev.vars
pnpm dev                                # http://127.0.0.1:8787
```

Point a daemon or `localdot report` at it with `LOCALDOT_REPORTS_URL=http://127.0.0.1:8787`.
Local state stays in `.wrangler/`; `.dev.vars` and `worker-configuration.d.ts` are not committed.
