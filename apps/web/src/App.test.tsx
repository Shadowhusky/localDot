// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { CellSummary } from "./cells/types.ts";
import { TOKEN_KEY } from "./lib/token.ts";
import { fakeChromium } from "./testing/fake-chromium.ts";
import { FakeWebSocket } from "./testing/fake-websocket.ts";

const TOKEN = "a".repeat(43);
const NEWER = "b".repeat(43);
const CELL_ID = "01JXYZ0000000000000000ABCD";

interface Call {
  method: string;
  path: string;
  token: string;
}

// Plays the daemon: answer(call) gives each request's response. Every call is recorded with the
// token it carried.
function daemon(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const call = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      token: auth.replace(/^Bearer /, ""),
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  const seen = () => calls.map((c) => `${c.method} ${c.path}`);
  return { fetchImpl, calls, seen };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noCells = async () => json([]);
const unauthorized = async () => new Response("unauthorized", { status: 401 });
const summary = (
  state: CellSummary["state"],
  connection: CellSummary["stream"]["connection"] = "none",
): CellSummary => ({
  id: CELL_ID,
  state,
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection, viewers: 0, lastUpstreamAt: null },
});

describe("App token states", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  // Vitest runs without globals, so Testing Library's automatic cleanup never registers.
  afterEach(cleanup);

  it("asks for the token when none is stored", () => {
    render(<App fetchImpl={noCells as typeof fetch} />);
    expect(screen.getByRole("alert").textContent).toContain("No access token");
  });

  it("shows the Theatre with a Start computer control when the daemon has no cell", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/api/cells") && init?.method === "POST") {
        return json(
          {
            id: CELL_ID,
            state: "starting",
            scale: 2,
            createdAt: "",
            stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
          },
          202,
        );
      }
      return json([]);
    }) as typeof fetch;
    render(<App fetchImpl={fetchImpl} />);
    expect(screen.queryByRole("button", { name: "Start computer" })).toBeNull();
    const start = await screen.findByRole("button", { name: "Start computer" });
    expect(screen.getByTestId("hud-status").textContent).toBe("No computer");
    expect(screen.getByRole("navigation", { name: "Mode" }).textContent).toContain("Watch");
    start.click();
    expect(await screen.findByText("Starting…")).toBeTruthy();
    expect(calls).toContain("POST /api/cells");
  });

  it("forgets a rejected token and says so, without asking the daemon again", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const fetchImpl = vi.fn(unauthorized);
    render(<App fetchImpl={fetchImpl} />);
    expect(await screen.findByText(/rejected the stored token/)).toBeTruthy();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("takes a well-formed token link opened in the tab that already shows the page", async () => {
    render(<App fetchImpl={noCells as typeof fetch} />);
    expect(screen.getByRole("alert").textContent).toContain("No access token");

    window.location.hash = "#token=abc";
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("No access token");

    window.location.hash = `#token=${TOKEN}`;
    expect(await screen.findByRole("button", { name: "Start computer" })).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
  });

  it("follows the cell over its status socket and closes it, and any pending retry, on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const fetchImpl = (async () => json([summary("starting")])) as typeof fetch;

    const watching = render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const [first] = FakeWebSocket.instances;
    expect(first?.url).toBe(`ws://${window.location.host}/api/cells/${CELL_ID}/status`);
    expect(first?.protocols).toEqual(["localdot.v1", `localdot.token.${TOKEN}`]);
    act(() => first?.onmessage?.({ data: JSON.stringify(summary("ready", "live")) }));
    expect(screen.getByTestId("hud-status").textContent).toBe("Live");
    expect(document.querySelector(".stage")?.classList.contains("lit")).toBe(true);
    expect(document.querySelector(".bar .live")?.textContent).toBe("Live");
    watching.unmount();
    expect(first?.closed).toBe(true);

    const retrying = render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1]?.onclose?.());
    expect(vi.getTimerCount()).toBe(1);
    retrying.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stops and restarts the computer from the HUD and shows a refused request under the stage", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/stop")) return new Response(null, { status: 202 });
      if (path.endsWith("/start")) return new Response("Docker is not running", { status: 502 });
      return json([summary("ready", "live")]);
    }) as typeof fetch;
    render(<App fetchImpl={fetchImpl} />);
    (await screen.findByRole("button", { name: "Stop computer" })).click();
    act(() =>
      FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify(summary("stopped")) }),
    );
    (await screen.findByRole("button", { name: "Start computer" })).click();
    expect(await screen.findByText("Docker is not running")).toBeTruthy();
    expect(calls).toEqual([
      "GET /api/cells",
      `POST /api/cells/${CELL_ID}/stop`,
      `POST /api/cells/${CELL_ID}/start`,
    ]);
  });

  it("mints a fresh stream ticket each time the status socket reopens, not on its first open", async () => {
    const restore = fakeChromium();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      window.localStorage.setItem(TOKEN_KEY, TOKEN);
      const calls: string[] = [];
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/stream-ticket")) {
          return json({
            ticket: "T".repeat(22),
            path: `/cells/${CELL_ID}/desktop/${"T".repeat(22)}/`,
          });
        }
        return json([summary("ready", "live")]);
      }) as typeof fetch;
      const minted = () => calls.filter((c) => c === `POST /api/cells/${CELL_ID}/stream-ticket`);
      render(<App fetchImpl={fetchImpl} />);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      await waitFor(() => expect(minted()).toHaveLength(1));
      act(() => FakeWebSocket.instances[0]?.onopen?.());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(minted()).toHaveLength(1);
      act(() => FakeWebSocket.instances[0]?.onclose?.());
      act(() => vi.advanceTimersByTime(500));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      act(() => FakeWebSocket.instances[1]?.onopen?.());
      await waitFor(() => expect(minted()).toHaveLength(2));
    } finally {
      restore();
    }
  });

  it("goes back to No computer and closes the status socket when the cell is removed", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    render(<App fetchImpl={(async () => json([summary("stopped")])) as typeof fetch} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() =>
      FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify(summary("removed")) }),
    );
    expect(screen.getByTestId("hud-status").textContent).toBe("No computer");
    expect(screen.getByRole("button", { name: "Start computer" })).toBeTruthy();
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
  });
});

