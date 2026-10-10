# Remote access under the localDot domain

Status: Worker deployed on 10 October 2026 for `*--dot.localdot.dev/*`. Wildcard DNS setup
and public connection verification are still pending; the service is not ready for users yet.

**Optional, off by default.** There is no relay connection until a user enables it. Local access,
Tailscale, and SSH continue to work independently. We never fall back to the public relay
automatically. The choice persists across restarts; users can turn it off at any time.

Users enable **Settings → Your computer → Remote access**, copy a one-minute sign-in link,
and open it on their other device. No router changes, public host ports, or separate VPN app.
The computer running localDot must stay awake and online.

## Research and decision (10 October 2026)

The first version uses a Cloudflare Worker and one Durable Object per connected installation.
The daemon opens an outbound authenticated WebSocket. HTTP requests and the existing desktop,
chat and control WebSockets return through it. This is a full relay: the server remains in the
traffic path. It is not a direct peer-to-peer connection.

This costs less engineering work than replacing our existing transport with WebRTC. Workers has
no separate bandwidth/egress charge; Durable Objects bills incoming messages at 20:1, and
hibernation avoids idle duration charges. Both ends connect *into* the Durable Object, so its
WebSockets can hibernate. Heartbeats use the runtime's auto-response instead of object timers.
There are no database writes for frames, requests, or presence and no per-user virtual machines.

Published prices, in USD:

- Workers paid account: $5/month minimum, including 10 million Worker requests.
- Durable Objects: 1 million billed requests and 400,000 GB-seconds/month included;
  excess $0.15/million requests and $12.50/million GB-seconds.
- At a conservative 128 MB per active object, an active device-hour is 460.8 GB-seconds:
  $0.00576 after the allowance. Thirty incoming messages/second adds 5,400 billed requests/hour:
  $0.00081. Total about $0.00657/hour, before other requests, storage, logs and taxes.
- As an illustrative workload, 1,000 active device-hours/month at 30 messages/second is roughly
  $6.42/month including the $5 plan and those allowances. This is a model, not a measured bill.
  Idle objects must actually qualify for hibernation; pending HTTP requests incur active time.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
Use the paid Developer Platform for production; do not assume free CDN/Tunnel terms cover an
arbitrary desktop-video service. See [Cloudflare's explanation of its content terms](https://blog.cloudflare.com/updated-tos/).

Alternatives considered:

| Option | Fit |
| --- | --- |
| Cloudflare Tunnel | Mature transport, but per-installation provisioning, another executable, account tunnel quotas, and video delivery terms need additional work. |
| WebRTC with signaling and TURN fallback | Allows direct traffic and is a future option. Requires a new transport for every app operation. Direct connections are not guaranteed. TURN is $0.05/GB after a shared 1,000 GB monthly allowance. |
| Small VPS with a reverse tunnel | Simple fixed server bill, but we operate bandwidth capacity, TLS, availability and updates ourselves. |
| Worker + hibernating relay | Reuses existing app behavior, no server to maintain, no per-GB Worker charge. Selected for the first version. |

WebRTC references: [peer connections](https://webrtc.org/getting-started/peer-connections),
[TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/).

## Privacy and limits

TLS protects both network legs; this is **not end-to-end encryption against the relay operator**.
Cloudflare/the relay can process app traffic and serves the frontend, so users must trust that
operator. Settings explains this before the user enables the service. The service stores no conversation, screen, file or credential payloads.
Do not add request bodies, cookies, authorization, URL fragments, or channel payloads to logs.

Each installation has its own hostname and random owner key. The hostname is derived from its
owner key, preventing another installation from claiming it. A separate pairing secret gates all
app traffic, and the daemon still checks its own bearer token or stream ticket. A fresh app sign-in
uses the existing one-use, one-minute installation code. Pairing secrets are transmitted in URL
fragments, removed immediately, then exchanged for a Secure/HttpOnly/SameSite cookie. No secrets
are placed in URL query strings. Turning remote access off rotates the pairing secret.

The host connector can reach only its own loopback daemon port; it is not an arbitrary destination
proxy. Request Origin is checked, hop-by-hop and forwarding headers are rebuilt, the daemon's
Host guard permits only the enabled exact hostname, and host-only file opening remains blocked
for remote requests. Redirects from the local service are returned, never followed by the connector.

Uploads are limited to 100 MiB and streamed in 64 KiB chunks. Responses are pulled one chunk at a
time. Each installation has a bounded number of channels; WebSocket frames are capped at 4 MiB.
Slow or broken transfers close with an explicit error. Reconnect never replays an HTTP action.
Invocation logs and automatic HTTP traces are disabled because desktop URLs contain stream
tickets. Payload-free application logs are sampled; monitor usage before increasing rollout size.
Add deployment rate limits on connection/pairing endpoints and billing alerts before a public launch.

## Deployment

1. Choose the existing Cloudflare-managed apex domain. Device addresses use
   `<installation-id>--dot.<your-domain>`, so standard Universal SSL covers them without buying
   a nested wildcard certificate. The existing website keeps its hostname and route.
2. Set `REMOTE_DOMAIN` in `apps/remote/wrangler.jsonc` to the apex domain. Add the Worker route
   `*--dot.<your-domain>/*` for that zone and a proxied wildcard DNS record. Check existing wildcard
   DNS usage before adding one. The Worker rejects anything outside its exact device hostname
   pattern, and rejects plain HTTP. Enable HTTPS redirects for this hostname space.
3. Run `pnpm --filter @localdot/remote types`, `build`, and `test`, authenticate Wrangler to the
   intended account, then deploy with `pnpm --filter @localdot/remote run deploy`.
4. Configure the daemon's service address with `~/.localdot/remote-service.json` containing
   `{"domain":"<your-domain>"}`. This file works with the installed service's clean environment;
   `LOCALDOT_REMOTE_DOMAIN` is also supported for manually started daemons. The service remains
   off until the user enables it. Restart the daemon when no task is active; never replace the
   computer. A release can ship the service configuration once the production domain is verified.
5. Enable the switch in Settings. Wait for Connected, copy a link, and open it on a different
   network. Check desktop video, controls, chat, file upload/download, reconnect and revocation.

No Cloudflare account token is shipped to users. The Worker handles only the dedicated hostname
space. `workers.dev` and preview URLs are disabled so those routes cannot accidentally become an
alternate authentication origin. Local tests use isolated Workerd instances and synthetic data.

`~/.localdot/remote-access.json` stores the opt-in state and random keys with mode 0600.
Changing the configured relay domain disables access until the user enables it again.

Certificate/routing references: [Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/),
[Worker route patterns](https://developers.cloudflare.com/workers/configuration/routing/routes/).

## Validation

`pnpm test:remote` builds and exercises the Worker in Workerd with the real Node connector:
HTTP upload/download, binary and text WebSockets, first-frame delivery, hibernation, reconnect,
revocation, origin isolation, and prompt failure when the local socket refuses a connection.
CI runs this check. Browser tests cover pairing, opt-in, link copying, and narrow mobile layout
in Chromium and WebKit. A real cross-network desktop-stream check remains part of deployment;
local tests do not prove production DNS, certificates, latency, or the estimated bill.
