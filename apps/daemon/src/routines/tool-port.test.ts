import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineStore } from "./store.ts";
import { routineToolPort, whenFromTool } from "./tool-port.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});
const NOW = Date.parse("2026-10-12T09:00:00Z");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ld-tool-port-"));
  const store = new RoutineStore(home, { now: () => NOW, zone: () => "Europe/London" });
  cleanup.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const changed = vi.fn();
  return {
    store,
    changed,
    port: routineToolPort({ store, now: () => NOW, zone: () => "Europe/London", changed }),
  };
}

describe("tool port", () => {
  it.each([
    [{ kind: "weekdays", time: "08:30" }, { when: { kind: "weekdays", time: "08:30" } }],
    [
      { kind: "weekly", days: ["mon", "thu"], time: "09:00" },
      { when: { kind: "weekly", days: [1, 4], time: "09:00" } },
    ],
    [
      { kind: "hours", every: 4, time: "09:00" },
      { when: { kind: "hours", every: 4, from: "09:00" } },
    ],
    [
      { kind: "daily", time: "08:30", until: "2026-12-31" },
      { when: { kind: "daily", time: "08:30" }, until: "2026-12-31" },
    ],
  ])("maps %j", (input, expected) => {
    expect(whenFromTool(input as never)).toEqual(expected);
  });
  it.each([
    [{ kind: "daily" }],
    [{ kind: "weekly", time: "09:00" }],
    [{ kind: "hours", every: 5 }],
    [{ kind: "once", time: "09:00" }],
  ])("explains a schedule it cannot use: %j", (input) => {
    expect(() => whenFromTool(input as never)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("propose stores an inactive proposal tied to the session", () => {
    const f = fixture();
    const session = ulid();
    const proposal = f.port.propose(session, {
      name: "Bills",
      instruction: "Check bills",
      when: { kind: "daily", time: "08:30" },
    });
    expect(f.store.get(proposal.routineId)).toMatchObject({
      state: "proposed",
      createdFromSession: session,
    });
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
  it("follow-ups must be between one minute and seven days ahead", () => {
    const f = fixture();
    const session = ulid();
    expect(() => f.port.followUp(session, "2026-10-12T10:00", "too soon")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => f.port.followUp(session, "2026-10-20T10:00", "too late")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    const ok = f.port.followUp(session, "2026-10-12T15:00", "Check the parcel");
    expect(f.store.get(ok.routineId)).toMatchObject({
      kind: "follow_up",
      state: "active",
      followUp: { sessionId: session, note: "Check the parcel" },
      when: { kind: "once", date: "2026-10-12", time: "15:00" },
    });
  });
  it("answers an impossible date or a two-line name in plain words", () => {
    const f = fixture();
    const session = ulid();
    const plain = (message: string) =>
      expect.objectContaining({ name: "RoutineError", status: 400, message });
    expect(() =>
      f.port.propose(session, {
        name: "Bills",
        instruction: "Check bills",
        when: { kind: "daily", time: "08:30", until: "2026-02-30" },
      }),
    ).toThrow(plain("The end date isn't a real date."));
    expect(() =>
      f.port.propose(session, {
        name: "Bills\nand more",
        instruction: "Check bills",
        when: { kind: "daily", time: "08:30" },
      }),
    ).toThrow(plain("A routine's name is one line of up to 80 characters."));
    expect(() => f.port.followUp(session, "2026-10-32T10:00", "x")).toThrow(
      plain("That date isn't a real date."),
    );
  });
  it("names the routine it would pause", () => {
    const f = fixture();
    const routine = f.store.create(
      { name: "Morning bills", instruction: "a", when: { kind: "daily", time: "08:30" } },
      { state: "active" },
    );
    expect(f.port.name(routine.id)).toBe("Morning bills");
    expect(f.port.name(ulid())).toBeUndefined();
  });
  it("pause only pauses an active routine", () => {
    const f = fixture();
    const active = f.store.create(
      { name: "A", instruction: "a", when: { kind: "daily", time: "08:30" } },
      { state: "active" },
    );
    const proposed = f.store.create(
      { name: "P", instruction: "p", when: { kind: "daily", time: "08:30" } },
      { state: "proposed" },
    );
    expect(f.port.pause(proposed.id)).toBe(false);
    expect(f.port.pause(active.id)).toBe(true);
    expect(f.store.get(active.id)).toMatchObject({ state: "paused", pausedReason: "user" });
  });
});
