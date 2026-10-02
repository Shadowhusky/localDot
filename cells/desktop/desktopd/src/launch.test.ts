import { describe, expect, it } from "vitest";
import { LAUNCHERS, launchApp } from "./launch.ts";

describe("launchApp", () => {
  it("spawns the allow-listed command detached with the display environment", () => {
    const seen: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      seen.push({ cmd, args, opts });
      return { pid: 4242, unref() {}, once() {} };
    }) as never;
    const res = launchApp(
      { app: "chromium", args: ["--kiosk", "file:///opt/localdot/flash.html"] },
      { DISPLAY: ":1" },
      spawnImpl,
    );
    expect(res.pid).toBe(4242);
    expect(seen[0]?.cmd).toBe(LAUNCHERS.chromium[0]);
    expect(seen[0]?.args).toEqual(["--kiosk", "file:///opt/localdot/flash.html"]);
    expect(seen[0]?.opts).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: { DISPLAY: ":1" },
    });
  });

  it("refuses arguments beyond the allow-listed flags and file URLs under /opt/localdot or /config", () => {
    const spawnImpl = (() => ({ pid: 1, unref() {}, once() {} })) as never;
    expect(() => launchApp({ app: "terminal", args: ["-e", "rm -rf /"] }, {}, spawnImpl)).toThrow(
      /argument/,
    );
    expect(() =>
      launchApp({ app: "chromium", args: ["http://example.com"] }, {}, spawnImpl),
    ).toThrow(/argument/);
    expect(() =>
      launchApp(
        { app: "chromium", args: ["file:///opt/localdot/../../etc/passwd"] },
        {},
        spawnImpl,
      ),
    ).toThrow(/argument/);
    expect(() => launchApp({ app: "thunar", args: ["/config/../etc"] }, {}, spawnImpl)).toThrow(
      /argument/,
    );
    expect(() =>
      launchApp(
        { app: "chromium", args: ["file:///opt/localdot/%2e%2e/%2e%2e/etc/passwd"] },
        {},
        spawnImpl,
      ),
    ).toThrow(/argument/);
    expect(() =>
      launchApp({ app: "chromium", args: ["file:///config/%00x"] }, {}, spawnImpl),
    ).toThrow(/argument/);
    expect(() =>
      launchApp({ app: "chromium", args: ["--remote-debugging-address=0.0.0.0"] }, {}, spawnImpl),
    ).toThrow(/argument/);
    expect(() =>
      launchApp({ app: "chromium", args: ["--proxy-server=127.0.0.1:1"] }, {}, spawnImpl),
    ).toThrow(/argument/);
    expect(() =>
      launchApp({ app: "chromium", args: ["--user-data-dir=/tmp/x"] }, {}, spawnImpl),
    ).toThrow(/argument/);
    expect(
      launchApp(
        { app: "chromium", args: ["--new-window", "--incognito", "about:blank"] },
        {},
        spawnImpl,
      ).pid,
    ).toBe(1);
  });
});
