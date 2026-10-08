import { describe, expect, it } from "vitest";
import {
  activateUpdate,
  type ReleaseIdentity,
  recoverUpdate,
  type UpdateJournal,
  type UpdateTransactionHost,
} from "./update-transaction.ts";

const identity = (version: string, hex: string): ReleaseIdentity => ({
  version,
  packageSha256: hex.repeat(64),
  manifestSha256: hex.repeat(64),
});
const old = identity("1.0.0", "a"),
  next = identity("1.1.0", "b");
function fixture(previous: ReleaseIdentity | null = old) {
  let journal: UpdateJournal | null = null,
    current = previous;
  const events: string[] = [];
  const fail = new Set<string>();
  const after = new Map<string, () => void>();
  function event(name: string) {
    events.push(name);
    after.get(name)?.();
    if (fail.delete(name)) throw new Error(`private diagnostic ${name}`);
  }
  const name = (r: ReleaseIdentity | null) => r?.version ?? "none";
  const host: UpdateTransactionHost = {
    async read() {
      event("read");
      return structuredClone(journal);
    },
    async save(j) {
      event(`save:${j.phase}`);
      journal = structuredClone(j);
      event(`persisted:${j.phase}`);
    },
    async current() {
      event("current");
      return current && { ...current };
    },
    async verify(r, signal) {
      signal.throwIfAborted();
      event(`verify:${name(r)}`);
    },
    async quiesce(signal) {
      signal.throwIfAborted();
      event("quiesce");
    },
    async select(r, signal) {
      signal.throwIfAborted();
      event(`select:${name(r)}`);
      current = r;
    },
    async start(r, signal) {
      signal.throwIfAborted();
      event(`start:${name(r)}`);
    },
    async healthy(r, signal) {
      signal.throwIfAborted();
      event(`healthy:${name(r)}`);
    },
  };
  return {
    host,
    events,
    fail,
    after,
    get journal() {
      return journal;
    },
    set journal(j: UpdateJournal | null) {
      journal = j;
    },
    get selected() {
      return current;
    },
    set selected(r: ReleaseIdentity | null) {
      current = r;
    },
  };
}
const signal = () => new AbortController().signal;
function interrupted(
  phase: UpdateJournal["phase"],
  previous: ReleaseIdentity | null = old,
): UpdateJournal {
  return { v: 1, id: "e7d79215-1b76-42dd-aede-d8c3c4ac2cd3", previous, candidate: next, phase };
}

