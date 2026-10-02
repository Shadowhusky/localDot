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

// The daemon's real 502 body for a create or start with Docker unreachable (a run against a missing
// socket), and the caption the Theatre shows for it.
const DOCKER_DOWN = "docker unreachable on /networks/create: ENOENT; is Docker Desktop running?";
const DOCKER_DOWN_CAPTION =
  "Docker isn't answering. Check that Docker Desktop is running, then try again.";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noCells = async () => json([]);
const unauthorized = async () => new Response("unauthorized", { status: 401 });
const summary = (
  state: CellSummary["state"],
  connection: CellSummary["stream"]["connection"] = "none",
  error?: string,
): CellSummary => ({
  id: CELL_ID,
  state,
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection, viewers: 0, lastUpstreamAt: null },
  ...(error ? { error } : {}),
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
    // Until the daemon has listed its cells, Start can't create a second computer.
    expect(screen.getByTestId("hud-status").textContent).toBe("Checking…");
    expect(screen.getByRole("button").getAttribute("aria-disabled")).toBe("true");
    screen.getByRole("button").click();
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("No computer"));
    const start = screen.getByRole("button", { name: "Start computer" });
    expect(start.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Mode" }).textContent).toContain("Watch");
    start.click();
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("Starting…"));
    expect(calls).toEqual(["GET /api/cells", "POST /api/cells"]);
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
      if (path.endsWith("/start")) return new Response(DOCKER_DOWN, { status: 502 });
      return json([summary("ready", "live")]);
    }) as typeof fetch;
    render(<App fetchImpl={fetchImpl} />);
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("Live"));
    screen.getByRole("button", { name: "Stop computer" }).click();
    await waitFor(() => expect(calls).toContain(`POST /api/cells/${CELL_ID}/stop`));
    act(() =>
      FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify(summary("stopped")) }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button").getAttribute("aria-disabled")).toBeNull(),
    );
    screen.getByRole("button", { name: "Start computer" }).click();
    expect(await screen.findByText(DOCKER_DOWN_CAPTION)).toBeTruthy();
    expect(document.body.textContent).not.toContain("ENOENT");
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