// The daemon refuses a status socket before the handshake: 403 for a revoked token, 404 for a cell
// it no longer knows. The browser sees a close that never followed an open.
describe("App on a refused status socket", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  afterEach(cleanup);

  it("asks whoami once, and on a 401 shows the panel and stops reconnecting", async () => {
    let revoked = false;
    const d = daemon(({ path }) => {
      if (revoked) return new Response("unauthorized", { status: 401 });
      return path === "/api/cells" ? json([summary("stopped")]) : json({ ok: true });
    });
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    revoked = true;
    act(() => FakeWebSocket.instances[0]?.onclose?.());
    expect(await screen.findByText(/rejected the stored token/)).toBeTruthy();
    expect(d.seen()).toEqual(["GET /api/cells", "GET /api/whoami"]);
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("re-lists the cells when the token is still good, and adopts a list without the cell", async () => {
    let removed = false;
    const d = daemon(({ path }) => {
      if (path === "/api/whoami") return json({ ok: true });
      return json(removed ? [] : [summary("stopped")]);
    });
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(screen.getByTestId("hud-status").textContent).toBe("Stopped");
    removed = true;
    act(() => FakeWebSocket.instances[0]?.onclose?.());
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("No computer"));
    expect(d.seen()).toEqual(["GET /api/cells", "GET /api/whoami", "GET /api/cells"]);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("adopts the re-listed cell's state and keeps watching it when it is still listed", async () => {
    let listed = summary("starting");
    const d = daemon(({ path }) => (path === "/api/whoami" ? json({ ok: true }) : json([listed])));
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    listed = summary("stopped");
    act(() => FakeWebSocket.instances[0]?.onclose?.());
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("Stopped"));
    act(() => vi.advanceTimersByTime(500));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not ask whoami when a socket that had opened drops", async () => {
    const d = daemon(({ path }) =>
      path === "/api/cells" ? json([summary("stopped")]) : json({ ok: true }),
    );
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]?.onopen?.());
    act(() => FakeWebSocket.instances[0]?.onclose?.());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.seen()).toEqual(["GET /api/cells"]);
  });
});

