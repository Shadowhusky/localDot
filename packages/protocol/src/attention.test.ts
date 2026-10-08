import { describe, expect, it } from "vitest";
import {
  ATTENTION_ORDER,
  Attention,
  type AttentionLevel,
  compareAttention,
  mostUrgent,
  topAttention,
} from "./attention.ts";

describe("the shared attention order", () => {
  it("ranks needs you over blocked or failed, over done, over working", () => {
    expect(ATTENTION_ORDER).toEqual(["needs_you", "blocked", "done", "working"]);
    for (let i = 0; i < ATTENTION_ORDER.length; i++)
      for (let j = i; j < ATTENTION_ORDER.length; j++) {
        const urgent = ATTENTION_ORDER[i] as Attention;
        const other = ATTENTION_ORDER[j] as Attention;
        expect(mostUrgent([other, urgent])).toBe(urgent);
        expect(mostUrgent([urgent, other])).toBe(urgent);
      }
  });

  it("is null when nothing asks for the user, and skips tasks that ask nothing", () => {
    expect(mostUrgent([])).toBeNull();
    expect(mostUrgent([null, null])).toBeNull();
    expect(mostUrgent([null, "working", null, "done"])).toBe("done");
    expect(mostUrgent(new Set<Attention | null>(["working", "needs_you"]))).toBe("needs_you");
  });

  it("parses only the four levels", () => {
    for (const level of ATTENTION_ORDER) expect(Attention.parse(level)).toBe(level);
    for (const value of ["Needs_you", "failed", "unread", "", null, 0])
      expect(Attention.safeParse(value).success).toBe(false);
  });
});

describe("the notification attention levels", () => {
  it("ranks needs you > blocked or failed > done > working > none", () => {
    const levels: AttentionLevel[] = ["working", "done", "none", "failed", "needs_you", "blocked"];
    expect([...levels].sort(compareAttention)).toEqual([
      "needs_you",
      "failed",
      "blocked",
      "done",
      "working",
      "none",
    ]);
  });

  it("picks the top level and treats blocked and failed as equals", () => {
    expect(topAttention([])).toBe("none");
    expect(topAttention(["done", "working"])).toBe("done");
    expect(topAttention(["failed", "blocked"])).toBe("failed");
    expect(topAttention(["blocked", "needs_you", "done"])).toBe("needs_you");
  });
});
