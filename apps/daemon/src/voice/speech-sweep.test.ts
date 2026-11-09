import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A folder the sweep is about to unlock becomes a link to elsewhere, at the worst moment: just after
// the sweep has looked at it.
const swap: { at?: string; to?: string } = {};
vi.mock("node:fs/promises", async (load) => {
  const real = await load<typeof import("node:fs/promises")>();
  const after =
    <T extends (...args: never[]) => Promise<unknown>>(call: T) =>
    async (...args: Parameters<T>) => {
      const result = await call(...args);
      const [path] = args as unknown as [string];
      if (swap.at && path === swap.at && swap.to) {
        renameSync(path, `${path}.moved`);
        symlinkSync(swap.to, path);
        swap.at = undefined;
      }
      return result;
    };
  return {
    ...real,
    lstat: after(real.lstat as never),
    open: after(real.open as never),
    realpath: after(real.realpath as never),
  };
});
const { sweepVoiceAudio } = await import("./speech.ts");

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ld-voice-sweep-"));
});
afterEach(() => {
  chmodSync(join(base, "outside"), 0o700);
  rmSync(base, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

it("never changes a folder elsewhere when a leftover is swapped for a link mid-sweep", async () => {
  const home = join(base, "home");
  mkdirSync(home, { mode: 0o700 });
  const outside = join(base, "outside");
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(outside, "keep.txt"), "mine");
  for (const step of ["lstat", "open", "realpath"]) {
    chmodSync(outside, 0o755);
    chmodSync(join(outside, "sub"), 0o755);
    const leftover = join(home, "voice-audio.stale-aaaaaaaa");
    mkdirSync(join(leftover, "inner"), { recursive: true });
    swap.at = leftover;
    swap.to = outside;
    await sweepVoiceAudio(join(home, "voice-audio"));
    expect(mode(outside), step).toBe(0o755);
    expect(mode(join(outside, "sub")), step).toBe(0o755);
    expect(statSync(join(outside, "keep.txt")).isFile()).toBe(true);
    rmSync(join(home, "voice-audio.stale-aaaaaaaa.moved"), { recursive: true, force: true });
    rmSync(leftover, { force: true });
  }
});
