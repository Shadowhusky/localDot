// @vitest-environment jsdom
import type { ConversationEntry } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationRows, type LiveFacts } from "../agent/conversation-list.ts";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { HOLD_MS } from "../ui/long-press.ts";
import { ConversationList } from "./ConversationList.tsx";
import { ConversationsBubble, underWayElsewhere } from "./ConversationsBubble.tsx";

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

function open(conversations: ConversationEntry[], facts: LiveFacts = QUIET, current?: string) {
  const { api, posted } = daemon(conversations);
  const onPick = vi.fn();
  render(
    <ConversationList
      api={api}
      open
      layout="sheet"
      current={current ?? null}
      facts={facts}
      onPick={onPick}
      onReplay={() => {}}
    />,
  );
  return { onPick, posted };
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

const rowOf = (title: string) =>
  screen.getAllByRole("row").find((row) => row.textContent?.includes(title)) as HTMLElement;
const surfaceOf = (title: string) => rowOf(title).querySelector(".ui-swipe-content") as Element;

describe("the phone's conversations", () => {
  it("puts those under way first as cards, the one asking first, with what each is doing", async () => {
    const working = entry("Compare flights", live("working", "Comparing the 9:40 fares"));
    const asking = entry("Rename the photos", live("needs-you"));
    const done = entry("Clean up Downloads");
    const { onPick } = open([working, done, asking]);
    const deck = await screen.findByRole("region", { name: /^Under way/ });
    const cards = within(deck).getAllByRole("button", { name: /, 2 min$/ });
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Rename the photos, needs you, 2 min",
      "Compare flights, working, 2 min",
    ]);
    expect(cards[1]?.textContent).toContain("Comparing the 9:40 fares");
    expect(cards[0]?.textContent).toContain("Waiting for your answer");
    // Those under way are not listed again below.
    expect(screen.getAllByRole("row").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Clean up Downloads"),
    ]);
    fireEvent.click(cards[1] as HTMLElement);
    expect(onPick).toHaveBeenCalledWith(working.sessionId, working.sessions);
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
    expect(screen.getAllByRole("row").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Pay the rent"),
    ]);
    expect(screen.getByRole("region", { name: /^Under way/ }).textContent).toContain(
      "Find a plumber",
    );
    fireEvent.click(within(filters).getByRole("button", { name: "Red" }));
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("pins with a long swipe right and archives with a long swipe left", async () => {
    const hotel = entry("Book the hotel");
    const rent = entry("Pay the rent");
    const { posted } = open([hotel, rent]);
    await screen.findAllByRole("row");
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
    await screen.findAllByRole("row");
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
    const { onPick } = open([hotel]);
    await screen.findAllByRole("row");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hand = finger(surfaceOf("Book the hotel"));
    hand.down();
    act(() => vi.advanceTimersByTime(HOLD_MS));
    const card = document.querySelector(".peek-card") as HTMLElement;
    expect(card.textContent).toContain("Book the hotel");
    expect(card.textContent).toContain("Book a hotel in Lisbon for May");
    expect(card.textContent).toContain("1 task");
    expect(card.textContent).toContain("Blue tag");
    const menu = screen.getByRole("menu", { name: "Conversation actions" });
    const first = within(menu).getByRole("menuitem", { name: "Open conversation" });
    // The finger lifts over the menu that came up under it.
    hand.up();
    fireEvent.pointerUp(first);
    fireEvent.click(first);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Conversation actions" })).toBeTruthy();
    fireEvent.click(first);
    expect(onPick).toHaveBeenCalledWith(hotel.sessionId, hotel.sessions);
  });

  it("renames a conversation under way in its own card", async () => {
    const plumber = entry("Find a plumber", live("working"));
    const { posted } = open([plumber]);
    const deck = await screen.findByRole("region", { name: /^Under way/ });
    fireEvent.click(within(deck).getByRole("button", { name: "Actions for Find a plumber" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = within(deck).getByRole("textbox", { name: "New name for Find a plumber" });
    fireEvent.change(field, { target: { value: "Fix the boiler" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(posted).toContainEqual({
        path: `/api/conversations/${plumber.sessionId}/title`,
        body: { title: "Fix the boiler" },
      }),
    );
  });

  it("gives every row and card a button for what its gestures do", async () => {
    open([entry("Book the hotel"), entry("Find a plumber", live("working"))]);
    await screen.findAllByRole("row");
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

describe("the bubble that opens them", () => {
  it("says how many others are under way and whether one needs the user", () => {
    expect(underWayElsewhere([])).toBeUndefined();
    const rows = conversationRows(
      [
        entry("Compare flights", live("working")),
        entry("Rename the photos", live("needs-you")),
        entry("Find a plumber", live("paused")),
      ],
      QUIET,
    );
    expect(underWayElsewhere(rows)).toBe("3 others under way, 1 needs you");
    expect(underWayElsewhere(rows.slice(0, 1))).toBe("1 other under way");
  });

  it("rings itself with an arc for each other conversation under way, not the one on show", async () => {
    const current = entry("On show", live("working"));
    const asking = entry("Rename the photos", live("needs-you"));
    const paused = entry("Find a plumber", live("paused"));
    const { api } = daemon([current, asking, paused, entry("Done")]);
    const { container } = render(
      <ConversationsBubble
        api={api}
        facts={QUIET}
        current={current.sessionId}
        attention
        onOpen={() => {}}
      />,
    );
    const button = screen.getByRole("button", { name: "Conversations" });
    await waitFor(() =>
      expect(container.querySelectorAll(".conversations-ring circle")).toHaveLength(2),
    );
    expect(
      [...container.querySelectorAll(".conversations-ring circle")].map((arc) =>
        arc.getAttribute("data-status"),
      ),
    ).toEqual(["needs-you", "paused"]);
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("2 others under way, 1 needs you");
  });
});
