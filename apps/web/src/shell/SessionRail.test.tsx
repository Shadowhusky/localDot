// @vitest-environment jsdom
import type { ConversationEntry, ConversationLive, SearchHit } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveFacts } from "../agent/conversation-list.ts";
import { createApi } from "../lib/api.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";
import { ConversationList } from "./ConversationList.tsx";
import { usePanelPreferences } from "./panel-preferences.ts";
import { SessionRail, type SessionRailProps } from "./SessionRail.tsx";

const NOW = new Date(2026, 9, 9, 15);
const MINUTE = 60_000;
const QUIET: LiveFacts = { live: null, needsYou: new Set() };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

let next = 0;
function entry(
  title: string,
  ago: number,
  ended: ConversationEntry["ended"] = "done",
  live?: Omit<ConversationLive, "since"> & { ago: number },
): ConversationEntry {
  next++;
  const sessionId = `01M4ECBR5X0R92SYA389FM3Q${String(next).padStart(2, "0")}`;
  return {
    sessionId,
    sessions: [sessionId],
    title,
    said: `${title}, please`,
    startedAt: new Date(NOW.getTime() - ago).toISOString(),
    ended: live ? null : ended,
    ...(live
      ? {
          live: {
            state: live.state,
            since: new Date(NOW.getTime() - live.ago).toISOString(),
            onScreen: live.onScreen,
            ...(live.activity ? { activity: live.activity } : {}),
          },
        }
      : {}),
  };
}

interface Daemon {
  reads: number;
  posts: { path: string; body: unknown }[];
  list: ConversationEntry[];
  rename?: number;
  // What the search index finds, whatever the words.
  hits: SearchHit[];
}

// Keeps names, tags, pins and archives as the daemon does, and lists those archived apart.
function daemon(list: ConversationEntry[]) {
  const state: Daemon = { reads: 0, posts: [], list, hits: [] };
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        state.posts.push({ path, body });
        if (state.rename) return new Response(null, { status: state.rename });
        state.list = state.list.map((each) => {
          if (!path.startsWith(`/api/conversations/${each.sessionId}/`)) return each;
          const { tag, pinned, archived, ...rest } = { ...each, ...body };
          return {
            ...rest,
            ...(tag ? { tag } : {}),
            ...(pinned ? { pinned } : {}),
            ...(archived ? { archived } : {}),
          };
        });
        return new Response(null, { status: 204 });
      }
      if (init?.method === "DELETE") {
        state.list = state.list.filter((each) => path !== `/api/conversations/${each.sessionId}`);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/search")
        return Response.json({ hits: state.hits, complete: true, mode: "fts" });
      const archived = url.searchParams.get("archived") === "1";
      if (!archived) state.reads++;
      return Response.json({
        conversations: state.list.filter((each) => !!each.archived === archived),
        archivedCount: state.list.filter((each) => each.archived).length,
      });
    }) as typeof fetch,
  });
  return { api, state };
}

function rail(list: ConversationEntry[], over: Partial<SessionRailProps> = {}) {
  const { api, state } = daemon(list);
  const props: SessionRailProps = {
    api,
    current: null,
    facts: QUIET,
    expanded: true,
    onExpandedChange: vi.fn(),
    onPick: vi.fn(),
    onNew: vi.fn(),
    ...over,
  };
  const view = render(<SessionRail {...props} />);
  return { api, state, props, view };
}

const nav = () => screen.getByRole("navigation", { name: "Conversations" });
const rowNames = () =>
  [...nav().querySelectorAll(".sessions-item > .sessions-row")].map((row) =>
    row.getAttribute("aria-label"),
  );

