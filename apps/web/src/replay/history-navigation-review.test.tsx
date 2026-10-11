// @vitest-environment jsdom
import { emptyManifest, type SessionCard, ulid } from "@localdot/protocol";
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
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(count = 2) {
  const cards: SessionCard[] = Array.from({ length: count }, (_, index) => ({
    id: ulid(),
    title: index === 0 ? "Newest notes" : "Older notes",
    startedAt: `2026-10-0${3 - index}T10:00:00.000Z`,
    durationMs: 2000,
    verdict: "done",
    steps: 0,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "none", bytes: 0 },
  }));
  const deleted: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname;
    if (path === "/api/session-index")
      return Response.json({
        sessions: cards
          .filter((c) => !deleted.includes(c.id))
          .slice(0, Number(u.searchParams.get("limit")) || 50),
        next: null,
      });
    const card = cards.find((c) => path.startsWith(`/api/sessions/${c.id}`));
    if (card) {
      if (init?.method === "DELETE") {
        deleted.push(card.id);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/card")) return Response.json(card);
      if (path.endsWith("/recording"))
        return Response.json({
          manifest: emptyManifest("none"),
          live: false,
          upto: 0,
          servedBytes: 0,
        });
      if (path.endsWith("/events"))
        return new Response(
          [
            {
              v: 1,
              id: ulid(),
              seq: 0,
              t: 0,
              agent: "main",
              type: "session.start",
              data: { screen: { w: 1280, h: 800, scale: 1 }, os: "linux", title: card.title },
            },
            {
              v: 1,
              id: ulid(),
              seq: 1,
              t: 2000000,
              agent: "main",
              type: "session.end",
              data: { reason: "done" },
            },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n"),
        );
    }
    if (path === "/api/agent/settings") return Response.json({});
    if (path === "/api/agent/providers") return Response.json(providerFixture());
    if (path === "/api/keyd") return Response.json({ online: false });
    return Response.json([]);
  }) as typeof fetch;
  return { cards, deleted, fetchImpl };
}
async function open(f: ReturnType<typeof fixture>) {
  render(<App fetchImpl={f.fetchImpl} />);
  const button = screen.getByRole("radio", { name: "Replay" });
  await waitFor(() => expect(button.hasAttribute("aria-disabled")).toBe(false));
  fireEvent.click(button);
  await screen.findByRole("button", { name: "Newest notes" });
  return button;
}
// Opens a recording from the library, which shows a row's recording at a press without its preview.
async function play(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("heading", { name: title });
}
async function library() {
  fireEvent.keyDown(window, { key: "Escape" });
  await screen.findByRole("textbox", { name: "Search recordings" });
}
async function remove(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Delete ${title}` }));
  const confirm = await screen.findByRole("alertdialog", { name: "Delete this recording?" });
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
  });
}
const replayParam = () => new URLSearchParams(window.location.search).get("replay");
// Resolves after the traversal, or after a short wait when there is no entry to move to.
async function travel(delta: number) {
  await act(async () => {
    const moved = new Promise<void>((resolve) => {
      const settle = () => {
        window.removeEventListener("popstate", settle);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, 300);
      window.addEventListener("popstate", settle);
    });
    window.history.go(delta);
    await moved;
  });
  return replayParam();
}
async function watch() {
  fireEvent.click(screen.getByRole("radio", { name: "Watch" }));
  await waitFor(() => expect(window.location.search).toBe(""));
}
function enterApp() {
  window.history.replaceState(null, "", "/before");
  window.history.pushState(null, "", "/");
}
it("browser Back never reopens a recording deleted after a Watch round-trip", async () => {
  const f = fixture();
  enterApp();
  const button = await open(f);
  await play("Older notes");
  await waitFor(() => expect(replayParam()).toBe(f.cards[1]?.id));
  await watch();
  fireEvent.click(button);
  await remove("Older notes");
  expect(f.deleted).toEqual([f.cards[1]?.id]);
  const visited = [];
  for (let step = 0; step < 4; step++) visited.push(await travel(-1));
  expect(visited).not.toContain(f.cards[1]?.id);
  expect(screen.queryByRole("heading", { name: "Older notes" })).toBeNull();
  expect(window.location.pathname).toBe("/before");
});
it("Back and Forward never reopen a recording deleted after it played", async () => {
  const f = fixture();
  enterApp();
  await open(f);
  await play("Newest notes");
  await library();
  await remove("Newest notes");
  expect(f.deleted).toEqual([f.cards[0]?.id]);
  const visited = [];
  for (const delta of [1, -1, -1, 1, 1, 1]) visited.push(await travel(delta));
  expect(visited).not.toContain(f.cards[0]?.id);
  expect(screen.queryByRole("heading", { name: "Newest notes" })).toBeNull();
});
it("keeps the other recordings in the library after deleting the newest", async () => {
  const f = fixture();
  const button = await open(f);
  await remove("Newest notes");
  expect(f.deleted).toEqual([f.cards[0]?.id]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Newest notes" })).toBeNull());
  expect(screen.getByRole("button", { name: "Older notes" })).toBeTruthy();
  await watch();
  expect(
    button.hasAttribute("aria-disabled"),
    "remaining older recording must still be reachable from Replay",
  ).toBe(false);
  fireEvent.click(button);
  expect(await screen.findByRole("button", { name: "Older notes" })).toBeTruthy();
});
it("deleting an older recording leaves the newest one to play", async () => {
  const f = fixture();
  await open(f);
  await remove("Older notes");
  expect(f.deleted).toEqual([f.cards[1]?.id]);
  await play("Newest notes");
  expect(replayParam()).toBe(f.cards[0]?.id);
  expect(screen.getByRole("radio", { name: "Replay" }).hasAttribute("aria-disabled")).toBe(false);
});
it("deleting the final recording legitimately disables Replay once back in Watch", async () => {
  const f = fixture(1);
  const button = await open(f);
  await remove("Newest notes");
  expect(f.deleted).toHaveLength(1);
  expect(await screen.findByText("No recordings yet")).toBeTruthy();
  await watch();
  expect(button.hasAttribute("aria-disabled")).toBe(true);
});

it("returns directly to the conversation when the recording was opened from Watch", async () => {
  const f = fixture();
  enterApp();
  window.history.pushState({ fromWatch: true }, "", `/?replay=${f.cards[0]?.id}`);
  render(<App fetchImpl={f.fetchImpl} />);
  await screen.findByRole("heading", { name: "Newest notes" });
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(replayParam()).toBeNull());
  expect(screen.queryByRole("textbox", { name: "Search recordings" })).toBeNull();
  expect(screen.getByRole("radio", { name: "Watch" }).getAttribute("aria-checked")).toBe("true");
  // Forward restores the recording and retains the same return destination.
  await travel(1);
  await screen.findByRole("heading", { name: "Newest notes" });
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(replayParam()).toBeNull());
});
