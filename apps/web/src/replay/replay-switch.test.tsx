// @vitest-environment jsdom
import { emptyManifest, type SessionCard, ulid } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function recorded(title: string, durationMs: number, verdict: SessionCard["verdict"] = "done") {
  const card: SessionCard = {
    id: ulid(),
    title,
    startedAt: "2026-10-03T10:00:00.000Z",
    durationMs,
    verdict,
    steps: 1,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "none", bytes: 0 },
  };
  const frameId = ulid();
  const event = (seq: number, t: number, type: string, data: unknown, step?: string) => ({
    v: 1,
    id: ulid(),
    seq,
    t: t * 1000,
    agent: "main",
    type,
    data,
    ...(step ? { step } : {}),
  });
  const events = [
    event(0, 0, "session.start", {
      screen: { w: 1280, h: 800, scale: 1 },
      os: "linux",
      title,
    }),
    event(1, 1000, "step.start", { kind: "gui" }, "open"),
    event(2, 2000, "observe", { frameId, width: 1280, height: 800 }, "open"),
    event(3, 2500, "step.end", { status: "ok" }, "open"),
    ...(verdict === "live" ? [] : [event(4, durationMs, "session.end", { reason: "done" })]),
  ];
  return { card, frameId, events };
}

function fixture(sessions: ReturnType<typeof recorded>[]) {
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/session-index")
      return Response.json({ sessions: sessions.map((s) => s.card), next: null });
    const session = sessions.find((s) => path.startsWith(`/api/sessions/${s.card.id}/`));
    if (session) {
      if (path.endsWith("/card")) return Response.json(session.card);
      if (path.endsWith("/recording"))
        return Response.json({
          manifest: emptyManifest("none"),
          live: session.card.verdict === "live",
          upto: 0,
          servedBytes: 0,
        });
      if (path.endsWith("/events"))
        return new Response(session.events.map((e) => JSON.stringify(e)).join("\n"));
      if (path.endsWith(`/thumbs/${session.frameId}`)) return new Response(new Blob(["webp"]));
      return new Response(null, { status: 404 });
    }
    if (path === "/api/agent/settings") return Response.json({});
    if (path === "/api/agent/providers") return Response.json(providerFixture());
    if (path === "/api/keyd") return Response.json({ online: false });
    return Response.json([]);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const replayTime = () => screen.findByRole("status", { name: "Replay time" });
const query = (name: string) => new URLSearchParams(window.location.search).get(name);
const sessionCard = (title: string) =>
  within(screen.getByRole("complementary", { name: "Recorded sessions" }))
    .getByText(title)
    .closest("button") as HTMLButtonElement;

it("opens a picked session at its own start, while a deep link still opens at its time", async () => {
  const newest = recorded("Newest notes", 120_000);
  const older = recorded("Older notes", 60_000);
  const f = fixture([newest, older]);
  window.history.replaceState(null, "", `/?replay=${newest.card.id}&t=90000`);
  render(<App fetchImpl={f.fetchImpl} />);
  const time = await replayTime();
  await waitFor(() => expect(time.textContent).toBe("1:30 / 2:00"));
  fireEvent.click(sessionCard("Older notes"));
  await screen.findByRole("heading", { name: "Older notes" });
  await waitFor(() => expect(time.textContent).toBe("0:00 / 1:00"));
  expect(query("replay")).toBe(older.card.id);
  expect(query("t")).toBe("0");
});

it("never asks for the previous session's screenshots under the picked session", async () => {
  const newest = recorded("Newest notes", 120_000);
  const older = recorded("Older notes", 60_000);
  const f = fixture([newest, older]);
  window.history.replaceState(null, "", `/?replay=${newest.card.id}`);
  render(<App fetchImpl={f.fetchImpl} />);
  // A step's screenshot loads when its row is unfolded in Activity.
  const unfoldStep = async () =>
    fireEvent.click(
      within(await screen.findByTestId("step-row")).getByRole("button", { expanded: false }),
    );
  await unfoldStep();
  await waitFor(() =>
    expect(f.requests).toContain(`/api/sessions/${newest.card.id}/thumbs/${newest.frameId}`),
  );
  fireEvent.click(sessionCard("Older notes"));
  await screen.findByRole("heading", { name: "Older notes" });
  await unfoldStep();
  await waitFor(() =>
    expect(f.requests).toContain(`/api/sessions/${older.card.id}/thumbs/${older.frameId}`),
  );
  expect(f.requests).not.toContain(`/api/sessions/${older.card.id}/thumbs/${newest.frameId}`);
});

it("leads back to Watch from a finished session and offers Jump to live for a live one", async () => {
  const finished = recorded("Finished notes", 60_000);
  const live = recorded("Live notes", 60_000, "live");
  const f = fixture([live, finished]);
  window.history.replaceState(null, "", `/?replay=${finished.card.id}`);
  render(<App fetchImpl={f.fetchImpl} />);
  const back = await screen.findByRole("button", { name: "Back to Watch" });
  expect(screen.queryByRole("button", { name: "Jump to live" })).toBeNull();
  fireEvent.click(back);
  await waitFor(() => expect(query("replay")).toBeNull());
  expect(screen.queryByRole("main", { name: "Session replay" })).toBeNull();

  cleanup();
  window.history.replaceState(null, "", `/?replay=${live.card.id}`);
  render(<App fetchImpl={f.fetchImpl} />);
  await screen.findByRole("button", { name: "Jump to live" });
  expect(screen.queryByRole("button", { name: "Back to Watch" })).toBeNull();
});
