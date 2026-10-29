import { describe, expect, it } from "vitest";
import { runLink, runRemote, runTailscale } from "./links.ts";
import { LocalApiError } from "./local-dot.ts";
import { fakeLocalDot, type Route } from "./testing/fake-local-dot.ts";

const TAILNET = "https://studio.example.ts.net:4750";
const RELAY = "https://0123456789abcdef0123456789abcdef.r.localdot.dev";
const remote = (state: string, enabled = true) => ({
  supported: true,
  enabled,
  state,
  url: enabled ? RELAY : null,
  detail: "Remote connections pass through the localDot relay.",
});

function app(routes: Record<string, Route> = {}) {
  let n = 0;
  const f = fakeLocalDot({
    routes: {
      // Each code is its own and expires a minute after it is issued.
      "POST /api/install-code": () => ({
        code: String(n++).padStart(43, "c"),
        expiresAt: f.m.clock + 60_000,
      }),
      "GET /api/access-links": {
        links: [
          { origin: "http://localhost:4750", label: "This computer" },
          { origin: "https://100.64.0.1:4744", label: "Remote address" },
        ],
        tailscale: { state: "served", origin: TAILNET, message: "On" },
      },
      "GET /api/remote-access": remote("online"),
      "POST /api/remote-access/link": () => ({
        url: `${RELAY}/_remote/pair#remote=${"a".repeat(64)}&code=${"r".repeat(43)}`,
        expiresAt: f.m.clock + 60_000,
      }),
      ...routes,
    },
  });
  f.m.clock = Date.now();
  return f;
}

describe("localdot link", () => {
  it("prints a fresh one-use link for each way in, each with its own code", async () => {
    const f = app();
    expect(await runLink(f.l, f.io, { qr: false, json: false })).toBe(0);
    expect(f.out[0]).toMatch(/^Each link signs in once and expires within a minute \(by .+\)\./);
    expect(f.out.slice(1)).toEqual([
      `  This computer   http://127.0.0.1:4750/#code=${"0".padStart(43, "c")}`,
      `  Tailscale       ${TAILNET}/#code=${"1".padStart(43, "c")}`,
      `  Remote address  https://100.64.0.1:4744/#code=${"2".padStart(43, "c")}`,
      `  Remote access   ${RELAY}/_remote/pair#remote=${"a".repeat(64)}&code=${"r".repeat(43)}`,
    ]);
    expect(f.err).toEqual([]);
  });

  it("chooses one kind, and fails with the next step when there is none", async () => {
    const f = app({
      "GET /api/remote-access": remote("off", false),
      "GET /api/access-links": {
        links: [{ origin: "http://localhost:4750", label: "This computer" }],
        tailscale: { state: "ready-to-enable", origin: TAILNET, message: "Turn on to open…" },
      },
    });
    expect(await runLink(f.l, f.io, { only: "remote", qr: false, json: false })).toBe(1);
    expect(f.out).toEqual([]);
    expect(f.err).toEqual([
      "Remote access is off. To open localDot from anywhere through the localDot relay: localdot remote on",
    ]);
    expect(f.calls).not.toContain("POST /api/install-code");
    const network = app({
      "GET /api/access-links": {
        links: [],
        tailscale: { state: "ready-to-enable", message: "Turn on to open…" },
      },
    });
    expect(await runLink(network.l, network.io, { only: "network", qr: false, json: false })).toBe(
      1,
    );
    expect(network.err[0]).toContain("Turn it on with: localdot tailscale on");
  });

  it("still gives the local link when nothing else is set up", async () => {
    const f = app({
      "GET /api/remote-access": remote("connecting"),
      "GET /api/access-links": {
        links: [{ origin: "http://localhost:4750", label: "This computer" }],
        tailscale: {
          state: "not-installed",
          message: "Tailscale isn't installed on this Mac. Install it and sign in to use it here.",
        },
      },
    });
    expect(await runLink(f.l, f.io, { qr: false, json: false })).toBe(0);
    expect(f.out).toContain(
      "No network link: Tailscale isn't installed on this Mac. Install it and sign in to use it here.",
    );
    expect(f.out.join("\n")).toContain("Remote access is on but still connecting");
  });

  it("describes the links in JSON", async () => {
    const f = app();
    expect(await runLink(f.l, f.io, { only: "network", qr: false, json: true })).toBe(0);
    const report = JSON.parse(f.out[0] ?? "");
    expect(report.links.map((link: { kind: string }) => link.kind)).toEqual(["network", "network"]);
    expect(report.links[0]).toMatchObject({ label: "Tailscale", expiresAt: expect.any(Number) });
    expect(report.tailscale.state).toBe("served");
  });

  it("draws the remote link for a phone, never the local one", async () => {
    const f = app();
    expect(await runLink(f.l, f.io, { qr: true, json: false })).toBe(0);
    expect(f.out.at(-1)).toContain("Scan it with your phone (Remote access).");
    const local = app({
      "GET /api/remote-access": remote("off", false),
      "GET /api/access-links": { links: [], tailscale: { state: "not-running", message: "Off." } },
    });
    expect(await runLink(local.l, local.io, { qr: true, json: false })).toBe(1);
    expect(local.err.at(-1)).toContain("No QR code: a phone needs remote access");
  });

  it("falls back to the configured addresses on an app that doesn't list them", async () => {
    const f = app({ "GET /api/access-links": new LocalApiError(404, "Not Found") });
    f.l.publicOrigins = [new URL("https://box.example.ts.net:4750")];
    expect(await runLink(f.l, f.io, { only: "network", qr: false, json: false })).toBe(0);
    expect(f.out[1]).toContain("https://box.example.ts.net:4750/#code=");
  });

  it("says how to start an app that isn't running", async () => {
    const f = app();
    f.m.app = "stopped";
    await expect(runLink(f.l, f.io, { qr: false, json: false })).rejects.toThrow(
      "localDot isn't running. Start it with: localdot up",
    );
  });

  it("refuses a code the app issued wrongly", async () => {
    const f = app({ "POST /api/install-code": { code: "short", expiresAt: Date.now() + 1000 } });
    await expect(runLink(f.l, f.io, { qr: false, json: false })).rejects.toThrow(
      "Invalid sign-in code",
    );
  });
});

