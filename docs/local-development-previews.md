# Local development previews

## Incident and root cause (13 October 2026)

Session `01M4VCYV6JA9JWPZE5XZ2A6KAA` started Portless successfully and registered
`https://thema.localhost:1355` to a local app. Portless reported that
`update-ca-certificates` could not write the system trust store. The visible desktop
Chromium reached that URL and displayed **Privacy error**; an independent TLS probe
reported an untrusted self-signed chain. Port 1355 was not blocked.

The desktop navigation route returned a failure, but the daemon replaced every
non-success response with **tool request refused**. The agent guessed a port-policy
restriction and stopped. The ordinary HTTP preview's WorkOS error was a different
application configuration/callback problem, not evidence of a browser port restriction.

## Policy

The existing two-browser boundary is retained:

- Project servers run inside the desktop. `browser_navigate` sends localhost,
  loopback addresses and `.localhost` subdomains (including worktree names) to its
  visible Chromium, with the supplied scheme, port and path intact.
- The desktop's managed, disposable browser uses Chromium's
  `--allow-insecure-localhost` development option. The exception is evaluated by
  Chromium per URL; HTTPS fetches and WSS live updates on localhost work too.
  It does not import a project CA into the host or the saved-account browser.
- The saved-account browser retains strict TLS validation and network isolation.
  Public-host certificates still fail even when that hostname resolves to loopback;
  redirects from a local preview do not inherit its certificate exception. LAN
  hosts, custom public hostnames and `.test` names are not automatically trusted.
- Chromium's genuinely unsafe service ports remain blocked. This does not prohibit
  normal development ports such as 1355, 3000, 4173, 5173 or 8443.
- A local URL refers to the **desktop container**, not the user's host computer.
  This change neither forwards arbitrary host services nor exposes the signed-in
  browser's control channel to project code.

Navigation failures carry a bounded category: certificate, connection, DNS, unsafe
port, timeout, missing page, target identity or other network failure. The daemon
maps these categories to fixed recovery guidance instead of trusting arbitrary error
text. It also recognizes the older desktop's known plain-text network errors during
rolling upgrades. HTTP authorization failures remain authorization failures.

The agent must keep a project's intended preview origin (important for OAuth),
check server readiness when connection fails, and inspect the visible page after
navigation. Missing WorkOS configuration or test-account access requires a specific
input request. Unit-test success is not evidence that an authenticated UI flow passed.

## Comparison and sources

Reviewed official documentation on 13 October 2026:

- [OpenAI's built-in browser documentation](https://developers.openai.com/codex/app/browser)
  describes a shared visible browser, local app previews, a localhost:3000 example,
  and website-specific permissions. It does not document its internal TLS policy.
- [VS Code integrated browser](https://code.visualstudio.com/docs/debugtest/integrated-browser)
  treats localhost and loopback links as first-class development targets.
- [Cursor browser](https://cursor.com/docs/agent/tools/browser) documents origin
  allowlists, including an explicit localhost port. Permissions concern the target
  origin, rather than treating every custom port as an unknown site.
- [Playwright web servers](https://playwright.dev/docs/test-webserver) supports starting
  and waiting for development servers, distinct from interacting with the UI. Its
  readiness HTTPS-error option is explicit and defaults to strict validation.
- [Portless](https://github.com/vercel-labs/portless) documents named localhost
  origins, worktree subdomains, local CA trust, custom ports, and WebSocket proxying.
  Keeping its URL matters for host routing, cookies and authentication callbacks.
- [Chromium SSL implementation](https://github.com/chromium/chromium/blob/main/content/browser/ssl/ssl_manager.cc)
  applies the development exception only when `net::IsLocalhost(request_url)` and
  `kAllowInsecureLocalhost` are both true. We use that narrower mechanism instead of
  globally ignoring certificate errors or expanding the public-browser network policy.

These are documented capabilities, not claims about proprietary internal architectures.
No public evidence reviewed establishes how Grok privately implements local previews.

## Regression coverage

`desktop-preview.docker.test.ts` runs a visible, managed Chromium in a disposable
network-isolated desktop image. A synthetic server on port 1355 uses an untrusted
certificate. The fixture exercises localhost and nested subdomains, HTTPS API fetch,
WSS updates, pointer input, and screenshot capture. It also checks invalid public
certificates, a misleading localhost-like hostname, a redirect to an invalid public
certificate, a stopped server, and a genuinely unsafe port.

Run after building the desktop image:

```sh
LOCALDOT_DOCKER_TESTS=1 LOCALDOT_DESKTOP_IMAGE=localdot/desktop:dev \
  pnpm exec vitest run --config vitest.docker.config.ts \
  apps/daemon/src/cells/desktop-preview.docker.test.ts
```

Session-controller tests verify that preview navigation selects the desktop and does
not use the signed-in browser. Transport tests verify current and older-image error
classification and ensure arbitrary response bodies are not echoed as instructions.
The signed-in browser's launch test forbids the localhost TLS exception there.

## Verification on the affected computer

After activating the tested browser components and restarting the idle daemon,
`browser_navigate("https://thema.localhost:1355/")` returned HTTP 200 with
`loaded: true`, title **Thema (dev)** and the application's sign-in page. Its
subsequent SSO redirect reached `signin.thema.ai`, which displayed **Invalid
Redirect URI**: the redirect address did not match the registered callback.
The browser transport is working; authenticated UI flows remain unverified until
that application configuration is corrected.

The full image update rolled back safely because the existing computer has changes
to `/opt/localdot/desktopd.mjs` and `/var/lib/dpkg/status`. For this development
installation, only the tested desktop service bundle and browser launcher were
activated, with originals backed up under
`/config/.localdot-component-backups/preview-20261013/`. Installed packages and
project files were retained. This component activation does not resolve the separate
full-image migration conflict. Both the desktop and saved-account browser subsequently
reported Ready.

Validation: 329 focused TypeScript tests, 18 Python browser-profile tests, the
native Chromium preview regression, workspace typecheck/lint, 15 pinned offline
Codex probes and 9 native sandbox probes passed. These browser regressions use
synthetic data; they do not certify the application's four authenticated UI changes.

## Component-copy ownership and subsequent computer updates

A later full-image update can correctly refuse files that were patched directly in a running
computer. On 17 October, the two conflicting files (`/opt/localdot/desktop-browser.py` and
`/opt/localdot/desktopd.mjs`) already matched the target image byte-for-byte and had the same
permissions, but retained the macOS copier's UID/GID (`501:20`) instead of the image's `0:0`.
Migration compares ownership as well as contents; the update therefore rolled back, leaving
Update available. This was a deployment metadata conflict, not a successful update followed
by a stale badge.

Prefer building and activating images through the normal updater. Do not use `docker cp -a`
from a macOS source tree to install Linux runtime files: it preserves the host's ownership.
If an emergency component copy is unavoidable, preserve the target image's exact mode,
UID/GID and contents, and record both old and new metadata. Do not apply a recursive `chown`
to the computer or relax migration's protection for user-modified files.

For this incident, both runtime files and their metadata were backed up, exact target hashes
were verified, and only their ownership was corrected before retrying the normal updater.

## Opening previews on the owner's devices

A server dot starts in its computer can be opened on the owner's Mac and phone. A local address
in dot's messages or in a command's output (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, any
`*.localhost` name, or the computer's own network address, any port) gets **Open preview**. The
Activity panel's **Previews** tab lists every server listening in the computer, including ones that
never printed an address, with **Open** and **Stop**. Stop ends the preview link; the server keeps
running. Stored messages are never rewritten: the action is added when the text is shown.

Previews open only over Tailscale: one HTTPS address that works the same on the Mac and the phone,
on a site separate from this Mac's `localhost`. A preview never opens at `localhost:<port>`, which
shares cookies with every other local server and reaches the LAN outside the key layer. Without
Tailscale the app says so and points to **Settings › Your computer**. Previews are the owner's
only; shared links cannot list, open or stop them.

How a request travels:

1. desktopd listens on 7701 (the preview forwarder). The daemon sends one line,
   `LOCALDOT-PREVIEW/1 <desktopd token> OPEN <host>:<port>` or `... LIST`, and the forwarder
   answers `OK` (and the listing for `LIST`) or `NO <reason>`, then carries the server's bytes.
   `*.localhost` names and `localhost` dial both `127.0.0.1` and `::1`, since Vite and others bind
   `::1` alone. The forwarder refuses localDot's own services (3000, 3001, 3129, 7700, 7701, 8082,
   9222) and dials no address outside the computer. `LIST` reads listening sockets from
   `/proc/net/tcp{,6}`, named by their program where desktopd can see it.
2. The desktop's gate relays 8083 to desktop:7701 with its own bound of 64 connections
   (`LD_PREVIEWS=1`), so long-lived hot-reload sockets never hold up control (8081) or the
   stream (8082). Docker publishes it on the Mac's 127.0.0.1 like the other two.
3. The daemon gives each preview a loopback port from its block (`LOCALDOT_PREVIEW_PORTS`,
   default `4900-4915`; a port something else holds is skipped) and serves it there. One preview
   is one origin, so absolute asset paths and hot reload work unchanged. The request reaches the
   server as if sent to its own address: Host, Origin and Referer name it (Vite's `allowedHosts`
   and Next.js's `allowedDevOrigins` pass), redirects to it come back to the preview's address,
   and bodies are never rewritten. Only the tailnet fronts' names are accepted as Host (a page
   that rebinds its own name to this Mac is refused), and a WebSocket must come from the
   preview's own pages.
4. Signing in: the link carries a one-use secret after `#`, valid for two minutes. The entry page
   (`/__localdot/preview`, its own script, no inline code) posts it and receives an HttpOnly,
   Secure, SameSite=Lax cookie named for that port. Every request needs it; every preview cookie
   is removed before a request reaches a server, as are Tailscale's identity headers and
   forwarding headers. A server cannot set those cookies, HSTS, Alt-Svc or Clear-Site-Data. When a
   port served another server before, a device's first visit clears that origin's cache and
   storage (`Clear-Site-Data: "cache", "storage"`), so an old service worker cannot answer.
5. A preview ends on Stop, after two hours with no request or open socket, or when its computer
   stops, freezes or is replaced. `https://` servers are reached over TLS without checking their
   development certificate: the connection already ends at the computer's loopback.

The address handed back depends on how the owner reached localDot. An HTTPS front set up by
tailnet address (`LOCALDOT_PUBLIC_ORIGIN`, such as this Mac's `https://100.91.187.75:4744`) must
also listen on the preview ports, same numbers on the same address, proxying each to
`127.0.0.1:<port>`; when one is configured every preview uses it, and Tailscale Serve, which would
take the same ports on the same address, is not used for them. Otherwise, while Tailscale Serve
shares localDot, the daemon adds `tailscale serve --bg --https=<p> http://127.0.0.1:<p>` for each
port it actually holds and removes it when the preview ends (and removes leftovers in its block
before adding the first). See [remote access](remote-access.md#previews).

A computer made before previews has no forwarder or no preview relay, so the Previews tab says
**Update your computer to open previews** until desktopd answers on 7701. Computers update when
the owner presses Update (desktop and gate images together).

Not supported (open the page in the computer's own browser instead): pages that hard-code full
`http://localhost:…` addresses of other ports, cookies set for `Domain=localhost`, and OAuth
callbacks registered to localhost.

### Checks

- Unit: `pnpm exec vitest run packages/protocol/src/previews.test.ts apps/daemon/src/previews
  cells/desktop/desktopd/src/preview-forwarder.test.ts cells/desktop/desktopd/src/connection-owner.test.ts`
  (URL detection, the forwarder's line, refused ports and dialing, listing, allocation, the
  sign-in and cookie flow, the Host allowlist, header rewrites, WebSocket passthrough, Tailscale
  Serve through a stand-in CLI, states and expiry).
- Docker, after building the desktop and gate images:

  ```sh
  LOCALDOT_DOCKER_TESTS=1 LOCALDOT_DESKTOP_IMAGE=localdot/desktop:dev \
    LOCALDOT_GATE_IMAGE=localdot/gate:dev LOCALDOT_OLD_GATE_IMAGE=<a gate from before previews> \
    pnpm exec vitest run --config vitest.docker.config.ts apps/daemon/src/previews/previews.docker.test.ts
  ```

  It runs a Vite-like server (modules, a redirect, a hot-reload socket that checks Host and
  Origin) and a Portless-like HTTPS server with live updates inside a desktop behind its gate, and
  opens both through the daemon's listener, 120 module requests at once included.
- UI: `apps/web/e2e/ui/dev-previews.spec.ts` (see the UI harness README).