describe("App token hardening", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterEach(cleanup);

  it("stores a token from the link only once the daemon has accepted it", async () => {
    const whoami = deferred<Response>();
    const d = daemon(({ path }) => (path === "/api/whoami" ? whoami.promise : json([])));
    window.location.hash = `#token=${TOKEN}`;
    render(<App fetchImpl={d.fetchImpl} />);
    expect(window.location.hash).toBe("");
    await waitFor(() => expect(d.seen()).toEqual(["GET /api/whoami"]));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    whoami.resolve(json({ ok: true }));
    await screen.findByRole("button", { name: "Start computer" });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(d.calls.every((c) => c.token === TOKEN)).toBe(true);
  });

  it("keeps the stored token when a link brings one the daemon rejects", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const d = daemon(({ token }) =>
      token === TOKEN ? json([]) : new Response("unauthorized", { status: 401 }),
    );
    window.location.hash = `#token=${NEWER}`;
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() =>
      expect(d.calls).toContainEqual({ method: "GET", path: "/api/whoami", token: NEWER }),
    );
    await screen.findByRole("button", { name: "Start computer" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(screen.queryByText("No access token")).toBeNull();
    expect(d.calls.filter((c) => c.path === "/api/cells").every((c) => c.token === TOKEN)).toBe(
      true,
    );
  });

  it("says the link's token was rejected when there is no stored one, and stores nothing", async () => {
    const d = daemon(() => new Response("unauthorized", { status: 401 }));
    window.location.hash = `#token=${NEWER}`;
    render(<App fetchImpl={d.fetchImpl} />);
    expect(await screen.findByText(/rejected the token in the link/)).toBeTruthy();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(d.seen()).toEqual(["GET /api/whoami"]);
  });

  it("does not let a late 401 for an older token erase the newer one", async () => {
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    const oldList = deferred<Response>();
    const d = daemon(({ token, path }) => {
      if (token === TOKEN && path === "/api/cells") return oldList.promise;
      return path === "/api/whoami" ? json({ ok: true }) : json([]);
    });
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(d.seen()).toEqual(["GET /api/cells"]));
    window.location.hash = `#token=${NEWER}`;
    await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBe(NEWER));
    await screen.findByRole("button", { name: "Start computer" });
    oldList.resolve(new Response("unauthorized", { status: 401 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe(NEWER);
    expect(screen.queryByText("No access token")).toBeNull();
    expect(screen.getByRole("button", { name: "Start computer" })).toBeTruthy();
  });

  it("checks the link's token again when the daemon did not answer", async () => {
    let answers = 0;
    const d = daemon(({ path }) => {
      if (path !== "/api/whoami") return json([]);
      answers += 1;
      if (answers === 1) throw new TypeError("Failed to fetch");
      return json({ ok: true });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      window.location.hash = `#token=${TOKEN}`;
      render(<App fetchImpl={d.fetchImpl} />);
      expect(await screen.findByText("Checking the link…")).toBeTruthy();
      await waitFor(() => expect(answers).toBe(1));
      expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
      act(() => vi.advanceTimersByTime(2000));
      await screen.findByRole("button", { name: "Start computer" });
      expect(window.localStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    } finally {
      vi.useRealTimers();
    }
  });

  it("points at the link on the origin the page was opened from", () => {
    render(<App fetchImpl={noCells as typeof fetch} />);
    expect(screen.getByRole("alert").textContent).toContain(`${window.location.origin}/#token=…`);
    expect(window.location.origin).not.toBe("http://127.0.0.1:4750");
  });
});
