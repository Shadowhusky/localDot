// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { CellSummary } from "./types.ts";
import { useFreshStart } from "./useFreshStart.ts";

const OLD = "01JXYZ0000000000000000ABCD";
const FRESH = "01JXYZ0000000000000000EFGH";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const cell = (patch: Partial<CellSummary> = {}): CellSummary => ({
  id: OLD,
  state: "failed",
  scale: 2,
  createdAt: "2026-10-09",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  ...patch,
});

function control() {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  let answer: (response: Response) => void = () => {};
  const api = createApi("t", {
    origin: "http://fixture",
    fetchImpl: (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    },
  });
  return { api, calls, answer: (response: Response) => answer(response) };
}

function Shell({
  api,
  computer,
  selectReady,
}: {
  api: ReturnType<typeof createApi>;
  computer: CellSummary;
  selectReady(id: string): Promise<boolean>;
}) {
  const fresh = useFreshStart(api, computer, selectReady);
  return (
    <div>
      <button type="button" onClick={fresh.run}>
        {fresh.busy ? "Starting fresh" : "Start fresh"}
      </button>
      <p data-testid="error">{fresh.error ?? ""}</p>
      <p data-testid="curtain">
        {fresh.curtain
          ? `${fresh.curtain.busy ? "busy" : "offered"} ${fresh.curtain.note ?? ""}`
          : ""}
      </p>
      <p data-testid="available">{String(fresh.available)}</p>
    </div>
  );
}

it("sends a confirmed reset, then opens the fresh computer in its place", async () => {
  const { api, calls, answer } = control();
  const selectReady = vi.fn(async () => true);
  render(<Shell api={api} computer={cell({ needsFreshStart: true })} selectReady={selectReady} />);
  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Starting fresh" }));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: `http://fixture/api/cells/${OLD}/reset`,
    method: "POST",
    body: { eraseComputer: true },
  });
  expect(screen.getByTestId("curtain").textContent).toBe("busy ");
  await act(async () => answer(Response.json({ newCellId: FRESH, phase: "ready" })));
  expect(selectReady).toHaveBeenCalledWith(FRESH);
  expect(localStorage.getItem(`localdot-fresh-start:${OLD}`)).toBeNull();
  expect(screen.getByRole("button").textContent).toBe("Start fresh");
});

it("tries the same request again after one didn't finish", async () => {
  const { api, calls, answer } = control();
  const selectReady = vi.fn(async () => true);
  render(<Shell api={api} computer={cell({ needsFreshStart: true })} selectReady={selectReady} />);
  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  await act(async () =>
    answer(
      new Response("reset completion unconfirmed; retry the same request explicitly", {
        status: 409,
      }),
    ),
  );
  expect(screen.getByTestId("error").textContent).toBe("Starting fresh didn't finish. Try again.");
  expect(screen.getByTestId("curtain").textContent).toBe(
    "offered Starting fresh didn't finish. Try again.",
  );
  expect(selectReady).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  const first = calls[0]?.body as { requestId: string };
  expect(calls[1]?.body).toEqual({ requestId: first.requestId, eraseComputer: true });
});

it("offers the curtain's way out only when it is needed", () => {
  const { api } = control();
  const selectReady = vi.fn(async () => true);
  const view = render(
    <Shell api={api} computer={cell({ state: "ready" })} selectReady={selectReady} />,
  );
  expect(screen.getByTestId("curtain").textContent).toBe("");
  expect(screen.getByTestId("available").textContent).toBe("true");
  // Held aside by a fresh start that began here and didn't finish.
  localStorage.setItem(`localdot-fresh-start:${OLD}`, "01JXYZ0000000000000000WXYZ");
  view.rerender(
    <Shell api={api} computer={cell({ fenced: { revision: 1 } })} selectReady={selectReady} />,
  );
  expect(screen.getByTestId("curtain").textContent).toBe(
    "offered Starting fresh didn't finish. Try again.",
  );
  expect(screen.getByTestId("available").textContent).toBe("false");
  localStorage.clear();
  view.rerender(
    <Shell api={api} computer={cell({ fenced: { revision: 1 } })} selectReady={selectReady} />,
  );
  expect(screen.getByTestId("curtain").textContent).toBe("");
});
