import { describe, expect, it } from "vitest";
import { ATTENTION_ORDER, Attention, mostUrgent } from "./attention.ts";

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
