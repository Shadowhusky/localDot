import type { ShellChunk, ShellDone, ShellRequest } from "@localdot/protocol";
import { expect, it, vi } from "vitest";
import { desktopSiteStorage, READ_STORAGE } from "./desktop-storage.ts";

const finished = (over: Partial<ShellDone> = {}): ShellDone => ({
  done: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  ms: 5,
  ...over,
});

// A computer whose shell prints these chunks and ends so.
function computer(chunks: readonly string[], end = finished()) {
  return {
    shell: vi.fn(
      async (_request: ShellRequest, onChunk: (chunk: ShellChunk) => void | Promise<void>) => {
        for (const chunk of chunks) await onChunk({ stream: "stdout", chunk });
        return end;
      },
    ),
  };
}
const signal = new AbortController().signal;
const APP = "http://localhost:3102";

it("reads what the app saved inside the computer, quoting the read and each origin whole", async () => {
  const tools = computer(['[["workos:refresh-token","mo', 'ck"]]']);
  expect(await desktopSiteStorage(tools, [APP, "http://127.0.0.1:3102"], signal)).toEqual([
    ["workos:refresh-token", "mock"],
  ]);
  expect(tools.shell.mock.calls[0]?.[0].command).toBe(
    `/usr/local/bin/node --input-type=module -e '${READ_STORAGE}' '${APP}' 'http://127.0.0.1:3102'`,
  );
  expect(READ_STORAGE).not.toContain("'");
});

it("asks only about the computer's own servers", async () => {
  const tools = computer(["[]"]);
  for (const origin of [
    "https://localhost:3102",
    "http://example.com:3102",
    "http://localhost:3102/",
    "http://localhost",
    "http://localhost:0",
    "http://localhost:3102' && rm -rf ~ '",
  ])
    expect(await desktopSiteStorage(tools, [origin], signal)).toEqual([]);
  expect(tools.shell).not.toHaveBeenCalled();
});

it("brings nothing from a read that failed, was cut short or holds more than a sign-in", async () => {
  const many = (count: number, value: string) =>
    JSON.stringify(Array.from({ length: count }, (_, index) => [`key ${index}`, value]));
  const reads: [string, ShellDone][] = [
    ["", finished()],
    ["not json", finished()],
    ['[["a","b"]]', finished({ exitCode: 1 })],
    ['[["a","b"]]', finished({ timedOut: true })],
    ['[["a","b"]]', finished({ truncated: true })],
    ['[["a"]]', finished()],
    [JSON.stringify([["a", "x".repeat(256 * 1024 + 1)]]), finished()],
    [many(257, "v"), finished()],
    [many(5, "v".repeat(250_000)), finished()],
  ];
  for (const [out, end] of reads)
    expect(await desktopSiteStorage(computer([out], end), [APP], signal)).toEqual([]);
});
