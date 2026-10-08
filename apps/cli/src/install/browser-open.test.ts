import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { isInstallerBrowserURL, openInstallerBrowser } from "./browser-open.ts";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
});
const url = `http://127.0.0.1:4750/#code=${"a".repeat(43)}`;
it("accepts only local generated progress/sign-in URLs", () => {
  expect(isInstallerBrowserURL(url)).toBe(true);
  expect(isInstallerBrowserURL(url.replace("#code", "#progress"))).toBe(true);
  for (const candidate of [
    url.replace("127.0.0.1", "localhost"),
    url.replace(":4750", ":80"),
    url.replace(":4750", ":65536"),
    `${url}\n`,
    `${url}&next=remote`,
    url.replace("http:", "https:"),
    "-a Calculator",
    "file:///tmp/file",
    url.replace("127.0.0.1", "u@127.0.0.1"),
  ])
    expect(isInstallerBrowserURL(candidate)).toBe(false);
});
it("spawns a fixed no-shell opener and waits for successful closure", async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  spawn.mockReturnValue(child);
  const signal = new AbortController().signal;
  const done = openInstallerBrowser(url, signal);
  expect(spawn).toHaveBeenCalledWith(
    "/usr/bin/open",
    [url],
    expect.objectContaining({
      shell: false,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    }),
  );
  child.emit("close", 0);
  expect(await done).toBe(true);
});
it.each(["abort", "deadline", "error"])("drains the owned child after %s", async (kind) => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  spawn.mockReturnValue(child);
  const controller = new AbortController();
  let settled = false;
  const done = openInstallerBrowser(url, controller.signal).finally(() => {
    settled = true;
  });
  if (kind === "abort") controller.abort();
  if (kind === "deadline") await vi.advanceTimersByTimeAsync(5000);
  if (kind === "error") child.emit("error", new Error("private detail"));
  await Promise.resolve();
  expect(settled).toBe(false);
  if (kind !== "error") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", 0);
  expect(await done).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("does not spawn for invalid input or pre-cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await openInstallerBrowser(url, controller.signal)).toBe(false);
  expect(await openInstallerBrowser("https://example.com", new AbortController().signal)).toBe(
    false,
  );
  expect(spawn).not.toHaveBeenCalled();
});
