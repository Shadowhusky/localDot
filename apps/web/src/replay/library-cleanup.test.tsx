// @vitest-environment jsdom
import type { DeleteSessionsResult, SessionCard } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import { TOKEN_KEY } from "../lib/token.ts";
import { providerFixture } from "../settings/testing.ts";
import { FakeWebSocket } from "../testing/fake-websocket.ts";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(TOKEN_KEY, "a".repeat(43));
  window.history.replaceState(null, "", "/");
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const DAY = 86_400_000;
const MB = 1024 ** 2;
const LIBRARY: [string, number, SessionCard["verdict"], number][] = [
  ["Still running", 0, "live", 50 * MB],
  ["Sort the downloads", 1, "done", 300 * MB],
  ["Plan the trip", 2, "stopped", 200 * MB],
  ["Book the hotel", 3, "done", 100 * MB],
  ["Old notes", 40, "done", 1024 * MB],
  ["Older notes", 50, "error", 512 * MB],
];

function fixture(answer?: (ids: string[]) => DeleteSessionsResult | Response) {
  const cards: SessionCard[] = LIBRARY.map(([title, days, verdict, diskBytes], at) => ({
    id: `01M4ECBR5X0R92SYA389FM3Q${String(at).padStart(2, "0")}`,
    title,
    startedAt: new Date(Date.now() - days * DAY - at * 60_000).toISOString(),
    durationMs: verdict === "live" ? null : 61_000,
    verdict,
    steps: 2,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "complete", bytes: diskBytes / 2 },
    diskBytes,
  }));
  const asked: string[][] = [];
  const gone = new Set<string>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/session-index/delete" && init?.method === "POST") {
      const ids = JSON.parse(String(init.body)).ids as string[];
      asked.push(ids);
      const reply = answer?.(ids) ?? { deleted: ids, live: [], failed: [] };
      if (reply instanceof Response) return reply;
      for (const id of reply.deleted) gone.add(id);
      return Response.json(reply);
    }
    if (path === "/api/session-index")
      return Response.json({ sessions: cards.filter((card) => !gone.has(card.id)), next: null });
    if (path === "/api/agent/settings") return Response.json({});
    if (path === "/api/agent/providers") return Response.json(providerFixture());
    if (path === "/api/keyd") return Response.json({ online: false });
    return Response.json([]);
  }) as typeof fetch;
  const id = (title: string) => cards.find((card) => card.title === title)?.id;
  return { fetchImpl, asked, id };
}

async function open(f: ReturnType<typeof fixture>) {
  render(<App fetchImpl={f.fetchImpl} />);
  const replay = screen.getByRole("radio", { name: "Replay" });
  await waitFor(() => expect(replay.hasAttribute("aria-disabled")).toBe(false));
  fireEvent.click(replay);
  await screen.findByRole("button", { name: "Sort the downloads" });
}
const row = (name: string) => screen.getByRole("button", { name });
const picked = (name: string) => row(name).getAttribute("aria-pressed") === "true";
const bar = () => document.querySelector(".replay-library-bar") as HTMLElement;

