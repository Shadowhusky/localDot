// @vitest-environment jsdom
import type { ManualStreamInput, ScreenSelectionSnapshot } from "@localdot/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { createApi } from "../lib/api.ts";
import { useStageFront } from "./useStageFront.ts";

const PARENT = "01JXYZ0000000000000000AAAA";
const BROWSER = "01JXYZ0000000000000000BBBB";
const parent: CellSummary = {
  id: PARENT,
  state: "ready",
  scale: 2,
  createdAt: "2026-10-01T10:00:00.000Z",
  stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
};
const geometry = { w: 2560, h: 1600, scale: 2 as const };
const onBrowser: ScreenSelectionSnapshot = {
  screen: "browser",
  cellId: BROWSER,
  geometry,
  revision: 3,
};
const onDesktop: ScreenSelectionSnapshot = {
  screen: "desktop",
  cellId: PARENT,
  geometry,
  revision: 4,
};
afterEach(cleanup);

function setup(
  initial: {
    selection?: ScreenSelectionSnapshot;
    sessionId?: string | null;
    holding?: boolean;
  },
  ticket: () => Response = () => Response.json({ cellId: BROWSER, ticket: "t", path: "/x" }),
) {
  const fetchImpl = vi.fn<typeof fetch>(async () => ticket());
  const api = createApi("fixture", { fetchImpl });
  const view = renderHook(
    (props: typeof initial) =>
      useStageFront(api, parent, props.selection, props.sessionId, !!props.holding),
    { initialProps: { sessionId: "task", ...initial } },
  );
  return { ...view, fetchImpl };
}

describe("what the stage has in front", () => {
  it("is where dot works, and the desktop with nothing at work", () => {
    const { result, rerender } = setup({});
    expect(result.current.screen).toBe("desktop");
    expect(result.current.dot).toBeNull();
    rerender({ sessionId: "task", selection: onBrowser });
    expect(result.current.screen).toBe("browser");
    expect(result.current.browser).toBe(onBrowser);
    rerender({ sessionId: "task", selection: onDesktop });
    expect(result.current.screen).toBe("desktop");
  });

  it("brings the desktop forward at the user's word, until dot moves", () => {
    const { result, rerender } = setup({ selection: onBrowser });
    act(() => result.current.pick("desktop"));
    expect(result.current.screen).toBe("desktop");
    expect(result.current.dot).toBe("browser");
    // dot working on, on the screen it was on, leaves the user's choice alone.
    rerender({ sessionId: "task", selection: { ...onBrowser, revision: 9 } });
    expect(result.current.screen).toBe("desktop");
    rerender({ sessionId: "task", selection: onDesktop });
    rerender({ sessionId: "task", selection: { ...onBrowser, revision: 11 } });
    expect(result.current.screen).toBe("browser");
  });

  it("finds the running browser when the user asks for it with dot on the desktop", async () => {
    const { result, fetchImpl } = setup({ selection: onDesktop });
    expect(result.current.browser).toBeUndefined();
    act(() => result.current.pick("browser"));
    await waitFor(() => expect(result.current.screen).toBe("browser"));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      `/api/cells/${PARENT}/browser-stream-ticket`,
    );
    expect(result.current.browser).toMatchObject({ screen: "browser", cellId: BROWSER, geometry });
    expect(result.current.dot).toBe("desktop");
  });

  it("says so when no browser is running, and stays on the desktop", async () => {
    const { result } = setup(
      { selection: onDesktop },
      () => new Response("the browser is unavailable", { status: 409 }),
    );
    act(() => result.current.pick("browser"));
    await waitFor(() => expect(result.current.problem).toMatch(/isn't running/));
    expect(result.current.screen).toBe("desktop");
  });

  it("goes back to dot's screen when the user hands the computer back, not when they take it", () => {
    const { result, rerender } = setup({ selection: onBrowser });
    act(() => result.current.pick("desktop"));
    rerender({ sessionId: "task", selection: onBrowser, holding: true });
    expect(result.current.screen).toBe("desktop");
    rerender({ sessionId: "task", selection: onBrowser, holding: false });
    expect(result.current.screen).toBe("browser");
  });

  it("follows dot onto the web browser and back with no word from the user", () => {
    const { result, rerender, fetchImpl } = setup({ selection: onDesktop });
    rerender({ sessionId: "task", selection: onBrowser });
    expect(result.current.screen).toBe("browser");
    rerender({ sessionId: "task", selection: { ...onDesktop, revision: 5 } });
    expect(result.current.screen).toBe("desktop");
    rerender({ sessionId: "task", selection: { ...onBrowser, revision: 6 } });
    expect(result.current.screen).toBe("browser");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the screen a task last used once it stops working, checking its browser still runs", async () => {
    const retired = { ...onBrowser, cellId: "01JXYZ0000000000000000CCCC" };
    const { result, rerender, fetchImpl } = setup({ selection: retired });
    // The task ends, or is at rest: its selection is no longer shown.
    rerender({ sessionId: "task" });
    // dot's window stays on show while a ticket says which browser runs now.
    expect(result.current.screen).toBe("browser");
    expect(result.current.dot).toBeNull();
    expect(result.current.browser).toMatchObject({ cellId: retired.cellId });
    await waitFor(() => expect(result.current.browser).toMatchObject({ cellId: BROWSER }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.current.problem).toBeNull();
  });

  it("starts another task, a conversation taken up or a new one from the desktop", () => {
    const { result, rerender } = setup({ selection: onBrowser });
    rerender({ sessionId: "older" });
    expect(result.current.screen).toBe("desktop");
    rerender({ sessionId: "task" });
    expect(result.current.screen).toBe("browser");
    rerender({ sessionId: null });
    expect(result.current.screen).toBe("desktop");
  });

  it("goes to the desktop, saying nothing, when the task's browser no longer runs", async () => {
    const { result, rerender, fetchImpl } = setup(
      { selection: onBrowser },
      () => new Response("the browser is unavailable", { status: 409 }),
    );
    rerender({ sessionId: "task" });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.screen).toBe("desktop"));
    expect(result.current.problem).toBeNull();
  });

  it("forgets the choice with the task", () => {
    const { result, rerender } = setup({});
    act(() => result.current.pick("desktop"));
    rerender({ sessionId: "next", selection: onBrowser });
    expect(result.current.screen).toBe("browser");
  });
});

describe("where the page's input goes", () => {
  const key: ManualStreamInput = { kind: "key", combo: ["a"] };
  it("names no screen for the one dot is on, so an input stays what it always was", () => {
    const { result } = setup({ selection: onBrowser });
    expect(result.current.route(key)).toEqual(key);
  });

  it("names the screen in front when it isn't dot's", () => {
    const { result } = setup({ selection: onBrowser });
    act(() => result.current.pick("desktop"));
    expect(result.current.route(key)).toEqual({ ...key, screen: "desktop" });
  });

  it("keeps the screen under the pointer, and drops the name when that is dot's", () => {
    const { result } = setup({ selection: onBrowser });
    const click: ManualStreamInput = {
      kind: "click",
      at: { x: 1, y: 1 },
      button: "left",
      count: 1,
    };
    expect(result.current.route({ ...click, screen: "desktop" })).toEqual({
      ...click,
      screen: "desktop",
    });
    expect(result.current.route({ ...click, screen: "browser" })).toEqual(click);
  });
});
