import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ReplacementOwner } from "./replacement.ts";
import { ReplacementStore } from "./replacement-store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("review durable replacement request identity", () => {
  it.each(["same", "different"] as const)(
    "concurrent cells with %s request IDs retain one durable owner per ID",
    async (mode) => {
      const home = mkdtempSync(join(tmpdir(), "ld-request-review-"));
      homes.push(home);
      const store = new ReplacementStore(home),
        ids = [ulid(), ulid()];
      const request = ulid(),
        effects: string[] = [],
        published: string[] = [];
      const owner = new ReplacementOwner({
        store,
        onReady: (record) => {
          published.push(record.oldCellId);
        },
        forCell: (id) => ({
          current: () => ({ cellId: id, revision: 1, fenced: true, taskEnded: true }),
          save: async () => {},
          retireOld: async () => ({ absent: true, revoked: true, streamClosed: true }),
          allocateId: ulid,
          createFresh: async (fresh) => {
            effects.push(fresh);
          },
          retireFresh: async () => {},
          inspectFresh: async () => "absent" as const,
        }),
      });
      const outcomes = await Promise.allSettled(
        ids.map((id, i) =>
          owner.replace(id, {
            requestId: mode === "same" || i === 0 ? request : ulid(),
            oldRevision: 1,
            home: "fresh",
          }),
        ),
      );
      const count = mode === "same" ? 1 : 2;
      expect({
        effects: effects.length,
        published: published.length,
        fulfilled: outcomes.filter((x) => x.status === "fulfilled").length,
        records: store.list().length,
      }).toEqual({ effects: count, published: count, fulfilled: count, records: count });
      for (const result of outcomes)
        if (result.status === "fulfilled")
          expect(store.read(result.value.requestId)).toEqual(result.value);
    },
  );
});
