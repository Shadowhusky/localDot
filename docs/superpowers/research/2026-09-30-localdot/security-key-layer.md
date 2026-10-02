# localDot — the "key layer": how Meta Muse does it, prior art, and a design for a localhost agent

Research date: 2026-09-30. Host context: Apple M3 Ultra / 96 GB, macOS 26.6.2, Docker Desktop (Engine 29.2.0 running; verified locally with `docker version`), no OrbStack / Apple `container` / Lume / Tart installed, LM Studio installed. Nothing in this document was tested end-to-end on this Mac unless explicitly marked "verified locally".

Conventions: **quoted text is verbatim** from the cited primary source. "UNVERIFIED" marks claims I could not confirm from a primary source. "Inference" marks my own reasoning. "(verified)" means I re-fetched the primary page/code myself. "[sub-agent]" marks facts that a parallel research pass collected from the cited primary pages and that I did not re-fetch. Part 2 quotes without a "(verified)" tag are [sub-agent] material.

---

## 0. TL;DR

- **Muse (Meta, launched 2026-09-08) is a personal-agent product that runs in a per-user cloud Linux VM ("Muse Secure VM").** The agent harness (codename "Hatch") runs inside a `systemd-nspawn` "runtime cell". Credentials live outside that cell in a separate daemon, `hatch-authd`. A separate host-side policy process, **Sentinel**, is the only way out to the network. Code in the cell only ever sees a **surrogate token minted by authd**. **Sentinel swaps in the real credential at the network boundary, after the specific request has been authorized.** Built-in connectors run as privsep workers outside the cell; each worker has its own credential allowlist. The browser is driven through a CDP broker outside the cell, and passwords are injected into the browser by that broker. Approvals are shown in client UI outside the chat and are "strict capabilities". Source: Meta's "How We Built Safety Into Muse" (2026-09-08). Meta has published no source code, whitepaper, surrogate token format, TTL, binding, or TLS-interception details.
- **The user's paraphrase is essentially right.** The bot gets a key that only means something to Sentinel/authd inside the VM, so it is worthless to anyone who steals it. The correct nuance: a leaked surrogate is useless *off-box*, but a hijacked agent can still *use* it through Sentinel. That is why Muse wraps substitution in policy, egress controls, taint tracking and human approvals. Also, surrogation did not protect Muse's *own* control-plane token: a 2026-09-21 Mac-client zero-day let unprivileged local malware capture the account token that controls the agent.
- **The same pattern is now an industry norm**, with several local, open-source implementations to copy or embed:
  - Placeholder-swap proxies: Docker Sandboxes `sbx` (closed; macOS microVMs; keychain plus a `proxy-managed` sentinel), microsandbox (Apache-2.0), Gondolin, Matchlock, Infisical Agent Vault, OneCLI, iron-proxy.
  - Sealed tokens: superfly/tokenizer.
  - Destination-side header injection (hosted): Vercel, E2B, Cloudflare, Fly Sprites.
  - The harness-side reference: Anthropic's sandbox-runtime plus the Claude Code on the web git/credential proxy.
- **Recommended localDot design: a host-side `keyd` daemon on macOS, outside the Docker/VM kernel.** It combines the vault (Keychain) + a surrogate registry (authd role) + one explicit egress gateway (Sentinel role: policy, SSRF guard, selective TLS termination with a name-constrained local CA, surrogate→secret swap, response scrubbing, audit, approvals) + an LLM gateway, an OAuth broker, a git gateway, DB proxies and a browser broker.
  - The sandbox is on a Docker `--internal` network whose only exit is a secret-free forwarder to `keyd`.
  - It holds only surrogates, the public CA certificate, and proxy config.
  - The browser runs in its own "browser cell", so cookies are not readable by the agent's shell.
  - High-risk actions go through typed host-side connector workers with out-of-band approval.

---

## 1. TASK 1 — Meta Muse: product structure and the exact key-layer mechanism

### 1.1 What "Muse" is (product structure)

