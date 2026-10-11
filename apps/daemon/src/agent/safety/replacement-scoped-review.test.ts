import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CellStore } from "../../cells/store.ts";
import { ComputerSystemState } from "../../cells/system-state.ts";
import { toolHarness } from "../testing/harness.ts";
import { ReplacementOwner } from "./replacement.ts";
import { ReplacementStore } from "./replacement-store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const source = readFileSync(new URL("./replacement.docker.test.ts", import.meta.url), "utf8");
const begin = "    } finally {\n      for (const close of [",
  end = "\n    }\n    if (errors.length)";
const start = source.indexOf(begin),
  finish = source.indexOf(end, start);
if (start < 0 || finish < 0 || source.indexOf(begin, start + 1) >= 0)
  throw new Error("unique finalizer required");
const body = source.slice(start + "    } finally {".length, finish);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;
const retire = new AsyncFunction(
  "cells",
  "h",
  "live",
  "runner",
  "tools",
  "ownedIds",
  "store",
  "keyd",
  "keydHome",
  "errors",
  "rmSync",
  "ComputerSystemState",
  "docker",
  "desktopImage",
  body,
);

describe("scoped replacement corrections", () => {
  it("uncertain first write retains the request reservation without blocking another request", async () => {
    const home = mkdtempSync(join(tmpdir(), "ld-scoped-reservation-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const store = new ReplacementStore(home),
      a = ulid(),
      b = ulid(),
      requestId = ulid();
    let creates = 0,
      writes = 0;
    const owner = new ReplacementOwner({
      store: {
        read: (id) => store.read(id),
        list: () => store.list(),
        write: (record) => {
          writes++;
          if (writes === 1) throw new Error("owned write uncertainty");
          store.write(record);
        },
      },
      forCell: (cellId) => ({
        current: () => ({ cellId, revision: 1, fenced: true, taskEnded: true }),
        save: async () => {},
        retireOld: async () => ({ absent: true, revoked: true, streamClosed: true }),
        allocateId: ulid,
        createFresh: async () => {
          creates++;
        },
        retireFresh: async () => {},
        inspectFresh: async () => "absent" as const,
      }),
    });
    await expect(owner.replace(a, { requestId, oldRevision: 1, home: "fresh" })).rejects.toThrow(
      "could not be confirmed",
    );
    expect(store.read(requestId)).toBeUndefined();
    await expect(owner.replace(b, { requestId, oldRevision: 1, home: "fresh" })).rejects.toThrow(
      "owner mismatch",
    );
    expect({ creates, writes }).toEqual({ creates: 0, writes: 1 });
    await expect(
      owner.replace(b, { requestId: ulid(), oldRevision: 1, home: "fresh" }),
    ).resolves.toMatchObject({ phase: "ready" });
    expect(creates).toBe(1);
  });
  it.each([false, true])(
    "inventory failure=%s still attempts every known owner and retains evidence on uncertainty",
    async (failInventory) => {
      const h = toolHarness(),
        store = new CellStore(h.home),
        keydHome = mkdtempSync(join(tmpdir(), "ld-scoped-finalizer-"));
      cleanup.push(() => {
        h.close();
        rmSync(keydHome, { recursive: true, force: true });
      });
      if (failInventory) {
        renameSync(join(h.home, "cells"), join(h.home, "cells-retained"));
        writeFileSync(join(h.home, "cells"), "owned inert ENOTDIR fixture");
      }
      const attempted: string[] = [],
        errors: unknown[] = [];
      const closeResources = h.closeResources;
      h.closeResources = () => {
        attempted.push("resources");
        closeResources();
      };
      let escaped: unknown;
      try {
        await retire(
          {
            dispose: () => {
              attempted.push("dispose");
            },
            retireReplacement: async () => {
              attempted.push("retire");
              return { absent: true, revoked: true };
            },
          },
          h,
          {
            stop: () => {
              attempted.push("live");
            },
          },
          {
            close: async () => {
              attempted.push("runner");
            },
          },
          {
            close: async () => {
              attempted.push("tools");
            },
          },
          new Set([h.session.cellId]),
          store,
          {
            stop: async () => {
              attempted.push("keyd");
            },
          },
          keydHome,
          errors,
          rmSync,
          ComputerSystemState,
          {},
          "inert-image",
        );
      } catch (error) {
        escaped = error;
      }
      expect(attempted).toEqual([
        "dispose",
        "live",
        "runner",
        "tools",
        "retire",
        "keyd",
        "resources",
      ]);
      expect(escaped).toBeUndefined();
      expect(errors.length).toBe(failInventory ? 1 : 0);
      expect({ home: existsSync(h.home), keyd: existsSync(keydHome) }).toEqual({
        home: failInventory,
        keyd: failInventory,
      });
    },
  );
});