it("pins the conversations under way above the rest, each named with its status and age", async () => {
  const done = entry("Book the hotel", 60 * MINUTE);
  const working = entry("Plan the trip", 3 * 60 * MINUTE, null, {
    state: "working",
    ago: 2 * MINUTE,
    onScreen: true,
    activity: "Comparing the fares",
  });
  const waiting = entry("Tidy the photos", 4 * 60 * MINUTE, null, {
    state: "waiting-for-computer",
    ago: 5 * MINUTE,
    onScreen: false,
  });
  const asking = entry("Fill the form", 30 * MINUTE);
  const failed = entry("Summarise the deck", 26 * 60 * MINUTE, "error");
  rail([done, asking, working, waiting, failed], {
    facts: { live: null, needsYou: new Set([asking.sessionId]) },
  });
  await waitFor(() => expect(rowNames()).toHaveLength(5));
  expect(rowNames()).toEqual([
    "Fill the form, needs you, 30 min",
    "Plan the trip, working, on screen, 2 min",
    "Tidy the photos, waiting for the computer, 5 min",
    "Book the hotel, done, 1 h",
    expect.stringMatching(/^Summarise the deck, failed, /),
  ]);
  expect(
    [...nav().querySelectorAll(".sessions-group-label")].map((label) => label.textContent),
  ).toEqual(["Active", "Recent"]);
  const trip = screen.getByRole("button", { name: /^Plan the trip/ });
  expect(trip).toHaveProperty("textContent", expect.stringContaining("Comparing the fares"));
  expect(trip.getAttribute("aria-describedby")).toContain(
    screen.getByText("Comparing the fares").id,
  );
});

it("reads each status from the computer's task when the daemon gives none", async () => {
  const running = entry("Draw a dog", 10 * MINUTE, null);
  const cut = entry("Old errand", 20 * MINUTE, null);
  rail([running, cut, entry("Done one", HOURS(2)), entry("Stopped one", HOURS(3), "stopped")], {
    facts: { live: running.sessionId, activity: "Picking a brush", needsYou: new Set() },
  });
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  expect(rowNames()).toEqual([
    "Draw a dog, working, 10 min",
    "Old errand, stopped, 20 min",
    "Done one, done, 2 h",
    "Stopped one, stopped, 3 h",
  ]);
  expect(screen.getByText("Picking a brush")).toBeTruthy();
});

function HOURS(count: number) {
  return count * 60 * MINUTE;
}

it("marks the conversation on show and takes another up with a click", async () => {
  const shown = entry("Shown", HOURS(1));
  const other = entry("Other", HOURS(2));
  const { props } = rail([shown, other], { current: shown.sessionId });
  const row = await screen.findByRole("button", { name: /^Shown/ });
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(row.closest("[data-current]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Other/ }));
  expect(props.onPick).toHaveBeenCalledWith(other.sessionId, other.sessions);
});

it("keeps one row in the tab order, moves through them with the arrows and takes one up with Return", async () => {
  const a = entry("First", HOURS(1));
  const b = entry("Second", HOURS(2));
  const c = entry("Third", HOURS(3));
  const { props } = rail([a, b, c], { current: b.sessionId });
  await screen.findByRole("button", { name: /^Third/ });
  const rows = [...nav().querySelectorAll<HTMLElement>(".sessions-item > .sessions-row")];
  expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
  rows[1]?.focus();
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Third/);
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Third/);
  fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^First/);
  expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
  fireEvent.keyDown(document.activeElement as Element, { key: "End" });
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Second/);
  fireEvent.click(document.activeElement as Element);
  expect(props.onPick).toHaveBeenLastCalledWith(b.sessionId, b.sessions);
});

