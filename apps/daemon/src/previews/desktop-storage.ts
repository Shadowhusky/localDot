import { z } from "zod";
import type { DesktopdTools } from "../desktopd/tools-client.ts";

// What an app's saved storage may bring into its preview: enough for a sign-in, never a cache.
const MAX_ITEMS = 256;
const MAX_KEY = 1024;
const MAX_VALUE = 256 * 1024;
const MAX_TOTAL = 1024 * 1024;
// The computer's own servers, by the loopback names its desktop browser knows them by.
const ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}$/u;
// The read gives up inside the computer before the caller stops waiting for it.
const READ_MS = 2_000;

// Runs inside the computer, whose desktop Chromium is where dot opens the computer's own servers:
// it reads what an app saved there from a page of it Chromium has open, through the debugging port
// localDot's desktop tools use, and prints [] when no page shows the app. It never opens a page.
// The command quotes it whole, so it holds no single quote.
export const READ_STORAGE = `
setTimeout(() => process.exit(0), ${READ_MS}).unref();
const kept = [];
try {
  const listed = await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(${READ_MS}) });
  const pages = await listed.json();
  for (const origin of process.argv.slice(1)) {
    const page = pages.find((each) => each.type === "page" && typeof each.webSocketDebuggerUrl === "string" && URL.canParse(each.url) && new URL(each.url).origin === origin);
    if (!page) continue;
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const waiting = new Map();
    socket.onmessage = (event) => { const reply = JSON.parse(event.data); waiting.get(reply.id)?.(reply); };
    const ask = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    await ask(1, "DOMStorage.enable", {});
    const reply = await ask(2, "DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: origin, isLocalStorage: true } });
    socket.close();
    let total = 0;
    for (const [key, value] of reply.result?.entries ?? []) {
      if (kept.length >= ${MAX_ITEMS}) break;
      if (typeof key !== "string" || typeof value !== "string" || key.length > ${MAX_KEY} || value.length > ${MAX_VALUE}) continue;
      total += key.length + value.length;
      if (total > ${MAX_TOTAL}) break;
      kept.push([key, value]);
    }
    if (kept.length) break;
  }
} catch {}
process.stdout.write(JSON.stringify(kept), () => process.exit(0));
`;

const Entries = z
  .array(z.tuple([z.string().max(MAX_KEY), z.string().max(MAX_VALUE)]))
  .max(MAX_ITEMS)
  .refine(
    (entries) =>
      entries.reduce((sum, [key, value]) => sum + key.length + value.length, 0) <= MAX_TOTAL,
  );

// What the app at the first of these origins saved in the computer's desktop browser.
export async function desktopSiteStorage(
  tools: Pick<DesktopdTools, "shell">,
  origins: readonly string[],
  signal: AbortSignal,
): Promise<[string, string][]> {
  const wanted = origins.filter((origin) => ORIGIN.test(origin));
  if (!wanted.length) return [];
  let out = "";
  const done = await tools.shell(
    {
      command: [
        "/usr/local/bin/node",
        "--input-type=module",
        "-e",
        `'${READ_STORAGE}'`,
        ...wanted.map((origin) => `'${origin}'`),
      ].join(" "),
      timeoutMs: READ_MS + 3_000,
      // The read keeps at most a megabyte, which JSON can write out several times larger.
      maxOutputBytes: 4 * 1024 * 1024,
    },
    (chunk) => {
      if (chunk.stream === "stdout") out += chunk.chunk;
    },
    signal,
  );
  if (done.exitCode !== 0 || done.timedOut || done.truncated || !out) return [];
  try {
    return Entries.parse(JSON.parse(out));
  } catch {
    return [];
  }
}
