import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { FrameStore } from "./frames.ts";

describe("FrameStore", () => {
  it("writes frames under the session folder with private modes and finds them again", () => {
    const home = mkdtempSync(join(tmpdir(), "local dot's frames-"));
    const store = new FrameStore(home);
    const session = ulid();
    const frame = ulid();
    const path = store.save(session, frame, Buffer.from("RIFF....WEBP"));
    expect(path).toBe(join(home, "sessions", session, "frames", `${frame}.webp`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "sessions", session, "frames")).mode & 0o777).toBe(0o700);
    expect(readFileSync(store.path(session, frame) ?? "").toString()).toBe("RIFF....WEBP");
    expect(store.path(session, ulid())).toBeUndefined();
    expect(() => store.save("../etc", frame, Buffer.alloc(1))).toThrow(/id/);
    expect(store.path(session, "../../daemon-token")).toBeUndefined();
    expect(existsSync(join(home, "daemon-token"))).toBe(false);
  });
});
