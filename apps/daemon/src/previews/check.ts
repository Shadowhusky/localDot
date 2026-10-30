import type { Duplex } from "node:stream";
import type { PreviewTarget } from "@localdot/protocol";

const TITLE_BYTES = 64 * 1024;

// What a listening port said when asked: the scheme it answered HTTP in, or none when it stayed
// silent or, `other`, spoke something else (a database, a debugger) or closed at once.
export interface Check {
  scheme?: "http" | "https";
  answered: boolean;
  other?: boolean;
}

type Connect = (target: PreviewTarget) => Promise<Duplex>;

// Whether the server on `target`'s port answers HTTP now, at `known` (the scheme it answered before)
// or else at http, then https. The request has an unreadable Content-Length, which an HTTP server
// refuses before any of its app runs (Node's answer 400 at once), so checking never starts a compile
// or shows in a log; a stopped or hung process stays silent.
export async function checkServer(
  connect: Connect,
  target: PreviewTarget,
  ms: number,
  known?: "http" | "https",
): Promise<Check> {
  const ask = `GET / HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: ?\r\nConnection: close\r\n\r\n`;
  if (known !== "https") {
    const plain = await exchange(connect, { ...target, scheme: "http" }, ask, ms);
    if (plain.http) return { scheme: "http", answered: true };
    if (known || plain.silent) return { ...(known ? { scheme: known } : {}), answered: false };
  }
  const tls = await exchange(connect, { ...target, scheme: "https" }, ask, ms);
  if (tls.http) return { scheme: "https", answered: true };
  if (known) return { scheme: known, answered: false };
  return tls.silent ? { answered: false } : { answered: false, other: true };
}

// The <title> of the server's first page, read once a server answers: it names the row better than
// its program does.
export async function titleOf(
  connect: Connect,
  target: PreviewTarget,
  ms: number,
): Promise<string | undefined> {
  const ask = `GET / HTTP/1.1\r\nHost: ${target.host}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`;
  const { head } = await exchange(connect, target, ask, ms, (text) => /<\/title>/i.test(text));
  if (!/^HTTP\/1\.[01] 200 /.test(head) || !/^content-type:\s*text\/html/im.test(head))
    return undefined;
  const raw = /<title[^>]*>([^<]{1,400})<\/title>/i.exec(head)?.[1];
  const title = raw && decodeEntities(raw).replace(/\s+/g, " ").trim().slice(0, 120);
  return title || undefined;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== "#") return named[body.toLowerCase()] ?? entity;
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// Sends `ask` and reads the answer until `enough` says so, it ends, or `ms` pass.
async function exchange(
  connect: Connect,
  target: PreviewTarget,
  ask: string,
  ms: number,
  enough: (text: string) => boolean = (text) => text.length >= 5,
): Promise<{ http: boolean; silent: boolean; head: string }> {
  const socket = await connect(target).catch(() => undefined);
  if (!socket) return { http: false, silent: false, head: "" };
  return new Promise((resolve) => {
    let head = "";
    const done = (silent: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ http: head.startsWith("HTTP/"), silent: silent && !head, head });
    };
    const timer = setTimeout(() => done(true), ms);
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.length >= TITLE_BYTES || enough(head)) done(false);
    });
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.resume();
    socket.write(ask);
  });
}
