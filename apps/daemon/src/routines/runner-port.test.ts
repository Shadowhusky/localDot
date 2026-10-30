import { describe, expect, it, vi } from "vitest";
import { LiveSessions } from "../gateway/live.ts";
import { agentRunnerPort } from "./runner-port.ts";

interface FakeSession {
  status: string;
  controlHeld: boolean;
  stopped: boolean;
  pendingAsk?: string;
  pendingTakeover?: string;
  pendingApproval?: object;
  post: ReturnType<typeof vi.fn>;
}
function fixture() {
  const sessions = new Map<string, FakeSession>();
  const live = new LiveSessions();
  const port = agentRunnerPort(
    { start: vi.fn(), end: vi.fn(() => true), get: (id: string) => sessions.get(id) as never },
    live,
    { listSessions: () => [{ id: "S1", title: "Find flights", startedAt: "", events: 1 }] },
  );
  return { sessions, live, port };
}

describe("agent runner port", () => {
  it("shares the computer with tasks at work, and waits only while the user holds it", async () => {
    const f = fixture();
    expect(f.port.busy("C")).toBe(false);
    f.live.start(
      "C",
      "S1",
      (signal) => new Promise((done) => signal.addEventListener("abort", done)),
    );
    expect(f.port.live("C")).toEqual(["S1"]);
    expect(f.port.busy("C")).toBe(false);
    const user = await f.live.lease("C").acquire("S1", { user: true });
    expect(f.port.busy("C")).toBe(true);
    user.release();
    expect(f.port.busy("C")).toBe(false);
    f.live.stop("S1");
    await f.live.settled("S1");
  });
  it("posts a follow-up only into an idle session", () => {
    const f = fixture();
    const post = vi.fn();
    f.sessions.set("S1", { status: "running", controlHeld: false, stopped: false, post });
    expect(f.port.post("S1", "note")).toBe(false);
    f.sessions.set("S1", { status: "idle", controlHeld: false, stopped: false, post });
    expect(f.port.post("S1", "note")).toBe(true);
    expect(post).toHaveBeenCalledWith("followup", "note");
  });
  it("reports a parked session and a task title", () => {
    const f = fixture();
    f.sessions.set("S1", {
      status: "waiting_user",
      controlHeld: false,
      stopped: false,
      pendingAsk: "A",
      post: vi.fn(),
    });
    expect(f.port.parked("S1")).toBe(true);
    expect(f.port.title("S1")).toBe("Find flights");
  });
});
