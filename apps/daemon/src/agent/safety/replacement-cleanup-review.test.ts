import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toolHarness } from "../testing/harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
// Execute only the unchanged outer finalizer, with inert resource owners and actual private files.
// This does not import/enable the Docker suite, call Docker, bind a socket or start a keyd process.
const source = readFileSync(new URL("./replacement.docker.test.ts", import.meta.url), "utf8");
const begin = "    } finally {\n      for (const close of [";
const end = "\n    }\n    if (errors.length)";
const start = source.indexOf(begin);
if (start < 0 || source.indexOf(begin, start + 1) >= 0)
  throw new Error("unique finalizer start required");
const finish = source.indexOf(end, start);
if (finish < 0) throw new Error("finalizer end required");
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
  body,
);

describe("review acceptance owned-evidence retirement", () => {
  it.each([
    "confirmed",
    "retirement rejected",
    "keyd stop rejected",
    "dispose rejected",
    "runner rejected",
    "tools rejected",
  ] as const)("%s only removes homes after confirmed cleanup", async (mode) => {
    const h = toolHarness(),
      keydHome = mkdtempSync(join(tmpdir(), "ld-review-retire-"));
    let closed = false;
    const close = h.close;
    h.close = () => {
      close();
      closed = true;
    };
    cleanups.push(() => {
      if (!closed) h.close();
      rmSync(keydHome, { recursive: true, force: true });
    });
    const attempted: string[] = [],
      errors: unknown[] = [];
    const cells = {
      dispose: () => {
        attempted.push("dispose");
        if (mode === "dispose rejected") throw new Error("owned disposal unconfirmed");
      },
      retireReplacement: async () => {
        attempted.push("retire");
        if (mode === "retirement rejected") throw new Error("owned retirement unconfirmed");
        return { absent: true, revoked: true };
      },
    };
    await retire(
      cells,
      h,
      {
        stop: () => {
          attempted.push("live");
        },
      },
      {
        close: async () => {
          attempted.push("runner");
          if (mode === "runner rejected") throw new Error("owned runner unconfirmed");
        },
      },
      {
        close: async () => {
          attempted.push("tools");
          if (mode === "tools rejected") throw new Error("owned tools unconfirmed");
        },
      },
      new Set([h.session.cellId]),
      { list: () => [] },
      {
        stop: async () => {
          attempted.push("keyd");
          if (mode === "keyd stop rejected") throw new Error("owned stop unconfirmed");
        },
      },
      keydHome,
      errors,
      rmSync,
    );
    expect(attempted).toEqual(["dispose", "live", "runner", "tools", "retire", "keyd"]);
    expect(errors.length).toBe(mode === "confirmed" ? 0 : 1);
    expect({ home: existsSync(h.home), keyd: existsSync(keydHome) }).toEqual({
      home: mode !== "confirmed",
      keyd: mode !== "confirmed",
    });
  });
  it("failed resource closure stays uncertain on retry and retains its home", () => {
    const h = toolHarness(),
      closeLog = h.eventLog.close.bind(h.eventLog);
    h.eventLog.close = () => {
      throw new Error("owned log close unconfirmed");
    };
    try {
      expect(() => h.closeResources()).toThrow("fixture resource cleanup uncertain");
      expect(() => h.closeResources()).toThrow("fixture resource cleanup uncertain");
      expect(() => h.close()).toThrow("fixture resource cleanup uncertain");
      expect(existsSync(h.home)).toBe(true);
    } finally {
      closeLog();
      rmSync(h.home, { recursive: true, force: true });
    }
  });
});
