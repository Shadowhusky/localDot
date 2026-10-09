import { describe, expect, it, vi } from "vitest";
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
  const live = new Map<string, string>();
  const port = agentRunnerPort(
    { start: vi.fn(), end: vi.fn(() => true), get: (id: string) => sessions.get(id) as never },
    { get: (cell: string) => live.get(cell), settled: async () => {} },
    { listSessions: () => [{ id: "S1", title: "Find flights", startedAt: "", events: 1 }] },
  );
  return { sessions, live, port };
}

describe("agent runner port", () => {
  it("treats only an idle, uncontrolled live session as free", () => {
    const f = fixture();
    expect(f.port.busy("C")).toBe(false);
    f.live.set("C", "S1");
    f.sessions.set("S1", { status: "running", controlHeld: false, stopped: false, post: vi.fn() });
    expect(f.port.busy("C")).toBe(true);
    f.sessions.set("S1", { status: "idle", controlHeld: true, stopped: false, post: vi.fn() });
    expect(f.port.busy("C")).toBe(true);
    f.sessions.set("S1", { status: "idle", controlHeld: false, stopped: false, post: vi.fn() });
    expect(f.port.busy("C")).toBe(false);
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
