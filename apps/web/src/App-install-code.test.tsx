// @vitest-environment jsdom
import { act, cleanup, configure, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { TOKEN_KEY } from "./lib/token.ts";
import { providerFixture } from "./settings/testing.ts";
import { FakeWebSocket } from "./testing/fake-websocket.ts";

// The whole app renders in these tests; a slow CI runner needs more than the default second.
configure({ asyncUtilTimeout: 5000 });

const CODE = "c".repeat(43),
  OTHER_CODE = "d".repeat(43);
const TOKEN = "t".repeat(43),
  NEWER = "n".repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function daemon(
  exchange: (body: string) => Response | Promise<Response>,
  whoami = () => Promise.resolve(json({ ok: true })),
) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/auth/exchange-code") {
      expect(window.location.hash).toBe("");
      return exchange(String(init?.body));
    }
    if (path === "/api/whoami") return whoami();
    if (path === "/api/cells") return json([]);
    if (path === "/api/session-index") return json({ sessions: [], next: null });
    if (path === "/api/conversation") return json({ sessions: [], more: false });
    if (path === "/api/agent/settings") return json({});
    if (path === "/api/agent/providers") return json(providerFixture());
    if (path === "/api/keyd")
      return json({
        online: true,
        bootId: "test",
        sealKey: "test",
        audit: { ok: true },
        hairpin: { state: "active", addresses: 1 },
      });
    if (path === "/api/keys") return json({ keys: [] });
    throw new Error(`unexpected test route ${path}`);
  });
}
const exchanges = (request: ReturnType<typeof daemon>) =>
  request.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/auth/exchange-code");
function navigate(code: string) {
  act(() => {
    window.history.replaceState(null, "", `/#code=${code}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", `/#code=${CODE}`);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("App one-use sign-in", () => {
  it("exchanges once under StrictMode and stores only after authenticated whoami succeeds", async () => {
    const pending = deferred<Response>();
    const request = daemon(
      () => json({ token: TOKEN }),
      () => pending.promise,
    );
    render(
      <StrictMode>
        <App fetchImpl={request} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(
        request.mock.calls.some(([url]) => new URL(String(url)).pathname === "/api/whoami"),
      ).toBe(true),
    );
    expect(window.location.hash).toBe("");
    expect(window.localStorage.length).toBe(0);
    expect(exchanges(request)).toHaveLength(1);
    await act(async () => pending.resolve(json({ ok: true })));
    await screen.findAllByRole("button", { name: "Turn on" });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(document.body.textContent).not.toContain(CODE);
  });
  it("reports a lost reply without retrying the consumed code", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const request = daemon(() => Promise.reject(new Error("lost response")));
    render(
      <StrictMode>
        <App fetchImpl={request} />
      </StrictMode>,
    );
    await screen.findByText(/Sign-in could not be confirmed/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(exchanges(request)).toHaveLength(1);
    expect(window.localStorage.length).toBe(0);
  });
  it("reuses the in-flight exchange when an effect is replaced with a new fetch callback", async () => {
    const pending = deferred<Response>();
    const first = daemon(() => pending.promise),
      next = daemon(() => {
        throw new Error("second exchange");
      });
    const view = render(<App fetchImpl={first} />);
    await waitFor(() => expect(exchanges(first)).toHaveLength(1));
    view.rerender(<App fetchImpl={next} />);
    await act(async () => pending.resolve(json({ token: TOKEN })));
    await screen.findAllByRole("button", { name: "Turn on" });
    expect(exchanges(first)).toHaveLength(1);
    expect(exchanges(next)).toHaveLength(0);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
  });
  it("preserves the existing authenticated app when a new link expires", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const request = daemon(() => json({ error: "expired" }, 401));
    render(<App fetchImpl={request} />);
    await screen.findAllByRole("button", { name: "Turn on" });
    await waitFor(() => expect(exchanges(request)).toHaveLength(1));
    await act(async () => {});
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(screen.queryByRole("heading", { name: "Open localDot from Terminal" })).toBeNull();
  });
  it("never lets an older exchange overwrite a newer successful link", async () => {
    const older = deferred<Response>();
    const request = daemon((body) =>
      JSON.parse(body).code === CODE ? older.promise : json({ token: NEWER }),
    );
    render(<App fetchImpl={request} />);
    await waitFor(() => expect(exchanges(request)).toHaveLength(1));
    navigate(OTHER_CODE);
    await screen.findAllByRole("button", { name: "Turn on" });
    await act(async () => older.resolve(json({ token: TOKEN })));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(NEWER);
    expect(exchanges(request)).toHaveLength(2);
  });
  it("ignores a delayed old whoami rejection after a newer link succeeds", async () => {
    const oldCheck = deferred<Response>();
    let checks = 0;
    const request = daemon(
      (body) => json({ token: JSON.parse(body).code === CODE ? TOKEN : NEWER }),
      () => (++checks === 1 ? oldCheck.promise : Promise.resolve(json({ ok: true }))),
    );
    render(<App fetchImpl={request} />);
    await waitFor(() => expect(checks).toBe(1));
    navigate(OTHER_CODE);
    await screen.findAllByRole("button", { name: "Turn on" });
    await act(async () => oldCheck.resolve(json({}, 401)));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(NEWER);
    expect(screen.queryByRole("heading", { name: "Open localDot from Terminal" })).toBeNull();
  });
  it("refuses malformed success authority and ambiguous fragments without storing them", async () => {
    const request = daemon(() => json({ token: "bad" }));
    render(<App fetchImpl={request} />);
    await screen.findByText(/Sign-in could not be confirmed/);
    navigate(`${OTHER_CODE}&token=${TOKEN}`);
    await act(async () => {});
    expect(window.location.hash).toBe("");
    expect(exchanges(request)).toHaveLength(1);
    expect(window.localStorage.length).toBe(0);
  });
  it("rejects authority that fails whoami rather than replacing an existing login", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const request = daemon(
      () => json({ token: NEWER }),
      () => Promise.resolve(json({}, 401)),
    );
    render(<App fetchImpl={request} />);
    await screen.findAllByRole("button", { name: "Turn on" });
    await act(async () => {});
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(exchanges(request)).toHaveLength(1);
  });
});
