import { ManualStreamAck, type ManualStreamInput } from "@localdot/protocol";

// Input made while the socket is still opening waits for it, up to this many messages.
const BACKLOG = 512;

export interface ManualChannel {
  send(input: ManualStreamInput): void;
  // Settles true once everything sent so far reached the computer; false on close or timeout.
  drained(timeoutMs: number): Promise<boolean>;
  close(): void;
}

// One ordered socket for the user's input while they hold control. Nothing is resent: after a
// drop, input that was not acknowledged may or may not have reached the computer.
export function openManualChannel(opts: {
  url: string;
  protocols: string[];
  onOpen?(): void;
  // The daemon or the network closed it, not close().
  onEnd(code: number): void;
  WebSocketImpl?: typeof WebSocket;
}): ManualChannel {
  const socket = new (opts.WebSocketImpl ?? WebSocket)(opts.url, opts.protocols);
  const waiting: string[] = [];
  const waiters = new Set<() => void>();
  let sent = 0,
    done = 0,
    ended = false;
  const settle = () => {
    for (const wake of [...waiters]) wake();
  };
  const finish = () => {
    ended = true;
    waiting.length = 0;
    settle();
  };
  socket.onopen = () => {
    for (const message of waiting.splice(0)) socket.send(message);
    opts.onOpen?.();
  };
  socket.onmessage = (event) => {
    try {
      done = ManualStreamAck.parse(JSON.parse(String(event.data))).done;
      settle();
    } catch {
      // Only acknowledgments come back; anything else is ignored.
    }
  };
  socket.onerror = () => {};
  socket.onclose = (event) => {
    if (ended) return;
    finish();
    opts.onEnd(event.code);
  };
  return {
    send(input) {
      if (ended) return;
      const message = JSON.stringify(input);
      if (socket.readyState === 1) socket.send(message);
      else if (waiting.length < BACKLOG) waiting.push(message);
      else return;
      sent++;
    },
    drained(timeoutMs) {
      return new Promise((resolve) => {
        const check = () => {
          if (done < sent && !ended) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(done >= sent);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          resolve(false);
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close() {
      if (ended) return;
      finish();
      socket.close(1000);
    },
  };
}