describe("App HUD", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    window.localStorage.setItem(TOKEN_KEY, TOKEN);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterEach(cleanup);

  const status = () => screen.getByTestId("hud-status").textContent;
  const button = () => screen.getByRole("button");
  const caption = () => document.querySelector(".caption")?.textContent ?? "";
  const pushState = (cell: CellSummary) =>
    act(() => FakeWebSocket.instances.at(-1)?.onmessage?.({ data: JSON.stringify(cell) }));

  it("says the computer's state is unknown when the list fails, and lists again on Try again", async () => {
    let up = false;
    const d = daemon(() => {
      if (!up) throw new TypeError("Failed to fetch");
      return json([summary("stopped")]);
    });
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("Unavailable"));
    expect(caption()).toContain("localDot's daemon isn't answering.");
    expect(screen.queryByText("No computer")).toBeNull();
    up = true;
    screen.getByRole("button", { name: "Try again" }).click();
    await waitFor(() => expect(status()).toBe("Stopped"));
    expect(d.seen()).toEqual(["GET /api/cells", "GET /api/cells"]);
  });

  it("keeps one HUD button through Start, disabled while the create is out, with focus kept", async () => {
    const created = deferred<Response>();
    const d = daemon(({ method }) => (method === "POST" ? created.promise : json([])));
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("No computer"));
    const start = button();
    start.focus();
    start.click();
    await waitFor(() => expect(status()).toBe("Starting…"));
    expect(button()).toBe(start);
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(start);
    start.click();
    expect(d.seen()).toEqual(["GET /api/cells", "POST /api/cells"]);
    created.resolve(json(summary("starting"), 202));
    await waitFor(() => expect(start.getAttribute("aria-disabled")).toBeNull());
    expect(button()).toBe(start);
    expect(start.textContent).toBe("Stop computer");
    expect(document.activeElement).toBe(start);
  });

  it("stops a computer that is still starting", async () => {
    const d = daemon(({ method }) =>
      method === "POST" ? new Response(null, { status: 202 }) : json([summary("starting")]),
    );
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("Starting…"));
    screen.getByRole("button", { name: "Stop computer" }).click();
    await waitFor(() => expect(d.seen()).toContain(`POST /api/cells/${CELL_ID}/stop`));
  });

  it("offers Stop again for a computer whose stop failed, and says why in plain words", async () => {
    const d = daemon(({ method }) =>
      method === "POST"
        ? new Response(null, { status: 202 })
        : json([summary("failed", "none", `stop failed: ${DOCKER_DOWN}`)]),
    );
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("Failed"));
    expect(caption()).toContain("Your computer didn't stop");
    expect(caption()).not.toContain("ENOENT");
    screen.getByRole("button", { name: "Stop computer" }).click();
    await waitFor(() => expect(d.seen()).toContain(`POST /api/cells/${CELL_ID}/stop`));
  });

  it("lists again after a create that got no answer, and adopts the computer the daemon saved", async () => {
    let saved = false;
    const d = daemon(({ method }) => {
      if (method === "POST") {
        saved = true;
        throw new TypeError("Failed to fetch");
      }
      return json(saved ? [summary("starting")] : []);
    });
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("No computer"));
    button().click();
    await waitFor(() =>
      expect(d.seen()).toEqual(["GET /api/cells", "POST /api/cells", "GET /api/cells"]),
    );
    await waitFor(() => expect(status()).toBe("Starting…"));
    expect(screen.getByRole("button", { name: "Stop computer" })).toBeTruthy();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  });

  it("says a computer that no longer exists is gone, and lists again", async () => {
    let gone = false;
    const d = daemon(({ method }) => {
      if (method === "POST") {
        gone = true;
        return new Response("unknown cell", { status: 404 });
      }
      return json(gone ? [] : [summary("stopped")]);
    });
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("Stopped"));
    button().click();
    await waitFor(() => expect(status()).toBe("No computer"));
    expect(caption()).toContain("This computer no longer exists.");
    expect(caption()).not.toContain("unknown cell");
    expect(d.seen()).toEqual([
      "GET /api/cells",
      `POST /api/cells/${CELL_ID}/start`,
      "GET /api/cells",
    ]);
  });

  it("clears a refused request's message once the computer's state changes", async () => {
    const d = daemon(({ method }) =>
      method === "POST" ? new Response(DOCKER_DOWN, { status: 502 }) : json([summary("stopped")]),
    );
    render(<App fetchImpl={d.fetchImpl} />);
    await waitFor(() => expect(status()).toBe("Stopped"));
    button().click();
    await waitFor(() => expect(caption()).toContain(DOCKER_DOWN_CAPTION));
    pushState({
      ...summary("stopped"),
      stream: { connection: "none", viewers: 1, lastUpstreamAt: 1 },
    });
    expect(caption()).toContain(DOCKER_DOWN_CAPTION);
    pushState(summary("starting"));
    expect(caption()).not.toContain(DOCKER_DOWN_CAPTION);
    expect(status()).toBe("Starting…");
  });

  it("announces the caption politely and names the stream state in the bar", async () => {
    render(<App fetchImpl={daemon(() => json([summary("ready", "connecting")])).fetchImpl} />);
    await waitFor(() => expect(status()).toBe("Connecting…"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(document.querySelector(".caption")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector(".bar .live")?.textContent).toBe("Not live");
    expect(document.body.textContent).not.toContain("Offline");
    pushState(summary("ready", "live"));
    expect(document.querySelector(".bar .live")?.textContent).toBe("Live");
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
    // The unmount's or cell change's effect cleanup closes the socket; let React run it first.
    await act(async () => {});
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
    // The unmount's or cell change's effect cleanup closes the socket; let React run it first.
    await act(async () => {});
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
