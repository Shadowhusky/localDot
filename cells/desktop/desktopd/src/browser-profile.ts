import { spawn } from "node:child_process";
import { DesktopBrowserReady } from "../../../../packages/protocol/src/desktop-browser.ts";

// Once rotation starts, it owns retirement even if the HTTP caller disconnects. The helper's
// lock and retiring record survive interruption. No replacement browser may use that record.
export async function prepareDesktopBrowser(
  taskId: string | null,
  signal?: AbortSignal,
  helper = "/opt/localdot/desktop-browser.py",
): Promise<{ taskId: string | null; generation: string }> {
  signal?.throwIfAborted();
  const child = spawn("/usr/bin/python3", [helper, "rotate"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let output = "";
  let failed = false;
  const kill = () => {
    failed = true;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(kill, 15_000);
  timer.unref();
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      failed = true;
    });
    child.once("close", resolve);
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString("utf8");
      if (output.length > 1024) kill();
    });
    child.stdin.on("error", () => {
      failed = true;
    });
  });
  child.stdin.end(JSON.stringify({ taskId, recover: taskId === null }));
  try {
    const code = await closed;
    if (failed || code !== 0) throw new Error("Desktop browser preparation failed.");
    const result: unknown = JSON.parse(output);
    // Recovery is internal to desktopd startup, never an HTTP-supplied option.
    const receipt = DesktopBrowserReady.extend({
      taskId: DesktopBrowserReady.shape.taskId.nullable(),
    }).parse(result);
    if (receipt.taskId !== taskId) throw new Error("Desktop browser preparation changed.");
    signal?.throwIfAborted();
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}
