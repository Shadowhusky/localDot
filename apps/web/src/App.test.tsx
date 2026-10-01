// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import type { CellSummary } from "./cells/types.ts";
import { TOKEN_KEY } from "./lib/token.ts";
import { FakeWebSocket } from "./testing/fake-websocket.ts";

const TOKEN = "a".repeat(43);
const CELL_ID = "01JXYZ0000000000000000ABCD";

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
