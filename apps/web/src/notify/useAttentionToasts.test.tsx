// @vitest-environment jsdom
import type { AttentionItem } from "@localdot/protocol";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToastOptions } from "../ui/toasts.ts";
import { useAttentionToasts } from "./useAttentionToasts.ts";

const A = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const B = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHK";
const item = (
  sessionId: string,
  level: AttentionItem["level"],
  reason: AttentionItem["reason"],
): AttentionItem => ({
  key: `${sessionId}:${reason}`,
  sessionId,
  level,
  reason,
  task: "Pay the electricity bill",
  at: 1,
});

function setup(viewing: string | null, hidden = false, island = true) {
  const shown: ToastOptions[] = [];
  const dismissed: string[] = [];
  const open = vi.fn();
  const host = {
    show: (options: ToastOptions) => shown.push(options),
    dismiss: (id: string) => dismissed.push(id),
    hidden: () => hidden,
  };
  const hook = renderHook(
    ({ latest }: { latest: AttentionItem | null }) =>
      useAttentionToasts(latest, { viewing, island }, open, host),
    { initialProps: { latest: null as AttentionItem | null } },
  );
  return { ...hook, shown, dismissed, open };
}

describe("attention toasts", () => {
  it("tells of another task from the island, and Open goes to it", () => {
    const t = setup(A);
    t.rerender({ latest: item(B, "done", "done") });
    expect(t.shown).toEqual([
      expect.objectContaining({
        id: `attention:${B}`,
        title: "Task done",
        description: "Pay the electricity bill",
        tone: "neutral",
      }),
    ]);
    t.shown[0]?.action?.onAction();
    expect(t.open).toHaveBeenCalledWith(B);
  });

  it("stays quiet for the task on screen, in a hidden tab and without the island, and withdraws what moved on", () => {
    const here = setup(A);
    here.rerender({ latest: item(A, "needs_you", "approval") });
    expect(here.shown).toEqual([]);
    const away = setup(A, true);
    away.rerender({ latest: item(B, "failed", "error") });
    expect(away.shown).toEqual([]);
    const replaying = setup(null, false, false);
    replaying.rerender({ latest: item(B, "done", "done") });
    expect(replaying.shown).toEqual([]);
    const later = setup(A);
    later.rerender({ latest: item(B, "needs_you", "approval") });
    later.rerender({ latest: item(B, "working", "working") });
    expect(later.shown).toHaveLength(1);
    expect(later.dismissed).toEqual([`attention:${B}`]);
  });
});