it("picks rows by press and Shift, and deletes exactly those once confirmed", async () => {
  const f = fixture();
  await open(f);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  expect(screen.queryByRole("button", { name: "Still running" })).toBeNull();
  expect(screen.getByText("Still running")).toBeTruthy();
  fireEvent.click(row("Sort the downloads"));
  expect(picked("Sort the downloads")).toBe(true);
  expect(bar().textContent).toContain("1 selected · 300.0 MB");
  fireEvent.click(row("Book the hotel"), { shiftKey: true });
  expect(["Sort the downloads", "Plan the trip", "Book the hotel"].map(picked)).toEqual([
    true,
    true,
    true,
  ]);
  expect(picked("Old notes")).toBe(false);

  fireEvent.click(within(bar()).getByRole("button", { name: "Delete…" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Delete 3 recordings?" });
  expect(confirm.textContent).toContain("Frees600.0 MB");
  expect(confirm.textContent).toContain(
    "Their videos, screenshots, steps, messages and saved files are removed from this Mac.",
  );
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  });
  expect(f.asked).toEqual([
    ["Sort the downloads", "Plan the trip", "Book the hotel"].map((title) => f.id(title)),
  ]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Plan the trip" })).toBeNull());
  expect(bar().textContent).toContain("Deleted 3 recordings · freed 600.0 MB");
  expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Old notes" })).toBeTruthy();
});

it("selects all that the search shows, never a running task, and Escape leaves select mode", async () => {
  await open(fixture());
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search recordings" }), {
    target: { value: "notes" },
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Plan the trip" })).toBeNull());
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
  expect(picked("Old notes") && picked("Older notes")).toBe(true);
  expect(bar().textContent).toContain("2 selected · 1.5 GB");
  fireEvent.change(screen.getByRole("textbox", { name: "Search recordings" }), {
    target: { value: "" },
  });
  await screen.findByRole("button", { name: "Plan the trip" });
  expect(picked("Plan the trip")).toBe(false);
  expect(bar().textContent).toContain("2 selected");
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(await screen.findByRole("button", { name: "Select" })).toBeTruthy();
  expect(row("Old notes").getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("radio", { name: "Replay" }).getAttribute("aria-checked")).toBe("true");
});

it("counts what each Free up space choice frees, and leaves its picks to review on Cancel", async () => {
  await open(fixture());
  fireEvent.click(screen.getByRole("button", { name: "Free up space" }));
  const menu = await screen.findByRole("menu", { name: "Free up space" });
  const older = within(menu).getByRole("menuitem", { name: /^Older than 30 days/ });
  expect(older.textContent).toContain("2 recordings · 1.5 GB");
  const oldest = within(menu).getByRole("menuitem", { name: /^Older than 90 days/ });
  expect(oldest.getAttribute("aria-disabled")).toBe("true");
  expect(oldest.textContent).toContain("Nothing older than 90 days");
  expect(within(menu).getByRole("menuitem", { name: /^Stopped or failed/ }).textContent).toContain(
    "2 recordings · 712.0 MB",
  );
  fireEvent.click(older);
  const confirm = await screen.findByRole("alertdialog", {
    name: "Delete 2 recordings older than 30 days?",
  });
  expect(confirm.textContent).toContain("Frees1.5 GB");
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect([picked("Old notes"), picked("Older notes"), picked("Book the hotel")]).toEqual([
    true,
    true,
    false,
  ]);
  expect(bar().textContent).toContain("2 selected · 1.5 GB");
});

it("keeps what stayed picked and says why when some recordings can't go", async () => {
  const f = fixture((ids) => ({
    deleted: ids.slice(0, 1),
    live: ids.slice(1, 2),
    failed: ids.slice(2),
  }));
  await open(f);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(row("Sort the downloads"));
  fireEvent.click(row("Book the hotel"), { shiftKey: true });
  fireEvent.click(within(bar()).getByRole("button", { name: "Delete…" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Delete 3 recordings?" });
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  });
  expect(await within(confirm).findByRole("alert")).toHaveProperty(
    "textContent",
    "1 recording was deleted. 1 is still running. Stop it before deleting. 1 couldn't be deleted. Try again.",
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Sort the downloads" })).toBeNull(),
  );
  expect(screen.getByRole("alertdialog", { name: "Delete 2 recordings?" })).toBe(confirm);
  expect(picked("Plan the trip") && picked("Book the hotel")).toBe(true);
});

it("deletes nothing it can't confirm when the request fails", async () => {
  const f = fixture(() => new Response("down", { status: 500 }));
  await open(f);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(row("Old notes"));
  fireEvent.click(within(bar()).getByRole("button", { name: "Delete…" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Delete this recording?" });
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  });
  expect(await within(confirm).findByRole("alert")).toHaveProperty(
    "textContent",
    "The recordings couldn't be deleted. Try again.",
  );
  expect(row("Old notes").getAttribute("aria-pressed")).toBe("true");
});
