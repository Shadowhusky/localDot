import { type RawData, WebSocket } from "ws";
import { PROTOCOL } from "../socket.ts";
import { CONNECT_TIMEOUT_MS, type VoicedEndpoint } from "./local.ts";

// About ten seconds of 16 kHz microphone audio held while voiced's socket opens.
export const MAX_HELD_BYTES = 320_000;

// The page's /voice/stt socket, piped to voiced's /stt with the token added.
export function relaySpeechInput(
  browser: WebSocket,
  endpoint: () => Promise<VoicedEndpoint | null>,
): void {
  const held: { data: RawData; isBinary: boolean }[] = [];
  let heldBytes = 0;
  let voiced: WebSocket | null = null;
  const refuse = (message: string) => {
    if (browser.readyState !== WebSocket.OPEN) return;
    browser.send(JSON.stringify({ type: "error", code: "unavailable", message }));
    browser.close();
  };
  browser.on("message", (data: RawData, isBinary: boolean) => {
    if (voiced?.readyState === WebSocket.OPEN) {
      voiced.send(data, { binary: isBinary });
      return;
    }
    // Only audio is dropped when the hold is full: a lost release would leave voiced listening.
    if (isBinary) {
      const size = Buffer.isBuffer(data) ? data.length : 0;
      if (heldBytes + size > MAX_HELD_BYTES) return;
      heldBytes += size;
    }
    held.push({ data, isBinary });
  });
  browser.on("close", () => voiced?.close());
  browser.on("error", () => browser.terminate());
  void endpoint().then(
    (found) => {
      if (!found) return refuse("voiced is not running");
      if (browser.readyState !== WebSocket.OPEN) return;
      const socket = new WebSocket(`ws://${found.host}/stt`, [PROTOCOL], {
        headers: { authorization: `Bearer ${found.token}` },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      });
      voiced = socket;
      socket.on("open", () => {
        for (const message of held.splice(0))
          socket.send(message.data, { binary: message.isBinary });
        heldBytes = 0;
      });
      socket.on("message", (data: RawData, isBinary: boolean) =>
        browser.send(data, { binary: isBinary }),
      );
      // voiced closes with 1011 only after reporting what went wrong; any other close needs saying.
      socket.on("close", (code) =>
        code === 1011 ? browser.close() : refuse("voiced closed the connection"),
      );
      socket.on("error", (error) => refuse(error.message));
    },
    () => refuse("voiced is not running"),
  );
}
