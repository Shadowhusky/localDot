import type { Readable, Writable } from "node:stream";
import type { CdpTransport } from "./cdp-guard.ts";

// Chromium's --remote-debugging-pipe: browserd writes commands to the child's fd 3 and reads
// replies and events from its fd 4, each message JSON followed by a NUL byte.
export const MAX_CDP_MESSAGE_BYTES = 64 * 1024 * 1024;

export function pipeTransport(toChrome: Writable, fromChrome: Readable): CdpTransport {
  const listeners: ((m: string) => void)[] = [];
  const closers: (() => void)[] = [];
  let buffered = Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const c of closers) c();
  };
  fromChrome.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (let end = buffered.indexOf(0); end >= 0; end = buffered.indexOf(0)) {
      const text = buffered.subarray(0, end).toString("utf8");
      buffered = buffered.subarray(end + 1);
      for (const l of listeners) l(text);
    }
    // A message this large is not one browserd asked for; the pipe is dropped, not grown.
    if (buffered.length > MAX_CDP_MESSAGE_BYTES) {
      fromChrome.destroy();
      close();
    }
  });
  fromChrome.on("close", close);
  fromChrome.on("error", close);
  toChrome.on("error", close);
  return {
    write: (m) => {
      if (!closed) toChrome.write(`${m}\0`);
    },
    onMessage: (l) => listeners.push(l),
    onClose: (l) => closers.push(l),
    close: () => {
      toChrome.end();
      fromChrome.destroy();
      close();
    },
  };
}
