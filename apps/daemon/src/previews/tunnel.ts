import { connect, type Socket } from "node:net";
import { type PreviewCommand, PreviewListing, PreviewNo, previewPreface } from "@localdot/protocol";
import type { PreviewEndpoint } from "../cells/types.ts";

const OPEN_MS = 10_000;
const LIST_MS = 10_000;
// A listing of 512 listeners is about 40 KiB.
const ANSWER_BYTES = 128 * 1024;

// The forwarder didn't answer. A connection the gate ends without a word (`silent`) means nothing
// listens behind it: a gate or desktop from before previews. One that hangs is a computer too busy.
export class ForwarderMissing extends Error {
  constructor(readonly silent: boolean) {
    super("the computer's preview forwarder did not answer");
    this.name = "ForwarderMissing";
  }
}

export class ForwarderRefused extends Error {
  constructor(readonly reason: PreviewNo) {
    super(`the computer's preview forwarder refused: ${reason}`);
    this.name = "ForwarderRefused";
  }
}

// A connection to a server in the computer, carried by the gate's preview relay to desktopd's
// forwarder. It resolves once the forwarder has reached the server.
export async function openTunnel(
  endpoint: PreviewEndpoint,
  dial: string,
  ms = OPEN_MS,
): Promise<Socket> {
  const { socket, line } = await ask(endpoint, { open: dial }, ms);
  if (line !== "OK") {
    socket.destroy();
    throw refusal(line);
  }
  return socket;
}

export async function listServers(
  endpoint: PreviewEndpoint,
  ms = LIST_MS,
): Promise<PreviewListing> {
  const { socket, line } = await ask(endpoint, { list: true }, ms);
  socket.destroy();
  if (!line.startsWith("OK ")) throw refusal(line);
  try {
    return PreviewListing.parse(JSON.parse(line.slice(3)));
  } catch {
    throw new ForwarderRefused("bad-request");
  }
}

function refusal(line: string): Error {
  const reason = PreviewNo.safeParse(line.slice(3));
  return line.startsWith("NO ") && reason.success
    ? new ForwarderRefused(reason.data)
    : new ForwarderMissing(true);
}

// Sends the preface and reads the forwarder's one-line answer. Bytes after it belong to the server,
// so they go back into the socket for whoever reads it next.
function ask(
  endpoint: PreviewEndpoint,
  command: PreviewCommand,
  ms: number,
): Promise<{ socket: Socket; line: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: endpoint.port });
    let buffered = Buffer.alloc(0);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new ForwarderMissing(false)), ms);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end < 0) {
        if (buffered.length > ANSWER_BYTES) fail(new ForwarderMissing(true));
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      // Whoever takes the socket handles its errors; until then one must not end the daemon.
      socket.on("error", () => {});
      socket.pause();
      const rest = buffered.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      resolve({ socket, line: buffered.subarray(0, end).toString("utf8") });
    };
    const onError = () => fail(new ForwarderMissing(true));
    const onClose = () => fail(new ForwarderMissing(true));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.setNoDelay(true);
    socket.write(previewPreface(endpoint.token, command));
  });
}
