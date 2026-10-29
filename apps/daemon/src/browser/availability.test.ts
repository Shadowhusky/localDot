import { describe, expect, it } from "vitest";
import type { CellSummary } from "../cells/types.ts";
import { type BrowserAdmission, browserBlock } from "./availability.ts";

const A = "01JXYZ0000000000000000000A";

function admission(patch: {
  stopping?: boolean;
  keyd?: ReturnType<BrowserAdmission["keyd"]>;
  recovered?: boolean;
  pending?: BrowserAdmission["recovery"]["pending"];
  cell?: Partial<CellSummary> | null;
  browserPending?: "stopping" | "unconfirmed";
}): BrowserAdmission {
  return {
    shuttingDown: () => patch.stopping ?? false,
    keyd: () => patch.keyd ?? { online: true, audit: { ok: true } },
    recovery: { available: patch.recovered ?? true, pending: patch.pending ?? {} },
    cells: {
      get: () =>
        patch.cell === null ? undefined : ({ id: A, state: "ready", ...patch.cell } as CellSummary),
      browserPending: () => patch.browserPending,
    },
  };
}

describe("why a computer's web browser can't run", () => {
  it("is nothing when the daemon, keyd, the computer and the old browser all allow it", () => {
    expect(browserBlock(admission({}), A)).toBeUndefined();
  });

  it.each([
    ["shutting-down", { stopping: true, keyd: { online: false } }],
    ["key-service-offline", { keyd: { online: false }, cell: { paused: true } }],
    ["key-service-offline", { keyd: { online: true, audit: { ok: false } } }],
    ["computer-paused", { cell: { paused: true }, recovered: false }],
    ["computer-stopped", { cell: { state: "stopped" }, recovered: false }],
    ["computer-stopped", { cell: null }],
    ["computer-stopped", { cell: { replacementPending: true } }],
    ["recovering", { recovered: false, browserPending: "unconfirmed" }],
    ["recovering", { browserPending: "stopping" }],
  ] as const)("names %s first in %j", (reason, patch) => {
    expect(browserBlock(admission(patch), A)?.reason).toBe(reason);
  });

  it("says what clears each, and when localDot tries again", () => {
    expect(browserBlock(admission({ cell: { state: "starting" } }), A)).toEqual({
      reason: "computer-stopped",
      problem: "The computer is starting.",
      clears: "Nothing: the web browser starts once the computer is ready.",
    });
    expect(
      browserBlock(
        admission({
          recovered: false,
          pending: {
            failure: "Docker did not answer",
            retryAt: new Date("2026-10-29T08:00:30.000Z"),
          },
        }),
        A,
      ),
    ).toEqual({
      reason: "recovering",
      problem:
        "localDot couldn't yet confirm that the previous web browser stopped (Docker did not answer).",
      clears: "Nothing: localDot tries again by itself.",
      retryAt: "2026-10-29T08:00:30.000Z",
    });
    expect(browserBlock(admission({ keyd: { online: false } }), A)?.clears).toMatch(
      /The web browser then starts by itself\.$/u,
    );
  });
});
