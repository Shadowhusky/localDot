import { APPROVAL_TIMEOUT_MS, ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { type ActionBinding, ApprovalBroker, CountedPermit, OncePermit } from "./approvals.ts";

function fixture() {
  let now = 1000,
    current = true;
  const controller = new AbortController();
  const request = vi.fn(),
    resolution = vi.fn(),
    revalidate = vi.fn(async () => true);
  const sessionId = ulid();
  const binding: ActionBinding = {
    sessionId,
    cellId: ulid(),
    generation: 1,
    callId: ulid(),
    digest: "exact-input",
    targetDigest: "exact-native-target",
  };
  const broker = new ApprovalBroker(() => now, request, resolution);
  const start = () =>
    broker.request(
      binding,
      {
        actionClass: "send",
        risk: "high",
        title: "Send",
        fields: [["Target", "Synthetic recipient"]],
      },
      {
        signal: controller.signal,
        check: () => {
          if (!current) throw new Error("stale owner");
        },
        revalidate,
      },
    );
  const answer = (decision: "approve" | "deny" | "take_control" = "approve") => {
    const card = broker.pending(sessionId);
    if (!card) throw new Error("missing card");
    return {
      approvalId: card.approvalId,
      generation: card.generation,
      revision: card.revision,
      decision,
    };
  };
  return {
    broker,
    binding,
    sessionId,
    request,
    resolution,
    revalidate,
    controller,
    start,
    answer,
    setNow: (value: number) => {
      now = value;
    },
    retire: () => {
      current = false;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});
it("RF2 exact approval authorizes one immutable binding, with a one-use positive control", async () => {
  const h = fixture(),
    waiting = h.start();
  expect(h.request).toHaveBeenCalledOnce();
  const reply = h.answer();
  expect(h.broker.answer(h.sessionId, reply)).toBe(true);
  expect(await waiting).toBe("approve");
  expect(h.broker.answer(h.sessionId, reply)).toBe(false);
  expect(h.revalidate).toHaveBeenCalledOnce();
  const permit = new OncePermit(h.binding.digest);
  expect(permit.consume("changed")).toBe(false);
  expect(permit.consume(h.binding.digest)).toBe(true);
  expect(permit.consume(h.binding.digest)).toBe(false);
});
it("RF3 overrides, wrong session/generation/revision and foreign cards never consume the waiting card", async () => {
  const h = fixture(),
    waiting = h.start(),
    good = h.answer();
  for (const value of [
    { ...good, input: { command: "other" } },
    { ...good, target: "other" },
    { ...good, expiresAt: 9 },
    { ...good, generation: 2 },
    { ...good, revision: good.revision + 1 },
    { ...good, approvalId: ulid() },
    { ...good, decision: "approve_similar" },
  ])
    expect(h.broker.answer(h.sessionId, value)).toBe(false);
  expect(h.broker.answer(ulid(), good)).toBe(false);
  expect(h.broker.pending(h.sessionId)).toBeDefined();
  h.broker.cancel(h.sessionId);
  expect(await waiting).toBe("stale");
  expect(h.revalidate).not.toHaveBeenCalled();
});
it("exact server expiry refuses an already clicked card and releases the pending waiter", async () => {
  const h = fixture(),
    waiting = h.start(),
    reply = h.answer();
  h.setNow(1000 + APPROVAL_TIMEOUT_MS);
  expect(h.broker.answer(h.sessionId, reply)).toBe(false);
  expect(await waiting).toBe("deny");
  expect(h.broker.pending(h.sessionId)).toBeUndefined();
});
it("waits 24 hours for an answer, as long as the Codex tool timeout", () => {
  expect(APPROVAL_TIMEOUT_MS).toBe(86_400_000);
});
it("a card left unanswered for fifteen minutes still authorizes when approved", async () => {
  vi.useFakeTimers();
  const h = fixture(),
    waiting = h.start();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  h.setNow(1000 + 15 * 60_000);
  expect(h.broker.pending(h.sessionId)).toBeDefined();
  expect(h.broker.answer(h.sessionId, h.answer())).toBe(true);
  expect(await waiting).toBe("approve");
});
it("automatic timeout settles closed without extending the deadline", async () => {
  vi.useFakeTimers();
  const h = fixture(),
    waiting = h.start();
  await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
  expect(await waiting).toBe("deny");
  expect(h.revalidate).not.toHaveBeenCalled();
});
it("a counted permit covers its exact effect that many times and nothing else", () => {
  const permit = new CountedPermit("exact-input", 3);
  expect(permit.consume("changed")).toBe(false);
  expect([1, 2, 3, 4].map(() => permit.consume("exact-input"))).toEqual([true, true, true, false]);
});
it("Deny and Take control consume the card and never revalidate an executable effect", async () => {
  for (const decision of ["deny", "take_control"] as const) {
    const h = fixture(),
      waiting = h.start();
    expect(h.broker.answer(h.sessionId, h.answer(decision))).toBe(true);
    expect(await waiting).toBe(decision);
    expect(h.revalidate).not.toHaveBeenCalled();
  }
});
it("Stop discards authority even when completion publication fails", async () => {
  const h = fixture(),
    waiting = h.start(),
    reply = h.answer();
  h.resolution.mockImplementation(() => {
    throw new Error("journal full");
  });
  h.controller.abort();
  expect(h.broker.pending(h.sessionId)).toBeUndefined();
  expect(h.broker.answer(h.sessionId, reply)).toBe(false);
  expect(await waiting).toBe("stale");
});
it("request journal failure refuses an effect and clears pending authority", async () => {
  const h = fixture();
  h.request.mockImplementation(() => {
    throw new Error("journal full");
  });
  expect(await h.start()).toBe("stale");
  expect(h.broker.pending(h.sessionId)).toBeUndefined();
  expect(h.revalidate).not.toHaveBeenCalled();
});
it("changed native target after approval cannot dispatch", async () => {
  const h = fixture();
  h.revalidate.mockResolvedValue(false);
  const waiting = h.start();
  h.broker.answer(h.sessionId, h.answer());
  let effects = 0;
  if ((await waiting) === "approve") effects++;
  expect(effects).toBe(0);
});
it("Stop or owner retirement racing target revalidation cannot dispatch", async () => {
  for (const reason of ["abort", "owner"] as const) {
    const h = fixture();
    let finish!: (value: boolean) => void;
    h.revalidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const waiting = h.start();
    h.broker.answer(h.sessionId, h.answer());
    await Promise.resolve();
    if (reason === "abort") h.controller.abort(new Error("stopped"));
    else h.retire();
    finish(true);
    await expect(waiting).rejects.toThrow(reason === "abort" ? "stopped" : "stale owner");
  }
});
it("published or returned card mutations cannot change the daemon authority", async () => {
  const h = fixture();
  h.request.mockImplementation((card) => {
    card.approvalId = ulid();
    card.fields[0][1] = "changed";
  });
  const waiting = h.start(),
    good = h.answer();
  const copy = h.broker.pending(h.sessionId);
  if (!copy) throw new Error("no card");
  copy.approvalId = ulid();
  copy.expiresAt = Number.MAX_SAFE_INTEGER;
  expect(h.broker.answer(h.sessionId, { ...good, approvalId: copy.approvalId })).toBe(false);
  h.broker.answer(h.sessionId, good);
  expect(await waiting).toBe("approve");
});
it("a second concurrent request is refused and cannot replace the first owner", async () => {
  const h = fixture(),
    first = h.start(),
    reply = h.answer();
  await expect(h.start()).rejects.toThrow("approval already pending");
  h.broker.answer(h.sessionId, reply);
  expect(await first).toBe("approve");
});

const windowDraft = {
  actionClass: "send" as const,
  risk: "high" as const,
  title: "Send",
  fields: [["Target", "Synthetic recipient"]] as [string, string][],
};
const askOnce = (broker: ApprovalBroker) =>
  broker.request(
    {
      sessionId: ulid(),
      cellId: ulid(),
      generation: 1,
      callId: ulid(),
      digest: "exact-input",
      targetDigest: "exact-native-target",
    },
    windowDraft,
    { signal: new AbortController().signal, check: () => {}, revalidate: async () => true },
  );

it("keeps the default window when none is given", () => {
  const published = vi.fn();
  void askOnce(new ApprovalBroker(() => 1_000, published)).catch(() => {});
  expect(published.mock.calls[0]?.[0].expiresAt).toBe(1_000 + APPROVAL_TIMEOUT_MS);
});

it("uses a session's own window and refuses when it runs out", async () => {
  vi.useFakeTimers();
  try {
    const published = vi.fn(),
      resolved = vi.fn();
    const outcome = askOnce(new ApprovalBroker(() => 1_000, published, resolved, 3_600_000));
    expect(published.mock.calls[0]?.[0].expiresAt).toBe(1_000 + 3_600_000);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("deny");
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny", by: "timeout" }),
    );
  } finally {
    vi.useRealTimers();
  }
});