describe("update activation ordering and recovery", () => {
  it("persists intent before every service/pointer change and commits only after exact health", async () => {
    const f = fixture();
    expect((await activateUpdate(f.host, next, signal())).phase).toBe("committed");
    expect(f.selected).toEqual(next);
    expect(f.events).toEqual([
      "read",
      "current",
      "verify:1.1.0",
      "verify:1.0.0",
      "save:prepared",
      "persisted:prepared",
      "save:quiescing",
      "persisted:quiescing",
      "quiesce",
      "save:activating",
      "persisted:activating",
      "select:1.1.0",
      "save:validating",
      "persisted:validating",
      "start:1.1.0",
      "healthy:1.1.0",
      "current",
      "save:committed",
      "persisted:committed",
    ]);
  });
  it.each(["verify:1.1.0", "verify:1.0.0", "save:prepared", "persisted:prepared"])(
    "does not touch services when pre-activation %s fails",
    async (step) => {
      const f = fixture();
      f.fail.add(step);
      await expect(activateUpdate(f.host, next, signal())).rejects.toThrow();
      expect(f.selected).toEqual(old);
      expect(f.events).not.toContain("quiesce");
      expect(f.events).not.toContain("start:1.1.0");
      if (step === "persisted:prepared")
        expect((await recoverUpdate(f.host))?.phase).toBe("rolled-back");
    },
  );
  it.each([
    "save:quiescing",
    "persisted:quiescing",
    "quiesce",
    "save:activating",
    "persisted:activating",
    "select:1.1.0",
    "save:validating",
    "persisted:validating",
    "start:1.1.0",
    "healthy:1.1.0",
    "save:committed",
  ])("restores the old release after failure at %s", async (step) => {
    const f = fixture();
    f.fail.add(step);
    await expect(activateUpdate(f.host, next, signal())).rejects.toThrow(
      "previous installation was restored",
    );
    expect(f.selected).toEqual(old);
    expect(f.journal?.phase).toBe("rolled-back");
    const recovery = f.events.slice(f.events.indexOf("save:rolling-back"));
    expect(recovery).toEqual([
      "save:rolling-back",
      "persisted:rolling-back",
      "quiesce",
      "verify:1.0.0",
      "select:1.0.0",
      "start:1.0.0",
      "healthy:1.0.0",
      "current",
      "save:rolled-back",
      "persisted:rolled-back",
    ]);
  });
  it("recognizes a durable commit when the save acknowledgment was lost", async () => {
    const f = fixture();
    f.fail.add("persisted:committed");
    expect((await activateUpdate(f.host, next, signal())).phase).toBe("committed");
    expect(f.events).not.toContain("save:rolling-back");
    expect(f.selected).toEqual(next);
  });
  it.each(["prepared", "quiescing", "activating", "validating", "rolling-back"] as const)(
    "recovers an interrupted %s transaction without starting the candidate",
    async (phase) => {
      const f = fixture();
      f.journal = interrupted(phase);
      f.selected = next;
      expect((await recoverUpdate(f.host))?.phase).toBe("rolled-back");
      expect(f.selected).toEqual(old);
      expect(f.events).not.toContain("start:1.1.0");
      expect(f.events.indexOf("quiesce")).toBeLessThan(f.events.indexOf("select:1.0.0"));
    },
  );
  it("rolls back a first install by stopping services and removing only the selected pointer", async () => {
    const f = fixture(null);
    f.fail.add("healthy:1.1.0");
    await expect(activateUpdate(f.host, next, signal())).rejects.toThrow();
    expect(f.selected).toBeNull();
    expect(f.journal?.phase).toBe("rolled-back");
    expect(f.events).toContain("select:none");
    expect(f.events).not.toContain("start:none");
  });
  it("uses a separate recovery cancellation scope after the caller aborts", async () => {
    const f = fixture(),
      controller = new AbortController();
    f.after.set("start:1.1.0", () => controller.abort());
    await expect(activateUpdate(f.host, next, controller.signal)).rejects.toThrow("restored");
    expect(f.journal?.phase).toBe("rolled-back");
    expect(f.events).toContain("healthy:1.0.0");
  });
  it.each([
    "save:rolling-back",
    "quiesce",
    "verify:1.0.0",
    "select:1.0.0",
    "start:1.0.0",
    "healthy:1.0.0",
    "save:rolled-back",
  ])("retains a nonterminal recovery record if %s fails", async (step) => {
    const f = fixture();
    f.journal = interrupted("validating");
    f.selected = next;
    f.fail.add(step);
    await expect(recoverUpdate(f.host)).rejects.toThrow();
    expect(["committed", "rolled-back"]).not.toContain(f.journal?.phase);
    await expect(activateUpdate(f.host, next, signal())).rejects.toThrow("Recovery is required");
    expect((await recoverUpdate(f.host))?.phase).toBe("rolled-back");
  });
  it("refuses corrupt or foreign journals without changing services", async () => {
    const f = fixture();
    f.host.read = async () => ({ ...interrupted("prepared"), executable: "/arbitrary" });
    await expect(recoverUpdate(f.host)).rejects.toThrow();
    await expect(activateUpdate(f.host, next, signal())).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it("refuses terminal journals whose pointer no longer matches", async () => {
    const f = fixture();
    f.journal = interrupted("committed");
    await expect(recoverUpdate(f.host)).rejects.toThrow("Recovery is required");
    await expect(activateUpdate(f.host, next, signal())).rejects.toThrow("Recovery is required");
    expect(f.events).not.toContain("quiesce");
  });
  it("does not guess after losing access to the journal following activation", async () => {
    const f = fixture();
    f.after.set("healthy:1.1.0", () => {
      f.host.read = async () => {
        throw new Error("disk unavailable");
      };
    });
    f.fail.add("healthy:1.1.0");
    await expect(activateUpdate(f.host, next, signal())).rejects.toThrow();
    expect(f.journal?.phase).toBe("validating");
    expect(f.events).not.toContain("select:1.0.0");
  });
  it("rejects an unchanged release and pre-cancellation without service effects", async () => {
    const f = fixture();
    await expect(activateUpdate(f.host, old, signal())).rejects.toThrow("already selected");
    const controller = new AbortController();
    controller.abort();
    await expect(activateUpdate(f.host, next, controller.signal)).rejects.toThrow();
    expect(f.events).not.toContain("quiesce");
  });
});
