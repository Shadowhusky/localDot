// @vitest-environment jsdom
import type { AttentionItem, ConversationEntry } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationRows, type LiveFacts } from "../agent/conversation-list.ts";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { HOLD_MS } from "../ui/long-press.ts";
import { PhoneList, rowLine } from "./PhoneList.tsx";

const WIDTH = 360;
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // Reduced motion, so a swipe lands at once; and rows as wide as a phone's.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => WIDTH,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
});

const HOUR = 3_600_000;
let next = 0;
function entry(title: string, over: Partial<ConversationEntry> = {}): ConversationEntry {
  next++;
  const sessionId = `01M4ECBR5X0R92SYA389FM4Q${String(next).padStart(2, "0")}`;
  return {
    sessionId,
    sessions: [sessionId],
    title,
    said: `${title}, please`,
    startedAt: new Date(Date.now() - HOUR).toISOString(),
    ended: "done",
    ...over,
  };
}
const live = (state: NonNullable<ConversationEntry["live"]>["state"], activity?: string) => ({
  ended: null,
  live: {
    state,
    since: new Date(Date.now() - 120_000).toISOString(),
    onScreen: false,
    ...(activity ? { activity } : {}),
  },
});

function daemon(conversations: ConversationEntry[]) {
  const posted: { path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init.body ?? "null")) });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/search")
      return Response.json({ hits: [], complete: true, mode: "fts" });
    return Response.json({ conversations, archivedCount: 0 });
  }) as typeof fetch;
  return { api: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1" }), posted };
}

const QUIET: LiveFacts = { live: null, needsYou: new Set() };

function open(
  conversations: ConversationEntry[],
  facts: LiveFacts = QUIET,
  current?: string,
  attention: AttentionItem[] = [],
) {
  const { api, posted } = daemon(conversations);
  const onOpen = vi.fn();
  render(
    <PhoneList
      api={api}
      current={current ?? null}
      facts={facts}
      attention={attention}
      onOpen={onOpen}
      onNew={() => {}}
      onReplay={() => {}}
      computer={{ name: "Studio Mac", menu: null }}
    />,
  );
  return { onOpen, posted };
}

function finger(target: Element) {
  const send = (type: string, x: number, y = 30) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      }),
    );
  return {
    swipe(from: number, to: number) {
      send("pointerdown", from);
      for (let step = 1; step <= 12; step++) send("pointermove", from + ((to - from) * step) / 12);
      send("pointerup", to);
    },
    down: (x = 120) => send("pointerdown", x),
    up: (x = 120) => send("pointerup", x),
  };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".phone-row-wrap")];
const rowOf = (title: string) =>
  rows().find((row) => row.textContent?.includes(title)) as HTMLElement;
const surfaceOf = (title: string) => rowOf(title).querySelector(".ui-swipe-content") as Element;

