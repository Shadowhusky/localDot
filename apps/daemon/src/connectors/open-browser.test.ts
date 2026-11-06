import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { openInBrowser } from "./open-browser.ts";

function fakeSpawn(code: number | Error) {
  return vi.fn(() => {
    const child = new EventEmitter();
    queueMicrotask(() =>
      code instanceof Error ? child.emit("error", code) : child.emit("close", code),
    );
    return child;
  }) as never;
}

describe("openInBrowser", () => {
  it("hands the address to the system as one argument, with no shell", async () => {
    const start = fakeSpawn(0);
    const url = "https://auth.example/authorize?a=1&b=$(id)";
    expect(await openInBrowser(url, "darwin", start)).toBe(true);
    expect(start).toHaveBeenCalledWith("/usr/bin/open", [url], expect.anything());
    const options = (start as unknown as ReturnType<typeof vi.fn>).mock.lastCall?.[2];
    expect(options?.shell).toBeUndefined();
  });

  it("says when there is no browser to open it in", async () => {
    expect(await openInBrowser("https://a.example", "linux", fakeSpawn(3))).toBe(false);
    expect(await openInBrowser("https://a.example", "linux", fakeSpawn(new Error("none")))).toBe(
      false,
    );
  });

  it("opens only https pages", async () => {
    const start = fakeSpawn(0);
    expect(await openInBrowser("file:///etc/passwd", "darwin", start)).toBe(false);
    expect(await openInBrowser("-a Calculator", "darwin", start)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