| Thing | What it is | Evidence |
|---|---|---|
| **Muse** (the app/agent) | A personal AI agent launched on 2026-09-08. It runs on "Muse Secure VM, a dedicated, virtual machine (VM) that houses both the agent and a person’s data". Clients: the Muse app (iOS/Android), WhatsApp, the web (muse.ai), and a Mac desktop version. AI glasses are "in the coming months". The internal codename for Muse in the codebase is **"Hatch"**. | Meta Newsroom, "Introducing Muse…" (2026-09-08) https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ ; Meta Connect 2026 recap (2026-09-23) https://www.meta.com/blog/meta-connect-2026-everything-we-announced/ ; footnote in the safety blog ("Hatch is our internal name for Muse in the codebase.") |
| **Muse Spark** (1.1/1.2/1.3) | Meta Superintelligence Labs' proprietary model family that powers Muse ("powered by Muse Spark, Meta’s most capable model to date"). The safety post says "Muse Spark 1.3 is close to SOTA" on prompt-injection resistance. | Newsroom; safety blog; https://research.meta.ai/blog/introducing-muse-spark-1-3 (linked from the Newsroom page; not read in full) |
| **Muse Glimmer** (the model in this Mac's LM Studio as `meta/muse-glimmer`) | Open-weight **30B** agentic model, **Apache-2.0**, released 2026-08-10, "distilled" from Muse Spark ("We trained Muse Glimmer on Muse Spark's outputs using logit distillation"). HF `meta-models/Muse-Glimmer-30B`: created 2026-08-09, license apache-2.0, pipeline image-text-to-text, ~280k downloads (HF API, verified). **It ships no agent harness or security layer.** | https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model ; https://huggingface.co/meta-models/Muse-Glimmer-30B |
| **Muse Code** | "Meta's coding agent for the terminal and CI, built for Muse Spark". It is a native `muse` binary (closed; no public repo found) with default model `muse-spark-1.2`. It uses OS sandboxes (macOS **Seatbelt**, Linux **Bubblewrap**, a Windows sandbox) and network mode `proxy-only` by default ("Reviews new connections per destination"). Auth is a browser sign-in or `META_API_KEY`, which takes priority. | https://dev.meta.ai/docs/muse-code ; https://dev.meta.ai/docs/muse-code/permissions ; https://dev.meta.ai/docs/muse-code/auth |
| **Muse Confidential VM** (announced, not shipped) | "the whole VM, including a person’s data and conversations with Muse, is encrypted with a key only they hold, so not even Meta can access it" (Newsroom). The safety blog says it is "intended to cryptographically and verifiably prevent Meta from accessing data in your VM". It is in testing with "a small group of trusted testers", and source is being shared with external auditors. | Newsroom; safety blog |
| Muse Realtime Voice / Realtime Avatar, Muse Charm device, Mac app control ("Muse can now drive any app on your Mac") | Connect 2026 additions. | Connect 2026 recap |

Is the key layer open source? **No evidence that it is.** A GitHub search found no Meta repo for Muse/Hatch/Sentinel/authd. `facebookresearch/MUSE` is an unrelated 2018 word-embedding project. The only primary technical description is the safety blog below. Meta runs a bug bounty (up to $300k, and up to $130k for prompt injection affecting one user).

### 1.2 Primary source

**"How We Built Safety Into Muse"** — Tarek Sheasha (Software Engineer & VP, Meta Superintelligence Labs), 2026-09-08.
https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (`security.muse.ai` redirects here; verified with curl).
Supporting pages: the Newsroom launch post (above) and "How We Designed Muse" (https://introducing.muse.ai/), which says: "deterministic UI is non-negotiable: structured approval cards with clear accept/reject actions, and secure storage for your credentials."

### 1.3 The mechanism, component by component (verbatim quotes)

**Design stance**
> "the harness runs in its own isolated cell, it doesn’t see real credentials, and every interaction with the outside world runs through a Sentinel which the agent can’t override."
> "The right mental model is two isolated security domains on one box, not an LLM powered agent with root."

**The runtime cell (untrusted domain)**
> "The Hatch daemon (the core agentic harness) as well as the filesystem containing your workspace and files, and all the binaries and tools Muse executes on your behalf operate in a systemd-nspawn runtime container. Root inside the runtime cell is mapped to an unprivileged host user so runtime cell root is not host root. The cell gets its own root filesystem (including a full debian image) separate from the host filesystem where your other more sensitive data lives. It also gets a virtual network interface, filtered system calls (for example no io_uring), and limited kernel capabilities (for example no CAP_SYS_PTRACE and no CAP_NET_ADMIN)."

**The trusted domain: separate systemd units outside the cell**
> "Security-sensitive services exist outside the runtime cell. This split is important as the runtime cell is expected to process untrusted data."
> "hatch-safety operates an independent set of models and classifiers which inspect requests and responses to/from core model inference … Running these outside of the runtime cell means that attackers cannot disable these protections."
> "privsep workers execute built-in connector code with tightly scoped privileges, keeping the connected credentials out of scope of the agent."
> "hatch-authd is responsible for credential storage (including OAuth tokens for third-party services you choose to connect – these are stored in your VM, not in centralized Meta infrastructure) and for credential surrogation so your main agent never sees sensitive credentials."
> "Sentinel is the sole permission authority for connector actions and network egress."
> "All durable application state is stored in a postgres database separate from the runtime cell and from the credential store."
> "Proxies for inference and telemetry expose constrained paths to external infrastructure."

**IPC between the domains**
> "All communication between the runtime cell and other services in the VM happens via Unix domain sockets with SO_PEERCRED and peer ACLs. This provides kernel authenticated, least-privilege interprocess communication with no secrets to steal."

**Sentinel: egress and the surrogate swap (the core of the user's claim)**
> "Sentinel is a separate host-side agent from your Muse. It is the sole permission authority for approval to perform actions with connectors to third-party services and for all egress over the network. Muse proposes actions, but only Sentinel can grant permission to perform action."
> "Every concrete network request is governed by Sentinel at egress. Runtime traffic reaches Sentinel via a forward proxy configured with Linux networking controls (userns, veth boundaries and eBPF filtering). Sentinel can evaluate the destination at both layer 4 and layer 7: the hostname, the resolved and final destination IP address, the port, protocol, HTTP method, path, and the actual decoded request. SSRF restrictions prevent an apparently public hostname resolving private infrastructure after DNS lookup."
> "Sentinel also performs just-in-time credential insertion for any requests which need a secret or auth token. For all such requests, code in the runtime cell or a worker only ever sees a “surrogate” token, minted by authd. After the concrete network request is authorized, Sentinel will replace any surrogate tokens with the real credential, obtained from authd, at the network boundary. The agent never sees real tokens, which means any attempt to coerce the agent to reveal the actual secrets via prompt-injection or otherwise is futile."

**Taint-aware auto-allow ("tainted egress")**
> "Each tool execution process starts in a clean state and becomes tainted if it reads user data. Clean network requests that already qualify for a narrowly bounded auto allow policy — and which also pass other checks on the outbound URL — can be allowed through without bothering the user. … Tainted or unverifiable processes lose auto-allow and fall back to the normal approval flow. The implementation uses eBPF cgroup programs for network interception and process attribution, plus eBPF programs attached to Linux Security Module hooks we added for taint propagation."

**Connector policy and human-in-the-loop approvals**
> "When Muse wants to take action via a connector, the relevant connector tool is invoked in the runtime cell. That submits a request to Sentinel describing the connector, which method is to be invoked, the class of action, its scope, and context of what the user asked for from which Sentinel generates a user-visible purpose for the request. Sentinel evaluates the connector policy, which has been set by the user, and decides whether the action should be allowed, denied, or to ask the user."
> "A dialog is presented to the user directly within the client UI — not via their conversation with Muse — and their answer is routed directly back to Sentinel, which acts on the user’s decision."
> "Approvals granted via the human in the loop system are strict capabilities, not conversational suggestions. They’re bound to the particular connector/destination and use case. Muse has support for obtaining one-time, session-scoped, task-scoped, time-bounded, or perpetual permission. Sentinel decides which grant types to present for the user to choose between and ensures that subsequent invocations match the granted scope exactly."

**Privsep connectors: credential-capable code never runs in the cell**
> "Built-in connectors have CLIs which run in the runtime cell which simply parse their arguments, open any files the caller is already allowed to access, and pass typed arguments and file descriptors over a Unix socket. A systemd sandboxed worker then executes the business logic of the tool."
> "Each worker is identified by its cgroup and has explicit credential allowlists. A calendar worker cannot ask authd for an email credential simply by changing a request parameter."
> "Privsep decides where credential capable code executes / Authd decides which credential material the authenticated caller can receive / Sentinel decides whether the requested action may be taken"
> "Where the underlying service supports it, Muse separates out read and write access. … The system adds finer-grained controls at the connector, process, credential, and request levels."
> "Muse’s email connector filters out one-time tokens, password reset links, and login magic links via both deterministic filters and a classifier model."

**Browser logins: password injection without agent visibility**
> "we present a custom UI on the client to capture your username and password, route them directly to authd, and store them in the secure credentials store outside the runtime cell in the Muse VM. What you enter goes straight to secure storage and is not visible to your main agent, but gets injected into the browser window at the point of need."
> "The browser is managed by a separate broker that manages the Chrome DevTools Protocol connection. The sub-agent, which drives the Browser, sees an accessibility tree snapshot of the page — not the raw DOM. (This also means it can’t read credentials entered from the credential store, or manually back out of the DOM.) It has no ability to run javascript in the page context, no script verbs, no exec in the browser process, and Chrome devtools are disabled. When the user takes over control of the browser, or while secure credential storage is filling a form, the agent is paused and can’t act at all."
> "CDP access is in a broker outside the runtime cell and the browser agent gets a narrow, controlled interface to it."

**Payments: a naturally bound, low-value credential**
> "When making a payment, a single-use card number is issued … The credential is tied to that particular merchant, a particular dollar amount, and only valid for a limited period of time. This way, even if it were stolen via prompt injection or some other attack, it would not be particularly useful to the attacker."

**Where credentials physically live**
> "credentials and auth tokens for any third-party services you connect — they’re stored in a separate isolated container in your VM, not in other Meta services."
> Newsroom: "Muse has no visibility into people’s passwords or payment methods. Any credentials a person shares go into secure storage, so Muse can use them without seeing them, including passwords a person types into the browser themselves." / "Nothing Muse does reaches the internet unless the Sentinel approves it".

**Trust in Meta (outside the key layer)**
> "It restricts access to your data by Meta personnel through operational policies. It does not prevent Meta from accessing data when necessary to support, secure or operate the service." (Confidential VM is the planned fix.)

### 1.4 What is NOT published (UNVERIFIED / unknown)

- **Surrogate format, entropy, TTL, and binding.** Meta does not say whether a surrogate is bound to a destination host, a worker/cgroup, or a session. Per-worker credential allowlists and authd ACLs imply caller-bound issuance (inference).
- **How Sentinel sees "the actual decoded request" over HTTPS.** Evaluating the HTTP method and path and swapping a token inside TLS requires terminating TLS at Sentinel. That implies a CA trusted inside the cell, or proxy-aware clients, but Meta does not describe it (inference).
- **Whether responses are scrubbed** for reflected real credentials, and whether surrogate use toward a non-authorized host is blocked or merely left unsubstituted.
- **No code or formal whitepaper.** Secondary write-ups (forkast.news, dev.to, explainx.ai, etc.) only restate the blog. I checked forkast.news; it adds no technical details beyond Meta's blog.

### 1.5 How the user's statement maps onto this

> "separates the key layer and the bot running environment, so the bot gets a key that won't work without the key layer, and even if it leaks nobody can use it"

- ✔ **Separation.** authd, Sentinel, privsep workers and hatch-safety are separate systemd units outside the `systemd-nspawn` cell. They talk to it only over `SO_PEERCRED`-checked Unix sockets.
- ✔ **"A key that won't work without the key layer."** The cell holds only a *surrogate minted by authd*. It becomes a real credential only when Sentinel substitutes it at egress, after authorizing that concrete request.
- ◐ **"Even if it leaks nobody can use it."** True for *disclosure*: off-box, the surrogate is not a credential at all. It is **not** true for *misuse* by a hijacked agent. Anyone controlling code in the cell can still ask Sentinel to perform authorized requests (a confused deputy). Meta addresses this separately with destination and connector policy, taint-based auto-allow, human approvals bound as capabilities, classifiers, and privsep.
- ✘ **Surrogation does not cover the owner's control-plane token.** On 2026-09-21 Patrick Wardle disclosed a Muse Mac-client zero-day. An unprivileged local process could change an undocumented preference, `endo_voyager_dictation_endpoint`, to redirect dictation traffic and capture the Muse account token: "Theft of Muse authentication material … Muse’s access can potentially become the attacker’s access" (PoC README, https://github.com/pwardle/not-a-mused). Meta hot-fixed it by removing the setting from production builds. Coverage: VentureBeat https://venturebeat.com/security/meta-patched-muses-zero-day-but-security-teams-still-lack-visibility-into-what-the-agent-can-access ; InfoQ https://www.infoq.com/news/2026/09/meta-muse-zeroday/. **Lesson for localDot:** the UI/approval channel's token is the most valuable credential in the system and needs its own protection.

### 1.6 Peer comparison: OpenAI "dots" (launched 2026-09-29)

This is the closest rival product. Its public safety write-up is less specific than Meta's about API keys. Sources: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/ and https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs (both fetched via the r.jina.ai reader proxy because openai.com returns 403 to direct fetches; page dates not captured).

- **Logins.** "For supported sign-ins, the model is paused while you complete a secure login form, which sends your credentials directly to the browser environment and submits them without exposing them to the model’s context."
- **Saved passwords.** "Supported saved-password flows maintain that separation through a dedicated encrypted credential service. The service supplies the password for sign-in without passing it to the model". It adds: "a secret placed separately in a readable message or document may still be visible to the model."
- **Harness and safety separation.** "Dots run code in environments that are separate from the systems that coordinate their work and enforce key safeguards. They can create files and run tools there, but they cannot use that access to change those safety systems or turn off required checks."
- **Actions.** An "Auto-review" step checks actions. Purchases need approval. "changing a password or transferring money … must hand those sensitive steps back to you."
- **Not described publicly:** placeholder/surrogate API keys or egress-time substitution. The dots posts talk about *passwords/sign-ins* and connected apps "within the permissions you have granted to ChatGPT". Muse's post is the only one of the two that documents a network-boundary surrogate swap.

---

## 2. TASK 2 — Prior art and building blocks

Repo stats come from `gh repo view` on 2026-09-30 (★ = stars). "Hosted" means the pattern is copyable but the product cannot run on the Mac.

### 2.1 Taxonomy (what the sandbox holds)

| Family | Sandbox holds | Who swaps / adds the secret | Examples |
|---|---|---|---|
| **A. Placeholder / surrogate swap** | A random string that means nothing outside the proxy | Egress MITM proxy, substituting only for hosts bound to that secret | Meta Muse (authd + Sentinel), Anthropic `srt` credential masking, Claude Managed Agents vaults, Docker Sandboxes `sbx` (`proxy-managed`), Deno Sandbox, microsandbox, Gondolin, Matchlock, iron-proxy, Infisical Agent Vault, OneCLI, OpenClaw secret egress proxy |
| **B. Sealed token** | Ciphertext that only the proxy can open, with the policy (hosts, auth binding) embedded | Stateless proxy holding the private key | superfly/tokenizer (+ ssokenizer) |
| **C. Destination-side injection** | Nothing | Proxy/firewall adds a header per destination rule | Vercel Sandbox firewall, E2B network rules, Cloudflare Sandbox outbound Workers, Fly Sprites Connectors, Claude Code on the web (git proxy and stored API keys), LLM gateways (LiteLLM, Tailscale Aperture, Cloudflare AI Gateway BYOK) |
| **D. Typed out-of-sandbox tool workers** | Only the right to call a typed tool | A worker/MCP server outside the sandbox holds the token | Muse privsep workers, Arcade, Composio (cloud), Docker MCP Gateway, HashiCorp Vault's "AI agent identity" pattern |
| **E. Bound / short-lived tokens** | A real but narrow token | The authorization server mints it | RFC 8693 token exchange, DPoP (RFC 9449), transaction tokens (draft), Keycard, Aembit, Auth0 Token Vault, Vault/OpenBao dynamic secrets, GitHub App installation tokens (1 h) |

The confused deputy is the common residual risk in every family. Any process inside the sandbox can still exercise the capability against the allowed host. Only per-method/path policy, approvals, rate limits and audit narrow that.

### 2.2 Local, open-source, self-hostable on macOS (candidates to embed or copy)

| Project | Mechanism (quote) | Binding / TLS | Maturity, license, stats | Fit for localDot |
|---|---|---|---|---|
| **Anthropic sandbox-runtime (`srt`)** https://github.com/anthropics/sandbox-runtime | `src/sandbox/credential-sentinel.ts` (verified): "A masked credential's real value is replaced inside the sandbox with a sentinel of the form `fake_value_<uuid4>`. The sandboxed process sees only the sentinel; the host-side proxy substitutes sentinel→real on egress to allowlisted destinations. The map lives only in process memory — it is never written to disk and never logged." Substitution is "gated per sentinel … This prevents laundering credential A through credential B's allowlisted host". Isolation: "`srt` uses native OS sandboxing primitives (`sandbox-exec` on macOS, `bubblewrap` on Linux) and proxy-based network filtering." | Per-credential `injectHosts`. Needs `network.tlsTerminate` (MITM CA inside the sandbox). [sub-agent] body substitution, AWS SigV4 re-signing (fails closed for streaming/presigned requests), structurally valid fake JWTs, and an SSRF guard that drops loopback, link-local, metadata and the host's own interface addresses. | Beta research preview. Apache-2.0, 5,400★, v0.0.78 (2026-09-30). | **Best reference for substitution semantics and tests.** It wraps *host processes*, not VMs, so reaching its proxies from a VM needs glue. Standalone-proxy use is not verified. |
| **iron-proxy** https://github.com/paradigmxyz/iron-proxy | README (verified): "a MITM egress proxy with a built-in DNS server … default-deny … Workloads use proxy tokens, and iron-proxy swaps in real credentials at egress, meaning a compromised workload can exfiltrate a token that's worthless outside the proxy." Also: "Upstream IP deny list … closing the SSRF/DNS-rebinding gap", "Per-request audit trail … which secrets were swapped", WebSocket/SSE, explicit `HTTP_PROXY`/SOCKS5 mode, and a "PostgreSQL MITM proxy" that authenticates clients "against proxy-managed credentials, injects `SET ROLE`" and blocks role changes via a SQL AST walk. | Proxy tokens. Host allowlist. Metadata and loopback denied by default. | Apache-2.0, 697★, v0.52.0 (2026-09-29). Single Go binary, one YAML file, macOS/Linux binaries. | **Strongest drop-in data plane** (egress + DB). Used by IronClaw and NanoClaw. Approval hooks: UNVERIFIED. |
| **Infisical Agent Vault** https://github.com/Infisical/agent-vault | "force your agents to route HTTP requests through it. Agent Vault intercepts every request and attaches credentials onto it before forwarding"; substitutes dummy values "like `__anthropic_api_key__`". SSRF: "resolves hostnames to IP addresses, validates every resolved IP against the block list, then connects directly to the validated IP." | `HTTPS_PROXY` + local CA. Agent tokens `av_sess_` (24 h) / `av_agt_` (no expiry) in `Proxy-Authorization`. **No documented source binding.** Agents "raise proposals" to ask for access to new services. | Research preview (2026-04-22). MIT outside `ee/`, 2,284★, v0.39.3. The commercial Infisical Agent Proxy went GA on 2026-07-30. | Good complete package (vault + UI + proxy). "Experimental". Its tokens need source binding. The vendor recommends running it on a separate machine. |
| **OneCLI** https://github.com/onecli/onecli | "Rust Gateway: intercepts outbound requests (HTTPS included, via MITM) and injects credentials. Agents authenticate with access tokens via `Proxy-Authorization` headers"; "The only way out is the gateway." | Host+path matching; header/query injection. On-demand 1Password/Bitwarden, deterministic human approvals, SSH terminator issuing short-lived certificates. | Apache-2.0, 3,532★, v2.6.0. | Closest feature match to localDot. It is growing into its own agent harness, so there is overlap and competition. |
| **microsandbox** https://github.com/superradcompany/microsandbox | libkrun microVMs on Apple Silicon. Docs (verified): "The guest never sees the actual secret value … `$MSB_<varName>`". Substitution "only occurs on TLS-intercepted connections where the proxy verifies MITM capability and SNI matches an allowed host". Headers/Basic by default; query and body opt-in. Violation actions: `block`, `block-and-log`, `block-and-terminate`. | `allow()` hosts are checked against "verified TLS identity and observed DNS history". The CA is shared across local sandboxes by default. | Apache-2.0, 8,489★, v0.7.4 (2026-09-29). Vercel's open-source `eve` agent uses it. | VM runtime and secret swap in one. Alternative sandbox backend. Gotcha: eve PR #2441 says placeholders leaked to origins when TLS interception was not enabled (fail-open misconfiguration). |
| **Gondolin** https://github.com/earendil-works/gondolin | QEMU(HVF)/libkrun microVM. A host-side userspace network stack with HTTP parser and TLS MITM, and arbitrary TCP tunnelling blocked. DNS defaults to "synthetic": "No upstream DNS; the host replies directly." "If a placeholder is used for a disallowed host, the request is blocked." | `GONDOLIN_SECRET_<random>` | Apache-2.0, 2,200★, "Experimental". | Good ideas: synthetic DNS and blocking on misuse. |
| **Matchlock** https://github.com/jingkaihe/matchlock | Virtualization.framework (macOS) / Firecracker. `--secret NAME@host`, and the VM sees `SANDBOX_SECRET_…`. gVisor userspace netstack with MITM; private IPs blocked. | Host-bound | MIT, 621★, v0.2.17, experimental | Small reference implementation |
| **superfly/tokenizer** https://github.com/superfly/tokenizer | "Clients encrypt third party secrets using the proxy's public key … sending along the encrypted secret in the `Proxy-Tokenizer` header. The proxy decrypts the secret and injects it". The policy lives *inside* the ciphertext (auth: `bearer_auth`, `macaroon_auth`, `fly_src_auth`; validators `allowed_hosts`; processors `inject`, `inject_hmac`, `sigv4`, `jwt`, `client_credentials`, `github_app`). README: "If a client is fully compromised, the attacker could send encrypted secrets via tokenizer to a service that simply echoes back the request… secrets can specify which hosts they may be used against." | **No MITM.** The client sends `http://` and the proxy upgrades to HTTPS. CONNECT is refused because "honoring CONNECT would let a client use a host-scoped secret against a different host". The dialer denies private and loopback addresses. | Apache-2.0, 499★, no releases, runs in production at Fly. Companion `superfly/ssokenizer` (OAuth dance returning sealed tokens). Blog: https://fly.io/blog/tokenized-tokens/ | **Best stateless design** for connector code we control (SDK clients can target `http://` via the proxy). Generic CLIs such as `gh` and `git` can't use it without MITM. |
| **coder/httpjail** https://github.com/coder/httpjail | Process-level HTTP(S) filter with a generated CA and JS rules (the design Deno cites) | — | CC0, 963★, v0.6.2 | Filter only; no secrets |
| **Stripe Smokescreen** https://github.com/stripe/smokescreen | CONNECT proxy that "resolves each domain name… ensures that it is a publicly routable IP address"; per-client ACLs over mTLS | No injection | MIT, 1,350★, v0.1.0 (2026-09-21) | SSRF-safe egress stage and ACL model to copy |
| **mitmproxy** https://github.com/mitmproxy/mitmproxy | Scriptable TLS-intercepting proxy (regular, transparent, WireGuard, local modes). `allow_hosts`/`ignore_hosts` for selective interception. Note: its `block_private` option blocks *clients* from private IPs, not private *destinations* ("Block connections from local (private) IP addresses"), so SSRF guarding must be written as an addon. | — | MIT, 45,204★, v12.2.3 | Fastest v0 prototype (Python addon) |
| **elazarl/goproxy** / **hudsucker** | Go / Rust MITM proxy libraries | — | BSD-3, 6,764★ / Apache-2.0, 375★ | Libraries for a custom keyd data plane |
| **awslabs/aws-sigv4-proxy** https://github.com/awslabs/aws-sigv4-proxy | "signs and proxies HTTP requests with Sigv4" | — | Apache-2.0, 470★, v1.13 | Pattern for request-signing APIs (a placeholder can't work there) |
| **agentgateway** https://github.com/agentgateway/agentgateway | `backendAuth`: the gateway holds upstream credentials; `backendAuth.oauth` does RFC 8693 token exchange per upstream | — | Apache-2.0, 5,105★, v1.5.0 (Linux Foundation) | LLM/MCP gateway option |
| **LiteLLM** (virtual keys) https://docs.litellm.ai/docs/proxy/virtual_keys | The proxy holds provider keys; clients get virtual keys limited by model, budget, rpm/tpm, expiry and routes; `/key/block` revokes | — | License "Other", ~59.9k★ | LLM-key gateway (heavy; Python) |
| **Envoy `credential_injector`** https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter | Injects Basic/Bearer or OAuth2 client-credentials tokens | — | `status: alpha` | Only if Envoy is already in the stack |
| **Docker MCP Gateway** https://github.com/docker/mcp-gateway | Secrets and OAuth tokens go into MCP *server* containers, not to the model; blocks private/metadata IPs for remote URLs | — | MIT, 1,587★ | Family D building block |
| **Nango** | Encrypted OAuth token storage + automatic refresh; self-hostable | — | ELv2, 12.4k★ | Optional OAuth-refresh engine behind keyd |
| **OpenBao** | Dynamic DB credentials with leases; response wrapping | — | MPL-2.0, 8.2k★, v2.7.0 (HashiCorp Vault is BSL 1.1) | Short-TTL DB credentials |

### 2.3 Agent products and "claws": what they actually do

- **Claude Code on the web** (Anthropic engineering, 2025-10-20, https://www.anthropic.com/engineering/claude-code-sandboxing).
  - "sensitive credentials (such as git credentials or signing keys) are never inside the sandbox".
  - Git goes through a "custom proxy service that transparently handles all git interactions". There, "the git client authenticates to this service with a custom-built scoped credential. The proxy verifies this credential and the contents of the git interaction (e.g. ensuring it is only pushing to the configured branch), then attaches the right authentication token."
  - Network access is "only … through a unix domain socket connected to a proxy server".
  - Current cloud docs add that push is limited to the session branch, API calls to attached repos, and GraphQL to pinned operations. For stored API keys, "The key never reaches Claude, the commands it runs, or the session's environment variables" (https://code.claude.com/docs/en/cloud-environments; [sub-agent]).
- **Claude Managed Agents vaults** (beta, verified, https://platform.claude.com/docs/en/managed-agents/vaults). `environment_variable` credentials are "stored in the sandbox as an opaque placeholder. When the agent initiates an outbound request, the opaque placeholder is substituted with the real secret at egress. The agent never sees the secret value." `networking.allowed_hosts` "controls which requests use the secret, not which requests are allowed". Key caveats to copy into localDot's docs:
  - "Request payloads are often assembled from content the agent is working with, so the request body is the broader exposure surface … enabling only `header` is the narrower configuration."
  - "A placeholder in a disabled location is neither substituted nor stripped."
  - "clients that compute a request signature from the secret (for example, AWS SigV4) produce an invalid signature."
  - "**Substitution is outbound only.** If a client uses the stored secret to fetch a session token (for example, an OAuth client-credentials grant), the returned token arrives in the sandbox unredacted. For exchange-based flows, perform the exchange yourself and store the resulting token in the vault instead."
  - "Credentials are re-resolved periodically … rotation, archival, or deletion propagates to running sessions without a restart."
- **Docker Sandboxes (`sbx`)** (closed; local microVMs on Apple silicon; https://docs.docker.com/ai/sandboxes/security/credentials/, verified).
  - "The real credential stays on the host when proxy management is active; the sandbox sees only a sentinel value."
  - Credentials live in the **macOS Keychain**. Built-in services cover Anthropic, OpenAI, GitHub, Google, Groq, Mistral, xAI, OpenRouter, etc.
  - TLS is terminated by the credential proxy with a CA the sandbox trusts [sub-agent].
  - **Warning:** "SSH agent forwarding is enabled by default", so sandboxed processes can request signatures.
  - The most turnkey option on this Mac, but proprietary.
  - **Verified locally:** Docker Desktop 29.2 here ships an older `docker sandbox` CLI plugin (`github.com/docker/sandboxes/cli-plugin v0.11.0`). Its help shows agent templates (claude, codex, gemini, copilot, kiro, cagent) and `docker sandbox network proxy <sandbox> --allow-host/--block-host/--allow-cidr/--block-cidr/--bypass-host/--bypass-cidr --policy allow|deny`, plus `network log`. It has **no credential subcommands**. A `docker pass` plugin ("Manage your local secrets", backed by the local keychain) is also present. The proxy-managed credential sentinels in Docker's docs are documented for the standalone `sbx` CLI (docs mention `sbx` ≥0.42). Whether the v0.11 plugin injects credentials is UNVERIFIED.
- **OpenAI Codex cloud.** Secrets "are only available to setup scripts … secrets are removed before the agent phase starts". Agent-phase internet is off by default, behind a proxy with domain allowlists and an optional GET/HEAD/OPTIONS-only mode (https://learn.chatgpt.com/docs/environments/cloud-environment; https://developers.openai.com/codex/cloud/internet-access/). **Codex CLI** has `codex-network-proxy`; no credential injection was found.
- **IronClaw** (NEAR AI; Apache-2.0/MIT, 12,637★, v1.4.1).
  - WASM tools: "Credential injection - Secrets injected at host boundary, never exposed to WASM code. Leak detection - Scans requests and responses for secret exfiltration attempts."
  - Docker lane: an `iron-proxy` sidecar on an internal network. [sub-agent] the Docker-lane placeholder swap "ships unwired" (verify before relying on it).
- **NanoClaw** (nanocoai/nanoclaw; MIT, 30,863★, v2.4.0).
  - "agents never hold raw API keys". The gateway is OneCLI (or iron-proxy).
  - `src/egress-lockdown.ts` (verified): "Agents run on a Docker `--internal` network (no internet route) with the gateway attached as host.docker.internal, so the injected proxy is the only reachable hop. Non-root, no NET_ADMIN — the agent can't undo it." `config.ts`: "**Off by default**".
  - The gateway is a *container* attached to the internal network (`docker network connect --alias …`), so secrets live inside the Docker VM.
  - Apple Container was the original runtime; Docker became the default in Feb 2026.
- **OpenClaw** (390,856★; the user already runs `ghcr.io/openclaw/openclaw:*-browser` images locally).
  - It has a secret egress proxy with exact-host binding, but it is off by default.
  - Its docs admit sentinels "are not process isolation. The real value still exists in same-process memory". Also: "Sandbox exec receives neither its proxy/CA environment nor protected sentinels" (https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress).
  - Advisory GHSA-g8p2-7wf7-98mq (2026-01-31, high; verified): "1-Click RCE via Authentication Token Exfiltration From gatewayUrl". This is the same class of bug as Muse's Mac zero-day: control-plane token theft.
  - Other advisories: GHSA-7vwx-582j-j332 ("leaks bearer tokens to allowlisted suffix domains", so never suffix-match credential hosts) and GHSA-vhpg-cq3w-v8p9 (credentials sent to the wrong endpoint).
- **Moltworker** puts raw keys in container env (counter-example). **ZeroClaw** has OS sandboxes but no credential proxy. **PicoClaw** stores keys in `~/.picoclaw/config.json`.

### 2.4 Hosted platforms (patterns to copy)

- **Vercel Sandbox firewall** (https://vercel.com/docs/sandbox/concepts/firewall). Per-domain `transform: [{ headers }]` or `forwardURL`. "The secrets never enter the sandbox." TLS is terminated only for domains with transform/forward rules, using "A unique, per-sandbox CA".
  - Documented pitfalls (copy these into the threat model): matching is SNI-only, so domain fronting is possible; "Matchers never block traffic"; with a `*` catch-all, traffic without SNI or not using TLS passes unmodified; `subnets.allow` bypasses brokering and "leaves DNS unrestricted".
- **Cloudflare Sandbox SDK outbound Workers** (GA 2026-04-13; https://blog.cloudflare.com/sandbox-auth/, https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/).
  - "Because outbound handlers run in the Workers runtime, outside the sandbox, they can hold secrets the sandbox never sees."
  - "A unique ephemeral certificate authority (CA) and private key are created for each Sandbox instance, and the CA is placed into the sandbox."
  - Per-instance identity via `ctx.containerId`.
- **E2B** network rules (public beta): "The egress proxy replaces each reference with the secret's current value outside the sandbox"; HTTPS only. Runtime needs Linux/KVM, so it is a poor local fit.
- **Deno Sandbox** (beta 2026-02-03; https://deno.com/blog/introducing-deno-sandbox): secrets bound to hosts; the sandbox sees `DENO_SECRET_PLACEHOLDER_…`; "The real key materializes only when the sandbox makes an outbound request to an approved host." Body/TLS details are UNVERIFIED.
- **Fly Sprites Connectors**: "the Sprite never holds the provider token. It only knows the connector ID and the gateway URL". Identity comes from Fly's request signature, with path allow/block lists and automatic OAuth refresh (https://docs.fly.io/sprites/concepts/connectors/).
- **Tailscale Aperture**: clients "authenticate with Tailscale's network identity, not credentials you need to distribute" (alpha/beta).
- **Cloudflare AI Gateway BYOK**: "AI Gateway substitutes the stored provider key only when the provider authorization header is absent."

### 2.5 Secret stores and credential sources

- **macOS Keychain.** The natural at-rest store for a localhost product; Docker `sbx` uses it too. Caveat (inference): legacy keychain ACLs are keyed on code signature, so ad-hoc-signed open-source builds will re-prompt after every rebuild. Ship signed binaries or use a dedicated keychain.
- **1Password.** Secure Agentic Autofill (early access since 2025-10-08, Browserbase only; https://www.1password.dev/agentic-autofill): "triggering an approval prompt from your 1Password desktop app for each autofill request. If you approve the request, the item is sent encrypted to the headless 1Password browser extension, which injects only the minimum required credential data from the approved item into the login form." It does *not* stop an agent from reading the filled value back from the DOM; Muse's no-JS, a11y-tree-only broker does. Unified Access (2026-03-17) is JIT delivery for coding agents. Meta says 1Password support is "coming" to Muse. `op run` and the SDKs hand plaintext to the process.
- **Bitwarden.** Agent Access (https://github.com/bitwarden/agent-access; Apache-2.0, early preview) opens an E2E tunnel and `aac connect` returns plaintext JSON, so secrets reach the sandbox. The Bitwarden MCP server (GPL-3.0) lets the AI "Read vault items including passwords", which is an **anti-pattern** for localDot. Use Bitwarden only as a host-side source.
- **HashiCorp Vault / OpenBao.**
  - Dynamic DB creds: "generates database credentials dynamically based on configured roles".
  - Response wrapping: "only a single party can ever unwrap the token".
  - Vault 2.1 "Native AI agent support" (2026): agent registry, on-behalf-of via token exchange, "Ceiling policies … establish an absolute blast radius".
  - Vault is BSL 1.1; OpenBao is MPL-2.0.
- **Infisical** (platform, MIT + `ee/`, 29.5k★): dynamic secrets; Agent Vault / Agent Proxy as above.

### 2.6 Identity and token standards (what binding can buy)

- **RFC 8693 Token Exchange** (https://www.rfc-editor.org/rfc/rfc8693). §1.1 distinguishes impersonation ("A is given all the rights that B has … and is indistinguishable from B") from delegation ("A still has its own identity separate from B … In a sense, A is an agent for B"). The `act` and `may_act` claims express delegation. Useful only when the resource server trusts your authorization server. Gmail and GitHub won't accept a locally minted token, so for localDot this applies to *internal* tokens (e.g., sandbox→keyd), not provider APIs.
- **RFC 9449 DPoP** (https://www.rfc-editor.org/rfc/rfc9449). §2: "prevent unauthorized or illegitimate parties from using leaked or stolen access tokens, by binding a token to a public key". §11.4: "If an adversary is able to run code in the client's execution context, the security of DPoP is no longer guaranteed". Implication: a signing key *inside* the sandbox becomes a signing oracle. Keep any PoP key in keyd, which signs on the sandbox's behalf. Provider support for DPoP in consumer APIs: UNVERIFIED (probably rare).
- **RFC 8705** (mTLS-bound tokens), **RFC 9421** (HTTP Message Signatures), **RFC 8707** (resource indicators). **draft-ietf-oauth-transaction-tokens**: "short-lived (on the order of minutes or less)" and "MUST NOT be accepted outside the Trust Domain". **ID-JAG / Okta Cross App Access** (draft, early access). **draft-klrc-aiagent-auth-03** (2026-07).
- **MCP authorization spec.**
  - 2025-11-25 security best practices: token passthrough is "an anti-pattern"; "MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server"; SSRF guidance: "Consider pinning DNS resolution results between check and use" and use an egress proxy like Smokescreen.
  - 2026-07-28: "The MCP server MUST NOT pass through the token it received from the MCP client."
  - https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- **Macaroons / Biscuit.**
  - Macaroons: HMAC-chained caveats (NDSS 2014).
  - Fly.io's machine-lock caveat: "Stealing the token from a Fly Machine doesn't help you since it's locked to that Fly Machine by a caveat attackers can't strip" (https://fly.io/blog/macaroons-escalated-quickly/).
  - Biscuit (Eclipse, Apache-2.0): offline attenuation with Datalog.
  - For localDot these are optional. keyd both issues and verifies surrogates, so an opaque random handle plus a server-side registry is simpler and revocable.
- **SPIFFE/SPIRE.** Attested workload identity over a Unix socket. v1.15.3 ships no darwin binaries, and the Docker attestor needs the containers' kernel. **Overkill for one Mac**; copy the idea (identity by local socket/port, not a bearer).
- **Vendors** (closed or SaaS): Aembit (edge proxy injecting short-lived creds, "secretless"); Keycard (launched 2025-10-21; task-bound short-lived creds; `keycard run` for coding agents); Auth0 Token Vault; Arcade ("The client and the LLM never see the secret values"); Composio (tokens in their cloud, which breaks localhost-first); Microsoft Entra Agent ID; Okta XAA.

### 2.7 Browser, SSH and DB specifics

- **Cookies are bearer credentials, and in a Linux VM they are not bound to anything.**
  - DBSC (Device Bound Session Credentials) binds sessions to a TPM/Secure Enclave key. Per the Chrome docs, "If a user's device does not support secure key storage, DBSC gracefully falls back to standard behavior" (https://developer.chrome.com/docs/web-platform/device-bound-session-credentials).
  - Google Workspace: DBSC "in the Chrome browser on Windows is now generally available" (rollout from 2026-05-25; https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html). Nothing covers Chromium in a Linux sandbox.
  - Chromium on Linux without a keyring encrypts cookies with a **hard-coded key**. `components/os_crypt/async/browser/posix_key_provider.cc` (verified): `kEncryptionTag[] = "v10"` and "PBKDF2-HMAC-SHA1(1 iteration, key = "peanuts", salt = "saltysalt")". **Read access to the profile directory therefore equals session theft**, replayable from any machine.
- **SSH.**
  - OpenSSH ≥8.9 destination constraints (`ssh-add -h`, https://www.openssh.org/agent-restrict.html) do **not** protect a socket mounted directly into a sandbox. In `ssh-agent.c` (verified), `identity_permitted()` returns early: `if (e->nsession_ids == 0) return 0; /* local use */`. The docs also say "If an agent is forwarded to an attacker-controlled host, then they will still be able to steal use of a forwarded agent on that host."
  - Docker Desktop's `/run/host-services/ssh-auth.sock` passthrough (https://docs.docker.com/desktop/features/networking/networking-how-tos/) therefore hands the sandbox a signing oracle for *every* key in the agent.
  - Secretive (MIT, 8,924★, v4.0.0) keeps keys in the Secure Enclave with per-use Touch ID, but still acts as an oracle once approved.
- **Postgres.**
  - PgBouncer `[databases]` `user=`/`password=` define server-side credentials ("all connections to the destination database will be done with the specified user"), independent of client auth (`auth_type` trust/scram/cert/hba) (https://www.pgbouncer.org/config.html). PgBouncer: 4,387★, v1.26.0.
  - iron-proxy's Postgres MITM adds role pinning.
  - OpenBao issues short-lease DB users.

### 2.8 macOS isolation runtimes (sandbox host for localDot)

| Runtime | Own kernel per sandbox | Egress enforcement | Status |
|---|---|---|---|
| **Docker Desktop 29.2 (installed, running)** | No; one shared Linux VM | `docker network create --internal`: "Containers on an internal network may communicate between each other, but not with any other network, as no default route is configured and firewall rules are set up to drop all traffic to or from other networks" (https://docs.docker.com/reference/cli/docker/network/create/). Since Engine 26.0 (CVE-2024-29018): "Do not forward requests to external DNS servers for a container that is only connected to an 'internal' network" (moby v26.0.0 release notes, verified via `gh`). | Works today (NanoClaw and IronClaw use it) |
| **apple/container** (Apache-2.0, 50,417★, 1.5.0, macOS 26) | **Yes**, a lightweight VM per container | `container network create --internal`: "Restrict to host-only network" (docs/command-reference.md, verified). Host-service reachability via `container system dns create --localhost` (limited); pf rules on the host (inference). | Best open-source per-sandbox VM option; not installed |
| **Docker Sandboxes `sbx`** | Yes, a microVM per sandbox | Built-in host proxy with deny-by-default and credential sentinels | Proprietary |
| **microsandbox / Gondolin / Matchlock** | Yes, microVMs | Built-in MITM + placeholders | OSS, young |
| **Tart** (now `openai/tart`; FSL-1.1-ALv2, 7,253★) | Yes (macOS/Linux guests) | Softnet `--net-softnet-block/allow` [sub-agent] | Good for a full desktop guest |
| **Lume** (trycua/cua, MIT) | Yes | NAT/bridged only; host pf needed | — |
| **OrbStack** | No; machines "share the same kernel" | None built in | Proprietary |

---

## 3. TASK 3 — Recommended design for localDot's key layer ("keyd")

### 3.1 Goals and non-goals

- **G1: nothing the sandbox holds is a usable credential off-box.** This covers env, files, process memory, logs, and the agent cell's disk. The worst case for anything leaked is "useless", not "rotate everything".
- **G2: one host-side authority governs every byte of egress and every credentialed action.** This is Muse's Sentinel role. It lives outside the sandbox's kernel and the sandbox cannot reconfigure it.
- **G3: bound what possession allows.** Per-credential host, method and path policy, budgets, out-of-band approvals and an audit trail bound the confused-deputy use that possession still allows.
- **G4: works on this Mac now.** Docker Desktop 29.2 is installed. The design must port to per-sandbox VMs later (apple/container `--internal`, or microVMs).
- **G5: fail closed everywhere.** Unknown surrogate, unknown host, no DNS, no proxy: all are blocked.
- **Non-goals:**
  - Full protection against malware already running as the macOS user. We reduce exposure (Keychain ACLs, no plaintext on disk, a protected UI token) but cannot win that fight.
  - Preventing misuse of data the user *allowed* the agent to read and send to allowed destinations. That can only be bounded (approvals, taint, rate limits).

### 3.2 Architecture

```
┌──────────────────────────── macOS host (user session) ─────────────────────────────┐
│ localDot app (live view, approvals, Touch ID) ── unix socket (0600) ──┐              │
│                                                                       ▼              │
│ keyd  (LaunchAgent; signed Go binary; the only holder of real secrets)               │
│  ├─ vault ......... macOS Keychain (+ optional 1Password/Bitwarden/OpenBao sources)  │
│  ├─ registry ...... surrogate → {secret, sandbox, hosts, location, policy, ttl}      │
│  │                  (authd role)                                                     │
│  ├─ gateway ....... one listener per sandbox; explicit HTTP/CONNECT proxy            │
│  │                  (Sentinel role)                                                  │
│  │                  policy → SSRF-safe dial → selective TLS termination              │
│  │                  → surrogate swap → response scrub → audit                        │
│  ├─ llm ........... OpenAI/Anthropic-compatible endpoint; routes to providers or     │
│  │                  LM Studio on 127.0.0.1:1234                                      │
│  ├─ oauth ......... authorization-code + PKCE in the *host* browser; refresh;        │
│  │                  revoke                                                           │
│  ├─ workers ....... typed connectors (send mail, write calendar, pay) exposed as     │
│  │                  MCP tools                                                        │
│  ├─ git ........... smart-HTTP proxy with ref policy (push only localdot/*; no       │
│  │                  force/delete)                                                    │
│  ├─ db ............ per-DB proxy (PgBouncer or iron-proxy PG) with a pinned role     │
│  ├─ browser-broker  CDP verb allowlist; credential fill with the agent paused        │
│  └─ audit ......... append-only, hash-chained JSONL, outside every sandbox           │
└──────────────────────────────────────────────────────────────────────────────────────┘
            ▲ host.docker.internal:70NN   (keyd listens on loopback only; see 3.14)
┌───────────┼──────────────── Docker Desktop Linux VM ─────────────────────────────────┐
│  fwd-N  (socat/haproxy, holds NO secrets; networks: ldot-egress + ldot-sbx-N)        │
│  ldot-sbx-N  (docker network --internal: no default route, no external DNS)          │
│   ├─ agent cell:   harness + tools + desktop; non-root; cap-drop ALL;                │
│   │                no docker.sock; only a workspace volume                           │
│   └─ browser cell: Chromium + its own Xvfb/VNC; profile volume mounted ONLY here;    │
│                    driven via the broker                                             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Why keyd runs on macOS rather than as a gateway container (NanoClaw/IronClaw style).** Docker Desktop runs every container on one shared Linux kernel. A container escape would expose a gateway container's memory, which holds every real secret. With keyd on macOS, escaping into the VM yields no plaintext secrets. It does let the attacker bypass egress policy through the VM's NAT, so it is a serious incident but not a credential-custody failure.
- **When moving to apple/container** (a VM per container), keep the same keyd. It listens only on the host-only network's gateway address, and a pf anchor restricts that subnet to keyd's ports (inference; see 3.14).
- **The forwarder is deliberately dumb.** It holds no secrets, terminates no TLS, and has one fwd per sandbox, mapped to one keyd port per sandbox. That gives keyd a source identity (the listener port) that the sandbox cannot forge. Each sandbox's internal network contains only its own forwarder.

### 3.3 What the sandbox holds — the complete list

| Item | Example | Value if leaked |
|---|---|---|
| Proxy endpoint | `HTTP(S)_PROXY=http://fwd:3128`; `NODE_USE_ENV_PROXY=1` (Node ≥24 fetch); Chromium `--proxy-server=http://fwd:3128 --disable-quic` | None |
| Sandbox identity | Implicit: the per-sandbox keyd listener port. Optional defence in depth: `Proxy-Authorization` with a random 256-bit per-boot token | Only works on that listener, reached through that sandbox's forwarder |
| Public CA certificate | Ephemeral per sandbox, name-constrained | None (no private key) |
| Surrogates | `OPENAI_API_KEY=ld_oai_…`, `GH_TOKEN=ld_gh_…`, a git credential helper returning `ld_gh_…`, `DATABASE_URL=postgres://agent@db-main.ldot:5432/app` (no password) | Worthless off-box. On-box, equal to the policy already granted to that sandbox |
| Tool endpoints | `OPENAI_BASE_URL=http://llm.ldot/v1`, `ANTHROPIC_BASE_URL=http://llm.ldot`, MCP `http://tools.ldot/mcp` (all served by keyd through the gateway) | None |

**It must never hold:**
- real API keys, OAuth access or refresh tokens, website passwords, or session cookies for logged-in sites (in the agent cell);
- SSH private keys or the user's own agent socket;
- DB passwords, the CA private key, or keyd/UI admin tokens;
- `docker.sock`;
- host mounts of `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, `~/Library/Keychains`, or LM Studio's port.

The user's `~/.claude`, `~/.codex` and similar agent-tool configs contain tokens too.

### 3.4 Surrogate format and swap rules

- **Format:** `ld_<kind>_<22+ chars base62 = ≥128-bit random>_<6-char checksum>`. The checksum lets scanners recognise surrogates cheaply. If an SDK validates the key shape at startup, add an optional provider-shaped prefix (Anthropic's docs warn that "clients that validate the credential format at startup may reject it"). srt pads sentinels to the real value's length so `Content-Length` stays invariant under body substitution. Copy that if body substitution is enabled.
- **Registry entry (in keyd memory; persisted only as an HMAC of the surrogate):** `{sandbox_id, secret_ref, hosts: [exact], ports: [443], location: header:Authorization "Bearer {}" | header:x-api-key | basic-auth-password | query:key (opt-in, per path) | body-field (opt-in, per endpoint), rules: [{method, path_glob, decision: allow|ask|deny}], budget, ttl (default = sandbox lifetime, max 24 h), revoked_at}`.

**Swap rules** (the union of Muse, srt, tokenizer, microsandbox, the Anthropic vaults, and the OpenClaw advisories):

1. **Authorize first, then substitute.** Muse: "After the concrete network request is authorized, Sentinel will replace any surrogate tokens".
2. **Bind to the sandbox.** Only swap if the request arrived on the surrogate owner's listener.
3. **Bind to the host.**
   - Swap only if the destination hostname is an **exact** match. No implicit suffix matching (OpenClaw GHSA-7vwx-582j-j332).
   - Swap only if the upstream TLS certificate verified against macOS system roots for that hostname.
   - Swap only if the **connected** peer IP passed the SSRF checks in 3.8.
   - Never swap into plaintext HTTP upstreams.
4. **Location-bound, header-only by default.** Body and query substitution is an explicit per-endpoint opt-in (Anthropic: "the request body is the broader exposure surface").
5. **Misuse is blocked, never passed through.**
   - A surrogate seen for a non-bound host, in a non-configured location, in a URL or in a DNS name → **block + alert**. Optionally pause the sandbox (microsandbox `block-and-terminate`, Gondolin: "the request is blocked").
   - This deliberately differs from Anthropic Vaults and Agent Vault, which pass the literal placeholder through.
   - An unknown `ld_` token → block (fail closed).
6. **Scrub responses.** Replace the real secret, and its base64, base64url, URL-encoded and hex forms, with the surrogate in response headers and bodies. Flag the host as reflective. This covers tokenizer's "echoes back the request" case.
7. **Capture token exchanges.** "Substitution is outbound only", so keyd intercepts known token endpoints (OAuth `…/token`, AWS STS, GitHub App `/access_tokens`). It stores the returned token and hands the sandbox a *new surrogate*. Better still, perform the exchange host-side (OAuth broker) so the sandbox never calls token endpoints.
8. **Request-signing APIs** (AWS SigV4, HMAC-signed exchanges, webhooks) are **re-signed by keyd** (srt SigV4 support; tokenizer `sigv4_processor`/`inject_hmac_processor`; awslabs/aws-sigv4-proxy) or handled by a typed worker.
9. **Leak detection on egress.** Check exact matches of every real secret value (should be impossible; if it fires, it is a bug or a bypass). Run gitleaks-style detectors (gitleaks: MIT, 29.6k★) for *foreign* secrets, e.g. the agent found a real `.env` in a cloned repo. Decision: ask or block, per IronClaw's "Scans requests and responses for secret exfiltration attempts".

### 3.5 Per-secret-class handling

| Secret class | Where the real secret lives | What the sandbox gets | Mechanism and policy |
|---|---|---|---|
| **LLM provider API keys** (OpenAI, Anthropic, Gemini, OpenRouter…) | Keychain → keyd `llm` | A base URL to `http://llm.ldot` plus a per-sandbox virtual key/surrogate. MITM fallback for code that hard-codes `api.openai.com` | Gateway injects the provider key. Model allowlist, per-day token/$ budget, rpm, prompt/response metadata logging. Routes to LM Studio (Muse Glimmer) on host loopback, so the sandbox never reaches `:1234` directly. Also set **provider-side** spend limits and project-scoped keys, because the gateway can be misused within budget. Patterns: LiteLLM virtual keys, Tailscale Aperture, Cloudflare BYOK. |
| **Other HTTP API keys** (Stripe, Notion, Linear, weather…) | Keychain | Surrogate in the env var the SDK expects | Generic swap (3.4). Per-key `hosts` + method/path rules; `ask` for writes by default. Query-param keys (e.g. `?key=`) opt-in per path. Signing APIs are re-signed by keyd. Prefer restricted keys (e.g. Stripe restricted keys; provider-specific, not verified here). |
| **OAuth-connected accounts** (Gmail, Google Calendar, GitHub, Slack…) | Refresh token in Keychain. Access token minted just-in-time in keyd memory | One surrogate per connection (*read* and *write* can be separate surrogates) | OAuth consent happens in the **host** browser (authorization code + PKCE, loopback redirect), never in the sandbox.<br>Keyd refreshes tokens.<br>Two grants where the provider allows, to copy Muse's read/write split: a read-only token for auto-allowed reads, and a write-scoped token used only by typed workers after approval.<br>Path-level policy beyond OAuth scopes, e.g. Gmail: `GET /gmail/v1/users/me/messages*` allow, `POST …/send` → **worker + approval** showing recipients, subject and a body diff; settings endpoints denied.<br>Filter OTPs, password-reset links and magic links out of mail returned to the agent (Muse's email connector).<br>Revocation: delete the Keychain item and call the provider's revoke endpoint (Google's revokes the refresh token too).<br>BYO Google OAuth client caveat: "Testing" publishing status makes refresh tokens expire after 7 days.<br>GitHub: prefer a GitHub App (installation tokens "expire after 1 hour"; per-repo selection) or a fine-grained PAT limited to specific repos. |
| **Git** | Token in keyd | `https://github.com/...` remotes + a credential helper returning the surrogate | **Git gateway**, following Claude Code on the web: "verifies … the contents of the git interaction (e.g. ensuring it is only pushing to the configured branch), then attaches the right authentication token". Parse receive-pack ref updates; allow pushes only to `localdot/*` branches; deny force-push, deletes and tag rewrites; clone/fetch only for repos in the task's allowlist. The owner check on the API path stops "create issue/gist on attacker repo" exfiltration. |
| **SSH** | Dedicated keys only, in keyd's own `ssh-agent` (or Secretive/Secure Enclave). **Never the user's main agent.** | Optional: a mounted socket for a *dedicated* agent holding one purpose-specific key (e.g. a deploy key) | Destination constraints don't help for a mounted socket (`/* local use */` path in ssh-agent.c). So: confirm every signature (`ssh-add -c` with a keyd-provided askpass → approval UI / Touch ID), use short-lived SSH certificates where the server supports it (OneCLI's SSH terminator pattern), and prefer HTTPS-git. Docker `sbx` forwards the user's agent by default; **localDot should not.** |
| **Database passwords** | Keychain → DB proxy config in keyd memory | `postgres://agent@db-x.ldot:5432/db` with no password (or a surrogate password) | Host-side PgBouncer (`[databases] … user= password=` for server login; client `auth_type` independent) or iron-proxy's PG proxy (pins `SET ROLE`, blocks role changes). Use least-privilege roles (read-only by default). For DBs you control, short-lease users from OpenBao's database engine. Non-HTTP protocols cannot be swapped by the HTTP gateway, so every DB needs a protocol-aware proxy. |
| **Website logins / cookies** (hardest) | Passwords/TOTP in Keychain (or 1Password). Session cookies in the **browser cell's** profile volume only | The agent cell gets *no* cookies. It drives the browser through the broker | See 3.6. |
| **Payments** | Card/wallet with the provider | Nothing | Single-use virtual cards bound to merchant, amount and time (Muse + Stripe Link pattern), issued by a worker after Touch ID approval. |

### 3.6 The in-sandbox browser (logged-in sessions)

The problem, stated plainly:
- Cookies are bearer tokens.
- DBSC binding doesn't exist for Chromium in a Linux VM ("gracefully falls back to standard behavior"; GA only on Windows since May 2026).
- Chromium on Linux without a keyring encrypts cookies with the hard-coded `"peanuts"` key.

So **any process that can read the profile directory owns every logged-in session, replayable from anywhere.** That makes the browser profile the single most valuable secret inside the "virtual computer".

Design:

1. **A separate browser cell.** Chromium runs in its own container (later its own VM) with its own X server/VNC. The profile volume is mounted *only* there. The agent cell shares no PID/IPC namespace, filesystem or display with it.
   - Do **not** put the logged-in browser on the same X11 display as agent-controlled processes. X11 has no isolation between clients: any client can read input events and window contents of others, so a compromised agent process could keylog a password the user types during takeover. (This is a general property of X11, not verified for a specific setup here.)
   - The live view composes the agent desktop and the browser cell's stream.
2. **A narrow broker instead of raw CDP.** Muse: "CDP access is in a broker outside the runtime cell". The agent gets verbs such as `navigate`, `snapshot` (accessibility tree), `screenshot`, `click(ref)`, `type(ref,text)`, `select`, `scroll`, `upload(workspace file)`, and `download(→ quarantine)`.
   - Denied: `Runtime.evaluate`/`callFunctionOn`, `Network.getCookies`/`getAllCookies`, `Storage.*`, `Fetch.*` interception, `Target.attachToTarget`, extension install, the file:// scheme, the devtools UI, and remote-debugging ports reachable from the agent cell.
3. **Logins.**
   - (a) **User takeover** in the live view. The agent is paused and gets no screenshots or snapshots while the user types.
   - (b) **Broker autofill** from the vault. The agent is paused; the broker verifies the page *origin* (eTLD+1 and scheme) matches the credential's origin before filling (anti-phishing), and fills through CDP DOM input, not the clipboard.
   - Both mirror Muse ("the agent is paused and can’t act at all") and 1Password's approval-per-fill.
4. **Authenticated vs. anonymous browsing.** Authenticated browsing *only* goes through the broker. If the agent wants to scrape or run Playwright itself, it uses a separate anonymous browser inside the agent cell with no logged-in state.
5. **Egress.** The browser cell's egress also goes through keyd: domain policy, SSRF guard, form-submission classifiers/approval for high-risk forms (payment, password change, account recovery, mass email). Optionally block known-malicious domains.
6. **v2 option: a cookie vault in keyd** (a novel design; UNVERIFIED, unimplemented).
   - For "vaulted" sites, keyd strips the `Set-Cookie` of HttpOnly session cookies from responses, keeps them in the host jar, and adds them to `Cookie` on matching requests.
   - It honours SameSite by trusting Chromium's `Sec-Fetch-Site`/`Sec-Fetch-Mode` headers (page JS cannot forge these). That stops malicious pages in the sandbox browser from getting cross-site requests auto-credentialed.
   - Result: even a full browser-cell compromise yields no replayable session cookies.
   - Costs: an RFC 6265bis-correct jar, WebSocket upgrades, CHIPS/partitioned cookies, and breakage on sites that need JS-readable auth cookies (leave those un-vaulted).
7. **At rest.** The profile volume sits on the host (APFS, FileVault), is optionally encrypted per profile with a key in Keychain, and is mounted only while the browser cell runs.

### 3.7 TLS interception: explicit proxy + selective MITM

- **Explicit proxy, enforced by the network, not by trusting env vars.** The sandbox's only route is the forwarder. Anything that ignores `HTTP(S)_PROXY` simply fails, which is fail-closed. Transparent interception (iptables REDIRECT in a netns the sandbox doesn't control, or mitmproxy's WireGuard mode) is an optional later add-on for proxy-unaware tools.
- **Selective termination.**
  - CONNECT to a host that has swap rules or L7 policy → terminate TLS.
  - Other allowlisted hosts → **pass-through tunnel**. Peek the ClientHello and require SNI == CONNECT host, to stop simple domain fronting (Vercel documents SNI/Host mismatches). No swap.
  - Everything else → 403.
- **Per-sandbox ephemeral CA** (Cloudflare and Vercel do this; microsandbox shares one by default). EC P-256, generated at sandbox start; the private key lives only in keyd memory and is destroyed on stop.
  - Add X.509 **nameConstraints** limited to the intercepted domains, so even a stolen CA key could not impersonate banks.
  - Chrome on Linux enforces name constraints on user-imported roots since Chrome 112 (https://alexsci.com/blog/name-non-constraint/). OpenSSL and Go also enforce them (general knowledge); verify every TLS stack in the image.
- **Trust wiring in the image:**
  - System: `update-ca-certificates`.
  - Chromium NSS DB: `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n ldot -i ldot.crt`.
  - `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`/`CURL_CA_BUNDLE`, Java `keytool -importcert`.
  - Tools with bundled root stores (some static Go/Rust binaries) will fail. Put them on pass-through or behind a typed worker.
- **QUIC/HTTP3:** there is no UDP route, so clients fall back to TCP; also `--disable-quic` for Chromium.
- **Pinned clients:** exclude them from termination (srt `excludeDomains`, microsandbox's bypass list). They can't use swapped secrets, so give them a typed worker.
- **Upstream:** always verify certificates (never mitmproxy `ssl_insecure`).
- **No-MITM alternatives where we control the client:**
  - LLM SDKs use `*_BASE_URL=http://llm.ldot`. The hop from sandbox to forwarder to keyd is local; keyd speaks HTTPS upstream.
  - Our own connector code can use tokenizer-style `http://` URLs plus a surrogate header.

### 3.8 Network enforcement on this Mac (Docker Desktop 29.2), step by step

1. `docker network create --internal ldot-sbx-N`. This gives no default route, and since Engine 26 (CVE-2024-29018) no external DNS forwarding for containers *only* on internal networks. Never attach agent or browser cells to any other network.
2. `docker network create ldot-egress` (normal bridge) for forwarders only.
3. Set up `fwd-N`:
   - Image: alpine + socat/haproxy, read-only rootfs, cap-drop ALL, no secrets.
   - Attached to `ldot-sbx-N` (listening on `:3128`) and `ldot-egress`.
   - Relays TCP to `host.docker.internal:70NN`, one keyd port per sandbox.
4. Run the cells with `--network ldot-sbx-N --cap-drop ALL --security-opt no-new-privileges --user 1000 --read-only (+tmpfs) --pids-limit --memory` and **no** `docker.sock`, no `--privileged`, no host mounts except the workspace volume.
5. **keyd listens on 127.0.0.1 only**, never 0.0.0.0, so it is not exposed to the LAN. It needs Docker Desktop to route `host.docker.internal` to host loopback (commonly observed, **verify**). If that doesn't work, bind to the VM-facing interface and add a pf rule.
   - **SSRF deny set** (checked against the *connected* peer address, not just DNS answers):
     - loopback and 0.0.0.0/8
     - RFC 1918 and 100.64.0.0/10
     - link-local 169.254.0.0/16 (metadata)
     - fc00::/7, fe80::/10, IPv4-mapped/NAT64 forms, multicast
     - Docker Desktop's 192.168.65.0/24
     - the Mac's own interface addresses (srt does this)
   - Explicit exceptions: only keyd's own internal services (LM Studio via `llm`).
6. **Boot self-test inside every sandbox; fail closed if any check fails.**
   - Direct `curl https://example.com` must fail.
   - `getent hosts example.com` must fail.
   - `curl -x http://fwd:3128 https://allowed.example` must succeed.
   - `curl http://host.docker.internal:1234` (LM Studio) must fail.
7. **Later backends.**
   - apple/container: `container network create --internal` ("Restrict to host-only network"); keyd on the host-only gateway IP; a pf anchor limiting that subnet to keyd ports. **Verify** apple/container's host reachability semantics.
   - microsandbox / Docker `sbx`: disable their own secret stores and point them at keyd, or accept their proxy as the data plane.

### 3.9 Policy sketch (per credential; illustrative)

```yaml
credentials:
  openai:
    source: keychain://localdot/openai
    inject: { hosts: [api.openai.com], header: Authorization, format: "Bearer {}" }
    rules:
      - { method: POST, path: "/v1/(responses|chat/completions|embeddings)", decision: allow }
      - { path: "/v1/(files|fine_tuning|organization)/**", decision: deny }
    budget: { usd_per_day: 20, rpm: 60 }
  gmail-read:
    source: oauth://google/gmail.readonly
    inject: { hosts: [gmail.googleapis.com], header: Authorization, format: "Bearer {}" }
    rules:
      - { method: GET, path: "/gmail/v1/users/me/(messages|threads)/**", decision: allow, filter: strip-otp-and-reset-links }
      - { decision: deny }
  gmail-send:
    worker: mail.send            # typed worker; never a raw surrogate
    approval: { every: true, show: [to, cc, subject, body_diff], user_presence: touch_id }
  github:
    source: github-app://install/12345   # 1-hour installation tokens minted by keyd
    inject: { hosts: [api.github.com, github.com, codeload.github.com, uploads.github.com], header: Authorization, format: "Bearer {}" }
    git: { push: { branches: ["localdot/*"], force: false, delete: false } }
    rules:
      - { method: GET, decision: allow }
      - { method: [POST, PATCH, PUT, DELETE], path: "/repos/{self}/**", decision: ask }
      - { method: [POST, PATCH, PUT, DELETE], decision: deny }   # blocks writes to others' repos
egress:
  default: deny
  allow_passthrough: [pypi.org, files.pythonhosted.org, registry.npmjs.org, "*.githubusercontent.com"]
  taint:
    # approximation of Muse "tainted egress": once this session read private data via a credential,
    # POST/PUT to any destination not previously approved requires approval
    after_private_read: { new_destination_writes: ask }
```

### 3.10 Approvals, audit, revocation, and the control plane

- **Approvals are out of band.** They are shown in the localDot app, never in the chat (Muse: "not via their conversation with Muse"). They display the *exact* action: method, host, path, recipients, amount, a body diff/hash.
  - Grants are **capabilities** with scope once, task, session, time-bounded or perpetual (Muse's taxonomy). Keyd enforces an exact match on later requests.
  - High-risk classes (money, sending mail, deleting, pushing to protected refs, new OAuth scopes) require **user presence** (macOS LocalAuthentication/Touch ID).
  - Approvals auto-deny on timeout, and prompt rate is limited to avoid consent fatigue.
- **Audit.**
  - One JSON line per decision: time, sandbox, surrogate id (never value), host, method, path, status, bytes in/out, decision, approval id, taint state.
  - Hash-chained (each line carries `sha256(prev)`), stored under `~/Library/Application Support/localDot/audit/`, and never mounted into any sandbox.
  - Bodies are not logged by default; hashes are.
  - A UI timeline shows "everything it has done" (Muse Newsroom: "Muse shows people a complete audit trail of everything it has done and plans to do.").
- **Revocation and kill switch.**
  - Kill switch: pause containers, drop all surrogates, close upstream connections.
  - Per connection: delete Keychain items and call the provider's revoke endpoint.
  - Surrogates die with the sandbox. The CA is per sandbox, so rotation is automatic.
- **The control plane is itself a credential.** Lessons from the Muse Mac zero-day (`endo_voyager_dictation_endpoint`) and OpenClaw GHSA-g8p2-7wf7-98mq ("Authentication Token Exfiltration From gatewayUrl"):
  - The app talks to keyd over a 0600 Unix socket, or loopback HTTP with a per-launch random token kept in Keychain or memory, plus **Host/Origin allowlists** against DNS rebinding. Precedent: Ollama CVE-2024-28224, "a DNS rebinding vulnerability that can inadvertently allow remote access to the full API".
  - No endpoints that config files can override in release builds.
  - Never auto-connect to URLs taken from query strings.
  - The admin API is never reachable through any sandbox listener.

### 3.11 Threat model

**Attackers:**
- **A1** prompt injection via web, mail, files or tool output. Assume arbitrary code execution as any user inside the agent cell, including container root.
- **A2** a malicious package, skill or MCP server inside the sandbox.
- **A3** a network attacker holding anything that leaked.
- **A4** a malicious website in the *user's host* browser.
- **A5** a container or VM escape.
- **A6** same-user malware on macOS (out of scope; mitigations only).

| Threat | Vector | Mitigation | Residual |
|---|---|---|---|
| Secret exfiltration from env/files/memory | `env`, `/proc/*/environ`, config files, core dumps, npm postinstall | Nothing real is inside. Surrogates are useless off-box. Egress is deny-by-default, so exfil channels are few. | None for keys. **Browser cookies** only if the browser cell is compromised (3.6). |
| **Data exfiltration** (the lethal trifecta) | Agent reads private data, then POSTs it to an attacker, or hides it in URLs or DNS | Default-deny egress. No DNS or UDP. Per-host method/path rules. Session taint → approvals for new-destination writes. Byte and rate budgets. Optional classifiers on outbound bodies (Muse hatch-safety analogue). Audit. | Exfil through *allowed* destinations (a gist on the user's own GitHub, a doc share) needs approval rules or classifiers. It cannot be eliminated (Willison: cut a leg of the trifecta). |
| **Confused deputy through keyd** | A hijacked agent uses legitimate surrogates for harmful actions | Least-privilege provider scopes; read/write split; typed workers for high-risk actions; approvals as capabilities; budgets; per-owner path rules; kill switch | Actions within already-granted auto-allow scope |
| **SSRF** | Requests via keyd to 127.0.0.1:1234 (LM Studio), 169.254.169.254, the LAN router, the Docker VM, keyd's admin API | keyd resolves DNS itself (the sandbox has none), dials the checked IP, and re-checks the connected peer. Deny set in 3.8. Redirects are not followed by keyd (each hop re-evaluated). The admin API is on a separate socket. | Misconfigured allow rules |
| **DNS rebinding** | Attacker hostname flips to a private IP between check and use; or a rebinding page in the host browser targets keyd or the UI | Check and use the same resolved IP, then re-check `peername` (MCP guidance: "pinning DNS resolution results between check and use"). Host UI checks Host/Origin plus a token. The sandbox has no resolver, so in-sandbox rebinding against sandbox-local services is moot. | — |
| **Token replay** | Leaked surrogate or proxy token used elsewhere | Not accepted by providers. keyd isn't reachable off-host. Bound to a listener. TTL = sandbox lifetime. Revoked on stop. Approval grants carry nonces and exact-match scope. Real OAuth access tokens are short-lived (≈1 h; GitHub App 1 h). | Replay *from inside* the same sandbox = confused deputy (above) |
| **Reflection** | Allowed host echoes the injected `Authorization` back into the sandbox (tokenizer's warning) | Exact-host binding; never inject for echo-prone hosts; response scrubbing plus a reflective-host flag | Encodings the scrubber misses |
| **Placeholder laundering** | Send credential A's surrogate to credential B's allowed host, or to an attacker host | Per-surrogate host binding (srt's rule); block + alert on misuse | — |
| **Outbound-only gap** | Sandbox calls a token endpoint and receives a real token | keyd intercepts and re-surrogates token responses; token exchanges done host-side | Unknown exchange flows → default-deny their endpoints |
| **Signing APIs** | SigV4 / HMAC can't use placeholders | keyd re-signs, or a typed worker | — |
| **Approval spoofing / consent fatigue** | Agent-crafted UI text; floods of prompts | Approvals rendered by keyd from structured request data, not agent prose; exact-action display; Touch ID for high risk; rate limits; batched task grants | Users rubber-stamping |
| **Control-plane token theft** | UI token in a plist or URL; debug endpoints; `gatewayUrl`-style auto-connect | 3.10 | Same-user malware (A6) |
| **Audit tampering** | Agent deletes or edits logs | Logs only on host, hash-chained, never mounted | Host compromise |
| **Sandbox escape** (A5) | Kernel exploit in the Docker VM | keyd on macOS, outside the VM; hardening flags; later a VM per sandbox (apple/container / microVM) | The VM NAT gives direct internet (policy bypass) but no plaintext secrets |
| **Supply chain in the sandbox** (A2) | A malicious package reads env and phones home | Nothing to steal; phone-home blocked by default-deny; leak detection; audit | Abuse of granted capabilities during the session |
| **Worker credential confusion** | A tool asks for another tool's credential | Per-worker credential allowlists keyed by identity (Muse: "A calendar worker cannot ask authd for an email credential simply by changing a request parameter") | — |

### 3.12 What a leaked sandbox token is worth

| Leaked item | To an attacker on another machine | To an attacker on the same Mac, outside the sandbox | To an attacker inside the sandbox |
|---|---|---|---|
| Surrogate `ld_*` | **Nothing**: not a provider credential, and keyd is loopback-only | Nothing without also reaching that sandbox's listener | What that sandbox's policy already allows, bounded by approvals, budget and TTL |
| Per-sandbox proxy token (optional) | Nothing | Usable only via that listener; the port is bound to the forwarder path | Same as above |
| Public CA cert | Nothing | Nothing | Nothing (no private key; name-constrained) |
| LLM virtual key | Nothing | Nothing | LLM spend up to budget |
| DB proxy URL | Nothing | Nothing | DB access as the pinned (read-only) role |
| Dedicated SSH agent socket (if enabled) | Nothing (it's a socket) | — | A signing oracle, gated by per-use confirmation |
| **Browser-cell profile** (only if the cell is compromised) | **Full session replay** (cookies are bearer; no DBSC on Linux) | Full | Full |
| **keyd/UI control token** | Nothing if loopback-only | **Full control** (the Muse and OpenClaw lessons) | Must be impossible: never exposed to any sandbox |

### 3.13 Build plan and component picks

- **v0 (prove the topology, about a week).**
  - Data plane: **iron-proxy** as a macOS host process. Apache-2.0, a Go single binary with MITM, a built-in DNS server, proxy tokens swapped at egress, an upstream IP deny list, JSON audit, WebSocket/SSE, and a Postgres proxy.
  - Alternatives: **Infisical Agent Vault** (vault, UI and proxy in one, experimental) or a **mitmproxy** addon.
  - Topology: Docker `--internal` network + forwarder + boot self-test.
  - Secrets: Keychain via `security` or a keyring library.
  - First credentials: LLM keys + generic API keys.
- **v1 (keyd proper).**
  - A Go daemon owning the control plane: registry, policy, approvals with Touch ID, OAuth broker, audit, git gateway.
  - Data plane: either keep iron-proxy behind a generated config, or write it on `elazarl/goproxy`. Port substitution semantics and tests from **srt's `credential-sentinel.ts` / `body-substitution`**, the SSRF-safe dialer ideas from **tokenizer** and **Smokescreen**, and SigV4 re-signing from srt / aws-sigv4-proxy.
  - Per-sandbox name-constrained CA. Browser cell + CDP broker. PgBouncer / iron-proxy PG for databases.
- **v2.**
  - Typed connector workers (MCP) for send, pay and delete.
  - Session-taint auto-allow.
  - Outbound DLP classifiers (a local model such as Muse Glimmer / LM Studio could run these on the host).
  - Cookie vault.
  - apple/container (VM per sandbox) or microsandbox backend.
  - Optional 1Password/Bitwarden credential sources feeding keyd; never MCP servers exposed to the agent.
- **Don't:**
  - mount the user's SSH agent;
  - run the gateway inside the same Docker VM as the sandboxes (unless you accept VM-escape = secret loss);
  - pass through unknown placeholders silently;
  - suffix-match credential hosts;
  - use Bitwarden/1Password MCP servers that return plaintext to the model;
  - put the authenticated browser's profile anywhere the agent's shell can read.

### 3.14 Open items to verify on this Mac before committing

1. Whether containers on Docker Desktop 29.2 can reach a keyd bound to macOS `127.0.0.1` via `host.docker.internal` from the forwarder. Also that containers on `--internal` networks cannot reach `host.docker.internal` at all (expected: the docs say only the gateway IP is reachable).
2. apple/container 1.5.0 host-only networking: which host IP is exposed to `--internal` networks, and whether a pf anchor can restrict it to keyd ports.
3. The Chromium build in the browser cell: NSS trust of the name-constrained per-sandbox CA, and `--proxy-server` + `--disable-quic` behaviour.
4. iron-proxy: whether it supports external authorization / approval callbacks and per-listener identity. If not, keyd needs its own data plane for approvals.
5. Muse unknowns (surrogate format/TTL/binding, TLS handling). None of this blocks the design.

---

## 4. Source index (primary unless noted)

**Meta Muse**
- https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (primary; `security.muse.ai` redirects here)
- https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- https://introducing.muse.ai/ ("How We Designed Muse")
- https://www.meta.com/blog/meta-connect-2026-everything-we-announced/
- https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model
- https://huggingface.co/meta-models/Muse-Glimmer-30B
- https://dev.meta.ai/docs/muse-code
- https://dev.meta.ai/docs/muse-code/permissions
- https://dev.meta.ai/docs/muse-code/auth
- https://github.com/pwardle/not-a-mused
- https://venturebeat.com/security/meta-patched-muses-zero-day-but-security-teams-still-lack-visibility-into-what-the-agent-can-access (secondary)
- https://www.infoq.com/news/2026/09/meta-muse-zeroday/ (secondary)
- https://forkast.news/metas-muse-agent-lives-behind-a-kernel-level-sentinel-the-architecture-reveals-where-agent-security-is-heading/ (secondary; adds nothing)

**Agent sandboxes and credential proxies**
- https://github.com/anthropics/sandbox-runtime (`src/sandbox/credential-sentinel.ts`)
- https://www.anthropic.com/engineering/claude-code-sandboxing
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/cloud-environments
- https://platform.claude.com/docs/en/managed-agents/vaults
- https://github.com/paradigmxyz/iron-proxy
- https://github.com/Infisical/agent-vault ; https://docs.agent-vault.dev/learn/security ; https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents
- https://github.com/onecli/onecli
- https://github.com/superradcompany/microsandbox ; https://docs.microsandbox.dev/sdk/typescript/secrets ; https://docs.microsandbox.dev/networking/tls ; https://github.com/vercel/eve/pull/2441
- https://github.com/earendil-works/gondolin
- https://github.com/jingkaihe/matchlock
- https://github.com/coder/httpjail
- https://github.com/superfly/tokenizer ; https://fly.io/blog/tokenized-tokens/ ; https://github.com/superfly/ssokenizer ; https://docs.fly.io/sprites/concepts/connectors/
- https://docs.docker.com/ai/sandboxes/security/credentials/ ; https://docs.docker.com/ai/sandboxes/architecture/
- https://github.com/docker/mcp-gateway/blob/main/docs/security.md
- https://vercel.com/docs/sandbox/concepts/firewall ; https://vercel.com/blog/a-sandbox-without-a-network-boundary-is-only-half-a-sandbox
- https://blog.cloudflare.com/sandbox-auth/ ; https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/
- https://docs.e2b.dev/sandbox/internet-access
- https://deno.com/blog/introducing-deno-sandbox ; https://docs.deno.com/sandbox/security/
- https://learn.chatgpt.com/docs/environments/cloud-environment ; https://developers.openai.com/codex/cloud/internet-access/
- https://github.com/nearai/ironclaw
- https://github.com/nanocoai/nanoclaw (`src/egress-lockdown.ts`, `src/config.ts`)
- https://docs.openclaw.ai/gateway/secrets/secret-store-and-egress ; OpenClaw GHSA-g8p2-7wf7-98mq (via `gh api repos/openclaw/openclaw/security-advisories/…`)

**Proxies and gateways**
- https://github.com/stripe/smokescreen
- https://github.com/mitmproxy/mitmproxy ; https://docs.mitmproxy.org/stable/concepts/options/
- https://github.com/agentgateway/agentgateway
- https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter
- https://docs.litellm.ai/docs/proxy/virtual_keys
- https://tailscale.com/aperture
- https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
- https://github.com/awslabs/aws-sigv4-proxy

**Secret stores and agent identity**
- https://www.1password.dev/agentic-autofill ; https://1password.com/blog/introducing-1password-unified-access
- https://github.com/bitwarden/agent-access ; https://github.com/bitwarden/mcp-server
- https://developer.hashicorp.com/vault/docs/secrets/databases ; https://developer.hashicorp.com/vault/docs/concepts/response-wrapping ; https://www.hashicorp.com/en/blog/announcing-native-ai-agent-support-in-hashicorp-vault ; OpenBao https://github.com/openbao/openbao
- https://aembit.io/blog/openai-workload-identity-federation-aembit-brings-secretless-access-to-the-openai-api/ ; https://www.keycard.ai/ ; https://auth0.com/docs/secure/tokens/token-vault

**Standards and specs**
- RFC 8693 https://www.rfc-editor.org/rfc/rfc8693 ; RFC 9449 https://www.rfc-editor.org/rfc/rfc9449 ; RFC 8705, RFC 9421, RFC 8707 (rfc-editor.org)
- MCP: https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices ; https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
- https://fly.io/blog/macaroons-escalated-quickly/ ; https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/ ; Biscuit https://github.com/eclipse-biscuit
- SPIFFE https://spiffe.io/docs/latest/spiffe-about/overview/

**Browser, SSH and database internals**
- DBSC: https://developer.chrome.com/docs/web-platform/device-bound-session-credentials ; https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html
- Chromium Linux cookie key: https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/posix_key_provider.cc
- Chrome name constraints: https://alexsci.com/blog/name-non-constraint/
- OpenSSH agent restriction: https://www.openssh.org/agent-restrict.html ; https://github.com/openssh/openssh-portable/blob/master/ssh-agent.c
- https://github.com/maxgoedjen/secretive
- PgBouncer: https://www.pgbouncer.org/config.html

**Container runtimes and networking**
- Docker: https://docs.docker.com/reference/cli/docker/network/create/ ; https://docs.docker.com/desktop/features/networking/networking-how-tos/ ; moby v26.0.0 release notes (CVE-2024-29018) https://github.com/moby/moby/releases/tag/v26.0.0
- apple/container: https://github.com/apple/container (docs/command-reference.md)

**Provider OAuth docs**
- Google OAuth: https://developers.google.com/identity/protocols/oauth2/native-app ; Testing-mode 7-day refresh expiry per https://developers.google.com/identity/protocols/oauth2
- GitHub App tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app

**Other**
- Ollama DNS rebinding CVE-2024-28224: https://nvd.nist.gov/vuln/detail/CVE-2024-28224
- Lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
