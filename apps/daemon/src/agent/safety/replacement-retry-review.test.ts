import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { expect, it } from "vitest";
import { ReplacementOwner } from "./replacement.ts";
import { ReplacementStore } from "./replacement-store.ts";

it("actual replacement owner keeps blocked replay inert and admits one new explicit request after recovery", async () => {
  const home = mkdtempSync(join(tmpdir(), "ld-task6-retry-review-"));
  try {
    const store = new ReplacementStore(home),
      cellId = ulid(),
      requestId = ulid();
    let retires = 0,
      creates = 0;
    const owner = new ReplacementOwner({
      store,
      forCell: () => ({
        current: () => ({ cellId, revision: 4, fenced: true, taskEnded: true }),
        save: async () => {},
        retireOld: async () => {
          retires++;
          return { absent: retires > 1, revoked: true, streamClosed: true };
        },
        allocateId: ulid,
        createFresh: async () => {
          creates++;
        },
        retireFresh: async () => {},
        inspectFresh: async () => "absent" as const,
      }),
    });
    const blocked = await owner.replace(cellId, { requestId, oldRevision: 4, home: "fresh" });
    expect(blocked).toMatchObject({ phase: "blocked", reason: "old_retirement" });
    expect(await owner.status(cellId, requestId)).toEqual(blocked);
    expect(await owner.replace(cellId, { requestId, oldRevision: 4, home: "fresh" })).toEqual(
      blocked,
    );
    expect({ retires, creates }).toEqual({ retires: 1, creates: 0 });
    const ready = await owner.replace(cellId, { requestId: ulid(), oldRevision: 4, home: "fresh" });
    expect(ready.phase).toBe("ready");
    expect(ready.requestId).not.toBe(requestId);
    expect({ retires, creates }).toEqual({ retires: 2, creates: 1 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