it("keeps other conversations out of reach while the one on show can't be left", async () => {
  const shown = entry("Working one", HOURS(1), null);
  const other = entry("Another", HOURS(2));
  const { props } = rail([shown, other], {
    current: shown.sessionId,
    reason: "Finish or stop the current task first.",
  });
  const blocked = await screen.findByRole("button", { name: /^Another/ });
  expect(blocked.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(blocked);
  expect(props.onPick).not.toHaveBeenCalled();
});

it("starts a new conversation, or says why it can't", async () => {
  const { props } = rail([entry("One", HOURS(1))], { newReason: "This conversation is new" });
  const button = screen.getByRole("button", { name: "New conversation" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(props.onNew).not.toHaveBeenCalled();
  cleanup();
  const ready = rail([entry("One", HOURS(1))]);
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(ready.props.onNew).toHaveBeenCalled();
});

function Wired({ api }: { api: SessionRailProps["api"] }) {
  const { panels, update } = usePanelPreferences();
  return (
    <SessionRail
      api={api}
      current={null}
      facts={QUIET}
      expanded={panels.sessions ?? true}
      onExpandedChange={(sessions) => update({ sessions })}
      onPick={() => {}}
      onNew={() => {}}
    />
  );
}

it("collapses to its marks and back with its toggle or Mod+\\, and remembers the choice", async () => {
  const { api } = daemon([entry("Plan the trip", HOURS(1))]);
  const first = render(<Wired api={api} />);
  await screen.findByRole("button", { name: /^Plan the trip/ });
  expect(nav().hasAttribute("data-expanded")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Collapse conversations" }));
  expect(nav().hasAttribute("data-expanded")).toBe(false);
  expect(screen.getByRole("button", { name: "Expand conversations" })).toBeTruthy();
  // Collapsed, a row keeps its whole name for a screen reader and loses its actions.
  expect(screen.getByRole("button", { name: /^Plan the trip, done/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
  first.unmount();
  render(<Wired api={api} />);
  expect(nav().hasAttribute("data-expanded")).toBe(false);
  fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
  expect(nav().hasAttribute("data-expanded")).toBe(true);
  fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true, shiftKey: true });
  expect(nav().hasAttribute("data-expanded")).toBe(true);
});

it("renames a conversation with F2, showing the new name at once, and Escape leaves it", async () => {
  const trip = entry("Plan the trip", HOURS(1));
  const { state } = rail([trip]);
  const row = await screen.findByRole("button", { name: /^Plan the trip/ });
  row.focus();
  fireEvent.keyDown(row, { key: "F2" });
  let field = screen.getByRole("textbox", { name: "Conversation name" });
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Conversation name" })).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Plan the trip/);
  fireEvent.keyDown(document.activeElement as Element, { key: "F2" });
  field = screen.getByRole("textbox", { name: "Conversation name" });
  fireEvent.change(field, { target: { value: "Lisbon in May" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByRole("button", { name: /^Lisbon in May, done/ })).toBeTruthy();
  await waitFor(() =>
    expect(state.posts).toEqual([
      { path: `/api/conversations/${trip.sessionId}/title`, body: { title: "Lisbon in May" } },
    ]),
  );
  await waitFor(() => expect(state.reads).toBeGreaterThan(1));
  expect(screen.getByRole("button", { name: /^Lisbon in May, done/ })).toBeTruthy();
});

it("renames from a row's menu and puts the old name back if the daemon refuses", async () => {
  const trip = entry("Plan the trip", HOURS(1));
  const { state } = rail([trip]);
  state.rename = 500;
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Plan the trip" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
  const field = await screen.findByRole("textbox", { name: "Conversation name" });
  fireEvent.change(field, { target: { value: "Lisbon" } });
  fireEvent.blur(field);
  await waitFor(() => expect(state.posts).toHaveLength(1));
  await screen.findByRole("button", { name: /^Plan the trip, done/ });
});

const events = () => {
  const socket = FakeWebSocket.instances.find(
    (each) => new URL(each.url).pathname === "/api/events" && !each.closed,
  );
  if (!socket) throw new Error("No /api/events socket");
  return socket;
};
const push = (sessionId: string, live?: ConversationLive) =>
  act(() =>
    events().onmessage?.({
      data: JSON.stringify({ type: "conversation.live", sessionId, ...(live ? { live } : {}) }),
    }),
  );

it("follows the changes the daemon pushes, and reads the list when one ends or is new", async () => {
  const trip = entry("Plan the trip", HOURS(1), null, {
    state: "working",
    ago: MINUTE,
    onScreen: true,
  });
  const { state } = rail([trip, entry("Book the hotel", HOURS(2))]);
  await screen.findByRole("button", { name: /^Plan the trip, working/ });
  act(() => events().open());
  expect(state.reads).toBe(1);
  await push(trip.sessionId, {
    state: "needs-you",
    since: NOW.toISOString(),
    onScreen: true,
  });
  expect(rowNames()[0]).toBe("Plan the trip, needs you, on screen, now");
  expect(state.reads).toBe(1);
  state.list = [{ ...trip, ended: "done", live: undefined }, ...state.list.slice(1)];
  await push(trip.sessionId);
  await waitFor(() => expect(rowNames()).toContain("Plan the trip, done, 1 h"));
  expect(state.reads).toBe(2);
  const fresh = entry("Draw a dog", 0, null, { state: "working", ago: 0, onScreen: false });
  state.list = [fresh, ...state.list];
  await push(fresh.sessionId, fresh.live);
  await waitFor(() => expect(rowNames()[0]).toMatch(/^Draw a dog, working/));
  expect(state.reads).toBe(3);
});

it("reads again every 30 s while the page is looked at, and as soon as it is again", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
  const { state } = rail([entry("Plan the trip", HOURS(1))]);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(state.reads).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(state.reads).toBe(2);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await act(() => vi.advanceTimersByTimeAsync(90_000));
  expect(state.reads).toBe(2);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(state.reads).toBe(3);
  window.dispatchEvent(new Event("focus"));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(state.reads).toBe(4);
  hidden.mockRestore();
});

it("shares what it read with the conversations popover, which opens on it at once", async () => {
  const trip = entry("Plan the trip", HOURS(1), null, {
    state: "working",
    ago: MINUTE,
    onScreen: true,
    activity: "Comparing the fares",
  });
  const { api } = rail([trip]);
  await screen.findByRole("button", { name: /^Plan the trip/ });
  render(
    <ConversationList
      api={api}
      open
      current={null}
      facts={QUIET}
      onPick={() => {}}
      onReplay={() => {}}
    />,
  );
  // Before its own read comes back.
  const list = screen.getByRole("grid", { name: "Recent conversations" });
  expect(within(list).getByRole("img", { name: "Working" })).toBeTruthy();
  expect(within(list).getByText("Comparing the fares")).toBeTruthy();
});

const menu = () => screen.getByRole("menu", { name: "Conversation actions" });
const group = (name: string) => within(nav()).getByRole("list", { name });

it("tags, pins and archives from a row's menu, opened from the keyboard or a right click", async () => {
  const trip = entry("Plan the trip", HOURS(1));
  const dog = entry("Draw a dog", HOURS(2));
  const working = entry("Tidy the photos", HOURS(3), null, {
    state: "working",
    ago: MINUTE,
    onScreen: true,
  });
  const { state } = rail([trip, dog, working]);
  const row = await screen.findByRole("button", { name: /^Plan the trip/ });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  fireEvent.click(within(menu()).getByRole("menuitemradio", { name: "Blue" }));
  expect(row.getAttribute("aria-label")).toBe("Plan the trip, blue tag, done, 1 h");
  expect(row.querySelector(".ui-tag-mark")?.getAttribute("data-tag")).toBe("blue");

  fireEvent.contextMenu(row);
  expect(
    within(menu()).getByRole("menuitemradio", { name: "Blue" }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(within(menu()).getByRole("menuitem", { name: "Pin to top" }));
  await waitFor(() =>
    expect(within(group("Pinned")).getByRole("button", { name: /^Plan the trip/ })).toBeTruthy(),
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: /^Tidy the photos/ }));
  const refused = within(menu()).getByRole("menuitem", { name: /^Archive/ });
  expect(refused.getAttribute("aria-disabled")).toBe("true");
  expect(refused.textContent).toContain("Stop this task before archiving its conversation.");
  fireEvent.keyDown(menu(), { key: "Escape" });

  fireEvent.contextMenu(screen.getByRole("button", { name: /^Draw a dog/ }));
  fireEvent.click(within(menu()).getByRole("menuitem", { name: "Archive" }));
  expect(screen.queryByRole("button", { name: /^Draw a dog/ })).toBeNull();
  const archived = await screen.findByRole("button", { name: /^Archived/ });
  expect(archived.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(archived);
  const back = await within(group("Archived")).findByRole("button", { name: /^Draw a dog/ });
  fireEvent.contextMenu(back);
  fireEvent.click(within(menu()).getByRole("menuitem", { name: "Unarchive" }));
  await waitFor(() =>
    expect(within(group("Recent")).getByRole("button", { name: /^Draw a dog/ })).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: /^Archived/ })).toBeNull();
  expect(state.posts).toEqual([
    { path: `/api/conversations/${trip.sessionId}/tag`, body: { tag: "blue" } },
    { path: `/api/conversations/${trip.sessionId}/pin`, body: { pinned: true } },
    { path: `/api/conversations/${dog.sessionId}/archive`, body: { archived: true } },
    { path: `/api/conversations/${dog.sessionId}/archive`, body: { archived: false } },
  ]);
});

it("follows the tags, pins and archives other viewers make", async () => {
  const trip = entry("Plan the trip", HOURS(1));
  const dog = entry("Draw a dog", HOURS(2));
  const { state } = rail([trip, dog]);
  await screen.findByRole("button", { name: /^Plan the trip/ });
  act(() => events().open());
  const organized = (sessionId: string, over: object) =>
    act(() =>
      events().onmessage?.({
        data: JSON.stringify({
          type: "conversation.organized",
          sessionId,
          tag: null,
          pinned: false,
          archived: false,
          ...over,
        }),
      }),
    );
  await organized(trip.sessionId, { tag: "red", pinned: true });
  expect(
    within(group("Pinned"))
      .getByRole("button", { name: /^Plan the trip/ })
      .getAttribute("aria-label"),
  ).toBe("Plan the trip, red tag, done, 1 h");
  expect(state.reads).toBe(1);
  state.list = state.list.map((each) => (each === dog ? { ...dog, archived: true } : each));
  await organized(dog.sessionId, { archived: true });
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Draw a dog/ })).toBeNull());
  expect(state.reads).toBe(2);
  expect(screen.getByRole("button", { name: /^Archived/ }).textContent).toContain("1");
});

it("searches names as you type and what was said once typing pauses, marking why each matched", async () => {
  const trip = entry("Plan the Lisbon trip", HOURS(1));
  const boiler = entry("Call a plumber", HOURS(2));
  const dog = entry("Draw a dog", HOURS(3));
  const { state } = rail([trip, boiler, dog]);
  state.hits = [
    {
      sessionId: boiler.sessionId,
      title: null,
      startedAt: null,
      kind: "user",
      at: NOW.toISOString(),
      snippet: "the \uE000boiler\uE001 in the flat",
    },
  ];
  await screen.findByRole("button", { name: /^Plan the Lisbon trip/ });
  const field = screen.getByRole("textbox", { name: "Search conversations" });
  fireEvent.change(field, { target: { value: "lisbn" } });
  expect(within(group("Results")).getAllByRole("listitem")).toHaveLength(1);
  expect(within(group("Results")).getByText("Lisbon").tagName).toBe("MARK");

  fireEvent.change(field, { target: { value: "boiler" } });
  const found = await waitFor(() =>
    within(group("Results")).getByRole("button", { name: /^Call a plumber/ }),
  );
  expect(found.querySelector(".sessions-activity mark")?.textContent).toBe("boiler");
  expect(document.getElementById(found.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
    "the boiler in the flat",
  );
  fireEvent.keyDown(field, { key: "ArrowDown" });
  expect(document.activeElement).toBe(found);
  fireEvent.keyDown(found, { key: "ArrowUp" });
  expect(document.activeElement).toBe(field);
  fireEvent.keyDown(field, { key: "Escape" });
  expect((field as HTMLInputElement).value).toBe("");
  expect(within(nav()).queryByRole("list", { name: "Results" })).toBeNull();
  state.hits = [];
  fireEvent.change(field, { target: { value: "zebra" } });
  expect(await screen.findByText("Nothing matches “zebra”")).toBeTruthy();
});

it("expands from its search mark, and lets the search go when it collapses", async () => {
  const { props, view } = rail([entry("Plan the trip", HOURS(1))], { expanded: false });
  fireEvent.click(await screen.findByRole("button", { name: "Search conversations" }));
  expect(props.onExpandedChange).toHaveBeenCalledWith(true);
  view.rerender(<SessionRail {...props} expanded />);
  const field = screen.getByRole("textbox", { name: "Search conversations" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "trip" } });
  view.rerender(<SessionRail {...props} expanded={false} />);
  view.rerender(<SessionRail {...props} expanded />);
  expect(
    (screen.getByRole("textbox", { name: "Search conversations" }) as HTMLInputElement).value,
  ).toBe("");
});

it("deletes a conversation from its menu once asked, and never one under way", async () => {
  const trip = entry("Plan the trip", HOURS(1));
  const working = entry("Tidy the photos", HOURS(3), null, {
    state: "working",
    ago: MINUTE,
    onScreen: true,
  });
  const onDeleted = vi.fn();
  rail([trip, working], { onDeleted });
  fireEvent.contextMenu(await screen.findByRole("button", { name: /^Tidy the photos/ }));
  expect(
    within(menu())
      .getByRole("menuitem", { name: /^Delete conversation/ })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.keyDown(menu(), { key: "Escape" });
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Plan the trip/ }));
  fireEvent.click(within(menu()).getByRole("menuitem", { name: "Delete conversation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(trip.sessions));
  await waitFor(() => expect(screen.queryByRole("button", { name: /^Plan the trip/ })).toBeNull());
});
