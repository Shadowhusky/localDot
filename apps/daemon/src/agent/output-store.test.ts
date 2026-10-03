import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputStore } from "./output-store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "localdot-output-test-"));
  homes.push(home);
  const session = ulid();
  const controller = new AbortController();
  const check: () => void = vi.fn();
  return {
    home,
    session,
    controller,
    scope: { signal: controller.signal, check },
    store: new OutputStore(home, 16),
    out: join(home, "sessions", session, "out"),
  };
}
function bytes(...parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(Buffer.from(p));
      c.close();
    },
  });
}
describe("atomic bounded output sink", () => {
  it("streams chunks to private files without reading into one response buffer", async () => {
    const f = fixture();
    const result = await f.store.save(f.session, "out.txt", bytes("first", "second"), f.scope);
    expect(result).toEqual({ path: join(realpathSync(f.out), "out.txt"), bytes: 11 });
    expect(readFileSync(result.path, "utf8")).toBe("firstsecond");
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(f.out).mode & 0o777).toBe(0o700);
    expect(readdirSync(f.out)).toEqual(["out.txt"]);
  });
  it("caps actual streamed bytes and preserves a prior output on overflow", async () => {
    const f = fixture();
    await f.store.save(f.session, "out.txt", bytes("old"), f.scope);
    const cancel = vi.fn();
    let n = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (++n <= 3) c.enqueue(Buffer.alloc(n === 1 ? 16 : 1, 120));
        else c.close();
      },
      cancel,
    });
    await expect(f.store.save(f.session, "out.txt", source, f.scope)).rejects.toThrow(/limit/);
    expect(readFileSync(join(f.out, "out.txt"), "utf8")).toBe("old");
    expect(readdirSync(f.out)).toEqual(["out.txt"]);
    expect(cancel).toHaveBeenCalled();
  });
  it("cleans partial output and preserves the old file when cancellation arrives while waiting", async () => {
    const f = fixture();
    await f.store.save(f.session, "out.txt", bytes("old"), f.scope);
    let first = true;
    let started!: () => void;
    const pulled = new Promise<void>((r) => {
      started = r;
    });
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (first) {
          first = false;
          c.enqueue(Buffer.from("new"));
        } else started();
      },
      cancel,
    });
    const saving = f.store.save(f.session, "out.txt", source, f.scope);
    await pulled;
    f.controller.abort(new Error("generation ended"));
    await expect(saving).rejects.toThrow(/generation/);
    expect(cancel).toHaveBeenCalled();
    expect(readFileSync(join(f.out, "out.txt"), "utf8")).toBe("old");
    expect(readdirSync(f.out)).toEqual(["out.txt"]);
  });
  it("checks control again before committing EOF and never publishes a stale file", async () => {
    const f = fixture();
    let current = true;
    f.scope.check = () => {
      if (!current) throw new Error("stale generation");
    };
    let pulled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!pulled) {
          pulled = true;
          c.enqueue(Buffer.from("abc"));
        } else {
          current = false;
          c.close();
        }
      },
    });
    await expect(f.store.save(f.session, "out.txt", source, f.scope)).rejects.toThrow(/stale/);
    expect(readdirSync(f.out)).toEqual([]);
  });
  it("refuses file and ancestor links plus traversal before opening an output", async () => {
    const f = fixture();
    await f.store.save(f.session, "ok.txt", bytes("ok"), f.scope);
    const outside = join(f.home, "outside");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, join(f.out, "link.txt"));
    await expect(f.store.save(f.session, "link.txt", bytes("new"), f.scope)).rejects.toThrow(
      /regular/,
    );
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    await expect(f.store.save(f.session, "../escape", bytes("x"), f.scope)).rejects.toThrow(/name/);
    rmSync(f.out, { recursive: true });
    symlinkSync(f.home, f.out);
    await expect(f.store.save(f.session, "out.txt", bytes("x"), f.scope)).rejects.toThrow(/link/);
  });
  it("does not mutate storage for an already-aborted call", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.store.save(f.session, "out.txt", bytes("x"), f.scope)).rejects.toThrow();
    expect(readdirSync(f.home)).toEqual([]);
  });
});