describe("the phone's conversations", () => {
  it("puts whichever needs the user first, the rest by how soon they might", async () => {
    const working = entry("Compare flights", live("working", "Comparing the 9:40 fares"));
    const asking = entry("Rename the photos", live("needs-you"));
    const done = entry("Clean up Downloads", { line: "I moved 40 files." });
    const { onOpen } = open([done, working, asking]);
    await screen.findAllByRole("listitem");
    expect(rows().map((row) => row.dataset.status)).toEqual(["needs-you", "working", "done"]);
    expect(rowOf("Compare flights").textContent).toContain("Comparing the 9:40 fares");
    expect(rowOf("Clean up Downloads").textContent).toContain("I moved 40 files.");
    fireEvent.click(within(rowOf("Compare flights")).getByRole("button", { name: /^Compare/ }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Compare flights" }),
      expect.anything(),
    );
  });

  it("gives what needs the user an amber point, and what finished unseen a point of its own", async () => {
    const asking = entry("Rename the photos", live("needs-you"));
    const finished = entry("Clean up Downloads");
    open([asking, finished], QUIET, undefined, [
      {
        key: "a",
        sessionId: finished.sessionId,
        level: "done",
        reason: "done",
        task: null,
        at: 1,
      } as AttentionItem,
    ]);
    await screen.findAllByRole("listitem");
    expect(rowOf("Rename the photos").querySelector(".conversation-avatar-point")).toBeTruthy();
    expect(within(rowOf("Clean up Downloads")).getByRole("img", { name: "Unread" })).toBeTruthy();
  });

  it("keeps pinned conversations in a rail at the top, until a search", async () => {
    const pinned = entry("Weekly numbers", { pinned: true });
    open([entry("Book the hotel"), pinned]);
    const rail = await screen.findByRole("list", { name: "Pinned" });
    expect(within(rail).getByRole("button", { name: /^Weekly numbers/ })).toBeTruthy();
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), {
      target: { value: "weekly" },
    });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Pinned" })).toBeNull());
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Weekly numbers"),
    ]);
  });

  it("shows the tags in use as filters, each a toggle", async () => {
    const blue = entry("Book the hotel", { tag: "blue" });
    const red = entry("Pay the rent", { tag: "red" });
    const liveRed = entry("Find a plumber", { tag: "red", ...live("working") });
    open([blue, red, liveRed, entry("Untagged")]);
    const filters = await screen.findByRole("group", { name: "Show only a colour tag" });
    const chips = within(filters).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Red", "Blue"]);
    fireEvent.click(within(filters).getByRole("button", { name: "Red" }));
    expect(within(filters).getByRole("button", { name: "Red" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(rows()).toHaveLength(2);
    fireEvent.click(within(filters).getByRole("button", { name: "Red" }));
    expect(rows()).toHaveLength(4);
  });

  it("pins with a long swipe right and archives with a long swipe left", async () => {
    const hotel = entry("Book the hotel");
    const rent = entry("Pay the rent");
    const { posted } = open([hotel, rent]);
    await screen.findAllByRole("listitem");
    finger(surfaceOf("Book the hotel")).swipe(40, 320);
    await waitFor(() =>
      expect(posted).toContainEqual({
        path: `/api/conversations/${hotel.sessionId}/pin`,
        body: { pinned: true },
      }),
    );
    finger(surfaceOf("Pay the rent")).swipe(340, 60);
    await waitFor(() =>
      expect(posted).toContainEqual({
        path: `/api/conversations/${rent.sessionId}/archive`,
        body: { archived: true },
      }),
    );
  });

  it("shows Pin and, for one not under way, Archive and More behind a row", async () => {
    const resting = entry("Watch the oven", { ended: null });
    open([entry("Book the hotel"), resting], {
      live: resting.sessionId,
      idle: true,
      needsYou: new Set(),
    });
    await screen.findAllByRole("listitem");
    const faces = (title: string) =>
      [...rowOf(title).querySelectorAll(".ui-swipe-face")].map((face) => face.textContent);
    expect(faces("Book the hotel")).toEqual(["Pin", "More", "Archive"]);
    // Its task is on the computer, so it can't be archived yet.
    expect(faces("Watch the oven")).toEqual(["Pin", "More"]);
    for (const face of rowOf("Book the hotel").querySelectorAll(".ui-swipe-faces"))
      expect(face.getAttribute("aria-hidden")).toBe("true");
  });

  it("magnifies a held row into its preview with its menu, and letting go chooses nothing", async () => {
    const hotel = entry("Book the hotel", { said: "Book a hotel in Lisbon for May", tag: "blue" });
    const { onOpen } = open([hotel]);
    await screen.findAllByRole("listitem");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hand = finger(surfaceOf("Book the hotel"));
    hand.down();
    act(() => vi.advanceTimersByTime(HOLD_MS));
    const card = document.querySelector(".peek-card") as HTMLElement;
    expect(card.textContent).toContain("Book the hotel");
    expect(card.textContent).toContain("Book a hotel in Lisbon for May");
    const menu = screen.getByRole("menu", { name: "Conversation actions" });
    const first = within(menu).getByRole("menuitem", { name: "Open conversation" });
    // The finger lifts over the menu that came up under it.
    hand.up();
    fireEvent.pointerUp(first);
    fireEvent.click(first);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Conversation actions" })).toBeTruthy();
    fireEvent.click(first);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Book the hotel" }), null);
  });

  it("renames in place from the menu", async () => {
    const plumber = entry("Find a plumber");
    const { posted } = open([plumber]);
    await screen.findAllByRole("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Actions for Find a plumber" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "New name for Find a plumber" });
    fireEvent.change(field, { target: { value: "Fix the boiler" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(posted).toContainEqual({
        path: `/api/conversations/${plumber.sessionId}/title`,
        body: { title: "Fix the boiler" },
      }),
    );
  });

  it("gives every row a button for what its gestures do", async () => {
    open([entry("Book the hotel"), entry("Find a plumber", live("working"))]);
    await screen.findAllByRole("listitem");
    const actions = screen.getAllByRole("button", { name: /^Actions for / });
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Actions for Find a plumber",
      "Actions for Book the hotel",
    ]);
    fireEvent.click(actions[1] as HTMLElement);
    const menu = await screen.findByRole("menu", { name: "Conversation actions" });
    expect(within(menu).getByRole("menuitem", { name: "Pin to top" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    expect(within(menu).getByRole("group", { name: "Tag" })).toBeTruthy();
    expect(document.querySelector(".peek-card")).toBeNull();
  });
});

describe("what a row says", () => {
  const row = (over: Partial<ConversationEntry>, facts = QUIET) =>
    conversationRows([entry("A task", over)], facts)[0] as ReturnType<
      typeof conversationRows
    >[number];

  it("is what dot is doing, or else what it last said", () => {
    expect(rowLine(row(live("working", "Reading fares")), undefined)).toBe("Reading fares");
    expect(rowLine(row({ line: "**Booked** the 9:40." }), undefined)).toBe("Booked the 9:40.");
    expect(rowLine(row({}), undefined)).toBe("A task, please");
  });

  it("says what a conversation waits on", () => {
    expect(rowLine(row(live("waiting-for-computer")), undefined)).toBe("Waiting for the computer");
    expect(rowLine(row({ ...live("needs-you"), line: "OK to send?" }), undefined)).toBe(
      "dot needs you. OK to send?",
    );
    expect(rowLine(row({ ...live("paused"), line: "Three held." }), undefined)).toBe(
      "Paused. Three held.",
    );
  });
});

describe("choosing several", () => {
  const ticked = () =>
    screen
      .queryAllByRole("checkbox")
      .filter((each) => each.getAttribute("aria-checked") === "true")
      .map((each) => each.getAttribute("aria-label")?.split(".")[0]);

  it("starts from Select in the bar, lists the pinned among the rows and deletes them once asked", async () => {
    const pinned = entry("Weekly numbers", { pinned: true });
    const hotel = entry("Book the hotel");
    const fares = entry("Compare fares");
    let list = [hotel, pinned, fares];
    const removed: string[] = [];
    const api = createApi("a".repeat(43), {
      origin: "http://127.0.0.1",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "DELETE") {
          removed.push(path);
          list = list.filter((each) => !path.endsWith(each.sessionId));
          return new Response(null, { status: 204 });
        }
        if (path === "/api/search") return Response.json({ hits: [], complete: true, mode: "fts" });
        return Response.json({ conversations: list, archivedCount: 0 });
      }) as typeof fetch,
    });
    const onDeleted = vi.fn();
    render(
      <PhoneList
        api={api}
        current={null}
        facts={QUIET}
        attention={[]}
        onOpen={vi.fn()}
        onNew={() => {}}
        onReplay={() => {}}
        onDeleted={onDeleted}
        computer={{ name: "Studio Mac", menu: null }}
      />,
    );
    await screen.findByRole("list", { name: "Pinned" });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.queryByRole("list", { name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByRole("checkbox", { name: /^Weekly numbers/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Compare fares/ }));
    expect(ticked()).toEqual(["Weekly numbers", "Compare fares"]);
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete 2 conversations?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(removed.sort()).toEqual(
      [pinned, fares].map((each) => `/api/conversations/${each.sessionId}`).sort(),
    );
    expect(onDeleted).toHaveBeenCalledWith([...pinned.sessions, ...fares.sessions]);
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy();
  });

  it("starts from a row's menu with that row ticked, and Escape or Cancel lets them go", async () => {
    open([entry("Book the hotel"), entry("Compare fares")]);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Compare fares" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    expect(ticked()).toEqual(["Compare fares"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: /^Compare fares/ })),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(ticked()).toEqual(["Book the hotel", "Compare fares"]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
  });
});