describe("localdot remote", () => {
  it("turns remote access on and waits for the relay", async () => {
    let state = "off";
    let reads = 0;
    const f = app({
      "GET /api/remote-access": () => {
        if (state === "connecting" && ++reads > 2) state = "online";
        return remote(state, state !== "off");
      },
      "PUT /api/remote-access": (body: unknown) => {
        expect(body).toEqual({ enabled: true });
        state = "connecting";
        return remote(state);
      },
    });
    expect(await runRemote(f.l, f.io, { operation: "on", json: false })).toBe(0);
    expect(f.out.at(-1)).toContain("Remote access is on and connected at");
    expect(f.out.at(-1)).toContain("localdot link remote --qr");
  });

  it("turns it off, shows its state, and explains an unsupported relay", async () => {
    const f = app({ "PUT /api/remote-access": remote("off", false) });
    expect(await runRemote(f.l, f.io, { operation: "off", json: false })).toBe(0);
    expect(f.out).toEqual([
      "Remote access is off. Links shared through the relay stop working too.",
    ]);
    const status = app({ "GET /api/remote-access": remote("off", false) });
    expect(await runRemote(status.l, status.io, { operation: "status", json: true })).toBe(0);
    expect(JSON.parse(status.out[0] ?? "")).toMatchObject({ enabled: false, state: "off" });
    const unsupported = app({
      "GET /api/remote-access": { ...remote("off", false), supported: false, detail: "Fix it." },
    });
    await expect(
      runRemote(unsupported.l, unsupported.io, { operation: "on", json: false }),
    ).rejects.toThrow("Remote access isn't available: Fix it.");
  });
});

describe("localdot tailscale", () => {
  it("turns sharing on, showing the page that allows HTTPS while it waits", async () => {
    let served = false;
    const f = app({
      "GET /api/access-links?fresh=1": {
        links: [],
        tailscale: { state: "ready-to-enable", origin: TAILNET, message: "Turn on…" },
      },
      "POST /api/access-links/tailscale": {
        links: [],
        tailscale: {
          state: "needs-approval",
          origin: TAILNET,
          approvalUrl: "https://login.tailscale.com/f/serve?node=abc",
          message: "Allow HTTPS",
        },
      },
      "GET /api/access-links": () => {
        const answer = served
          ? { links: [], tailscale: { state: "served", origin: TAILNET, message: "On" } }
          : {
              links: [],
              tailscale: { state: "needs-approval", origin: TAILNET, message: "Allow" },
            };
        served = true;
        return answer;
      },
    });
    expect(await runTailscale(f.l, f.io, "on")).toBe(0);
    expect(f.out).toContain(
      "Allow HTTPS for this computer in Tailscale: https://login.tailscale.com/f/serve?node=abc",
    );
    expect(f.out.at(-1)).toBe(
      `Tailscale is sharing localDot at ${TAILNET}. For a sign-in link: localdot link network`,
    );
  });

  it("shows why it can't share, with the step that fixes it", async () => {
    const f = app({
      "GET /api/access-links?fresh=1": {
        links: [],
        tailscale: {
          state: "unavailable",
          reason: "permission",
          message: "Tailscale needs your permission.",
          operatorHint: "sudo tailscale set --operator=$USER",
        },
      },
    });
    expect(await runTailscale(f.l, f.io, "status")).toBe(0);
    expect(f.out).toEqual([
      "Tailscale is unavailable. Tailscale needs your permission.",
      "  sudo tailscale set --operator=$USER",
    ]);
  });
});
