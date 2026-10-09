import { describe, expect, it } from "vitest";
import { cleanLine, type ExecFile, macNotifier } from "./mac.ts";

function recorder(fail = false) {
  const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const execFile: ExecFile = (file, args, options, callback) => {
    calls.push({ file, args, env: options.env });
    callback(fail ? new Error("osascript failed") : null);
  };
  return { calls, execFile };
}

describe("Mac notifier", () => {
  it("passes the text as arguments after --, never inside the script", async () => {
    const { calls, execFile } = recorder();
    const mac = macNotifier({ platform: "darwin", execFile });
    const title = 'dot needs you" & do shell script "touch /tmp/pwned';
    await expect(mac.show(title, "-e pay the bill\nnow")).resolves.toBe("shown");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/osascript");
    expect(calls[0]?.args).toEqual([
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      "--",
      'dot needs you" & do shell script "touch /tmp/pwned',
      "-e pay the bill now",
    ]);
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(["HOME", "LANG", "PATH"]);
  });

  it("is unavailable off macOS and reports a failed banner", async () => {
    expect(
      await macNotifier({ platform: "linux", execFile: recorder().execFile }).show("a", "b"),
    ).toBe("unavailable");
    expect(
      await macNotifier({ platform: "darwin", execFile: recorder(true).execFile }).show("a", "b"),
    ).toBe("failed");
  });

  it("shows at most six banners a minute", async () => {
    let now = 0;
    const { calls, execFile } = recorder();
    const mac = macNotifier({ platform: "darwin", execFile, now: () => now });
    for (let n = 0; n < 8; n++) await mac.show("Task done", `task ${n}`);
    expect(calls).toHaveLength(6);
    now = 60_001;
    await mac.show("Task done", "later");
    expect(calls).toHaveLength(7);
  });

  it("cuts and flattens text", () => {
    expect(cleanLine("a\tb\u0000c", 10)).toBe("a b c");
    expect(cleanLine("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
