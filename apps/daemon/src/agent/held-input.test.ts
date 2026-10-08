import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "./session.ts";

function fixture() {
  const append = vi.fn();
  const session = new AgentSession(ulid(), ulid(), "Draw a dog", { append });
  const generation = session.beginBrain();
  session.status = "running";
  const releasing = Promise.withResolvers<void>();
  const release = vi.fn(() => releasing.promise);
  const forget = session.holdInput(release);
  const types = () => append.mock.calls.map(([, event]) => (event as { type: string }).type);
  return { session, generation, release, releasing, forget, types };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("a mouse button the agent leaves down between actions", () => {
  it("is let go of before a takeover hands the user the screen", async () => {
    const f = fixture();
    const taking = f.session.takeover("other", "Draw the ears yourself");
    await turn();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.session.manualControl).toBe("waiting");
    expect(f.types()).not.toContain("takeover.request");
    f.releasing.resolve();
    await vi.waitFor(() => expect(f.session.manualControl).toBe("ready"));
    expect(f.types()).toContain("takeover.request");
    f.session.stop();
    await taking.catch(() => {});
  });

  it("is let go of when the task stops, and settlement waits for it", async () => {
    const f = fixture();
    f.session.stop();
    expect(f.release).toHaveBeenCalledOnce();
    let settled = false;
    const settling = f.session.toolsSettled().then(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    f.releasing.resolve();
    await settling;
  });

  it("is let go of when the task is paused", () => {
    const f = fixture();
    f.session.requestSafetyPause(ulid());
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("is let go of when its brain is replaced, before a new one starts work", async () => {
    const f = fixture();
    f.session.retireBrain(f.generation);
    expect(f.release).toHaveBeenCalledOnce();
    let waited = false;
    const waiting = f.session.waitForTools().then(() => {
      waited = true;
    });
    await turn();
    expect(waited).toBe(false);
    f.releasing.resolve();
    await waiting;
  });

  it("is let go of at once when it went down as the task stopped or paused", () => {
    const stopped = fixture();
    stopped.session.stop();
    const late = vi.fn(async () => {});
    stopped.session.holdInput(late);
    expect(late).toHaveBeenCalledOnce();
    const paused = fixture();
    paused.session.requestSafetyPause(ulid());
    const pausedLate = vi.fn(async () => {});
    paused.session.holdInput(pausedLate);
    expect(pausedLate).toHaveBeenCalledOnce();
  });

  it("is let go of once only, and not at all after it came up on its own", () => {
    const f = fixture();
    f.session.requestSafetyPause(ulid());
    f.session.stop();
    expect(f.release).toHaveBeenCalledOnce();
    const g = fixture();
    g.forget();
    g.session.stop();
    expect(g.release).not.toHaveBeenCalled();
  });
});
