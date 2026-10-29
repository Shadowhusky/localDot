import { setTimeout as sleep } from "node:timers/promises";
import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import { daemonRequester, type StopIO, tokenAt } from "../stop.ts";

// A restart is followed until the browser is back or has failed, as long as a start may take.
const RESTART_WATCH_MS = 180_000;

const Cells = z
  .array(z.object({ id: z.string().regex(ULID_PATTERN), state: z.string() }))
  .max(1024);

const STATES: Record<BrowserStatus["state"], string> = {
  off: "off",
  starting: "starting",
  ready: "ready",
  restarting: "restarting",
  failed: "failed to start",
  stopped: "stopped",
};

const time = (iso: string) => new Date(iso).toLocaleTimeString();

function describe(cellId: string, status: BrowserStatus): string[] {
  const restarts = status.restarts
    ? `, restarted in place ${status.restarts === 1 ? "once" : `${status.restarts} times`}`
    : "";
  const reason = status.reason && status.reason !== status.state ? ` (${status.reason})` : "";
  const lines = [`Computer ${cellId}: web browser ${STATES[status.state]}${reason}${restarts}`];
  if (status.problem)
    lines.push(`  ${status.problemAt ? `${time(status.problemAt)}: ` : ""}${status.problem}`);
  const next = [
    status.clears,
    status.retryAt && `localDot tries again at ${time(status.retryAt)}.`,
    status.readyBy && `Ready, or failed, by ${time(status.readyBy)}.`,
  ].filter(Boolean);
  if (next.length) lines.push(`  ${next.join(" ")}`);
  return lines;
}

// `localdot browser status|restart`: the web browser of this computer's localDot, through the
// daemon's authenticated loopback API. A restart keeps the browser's saved sign-ins.
export async function runBrowser(
  context: {
    home: string;
    port: number;
    signal: AbortSignal;
    operation: "status" | "restart";
    cellId?: string;
  },
  io: StopIO,
): Promise<number> {
  const { signal } = context;
  let token: string;
  try {
    token = tokenAt(context.home);
  } catch {
    io.err("localDot's daemon token could not be read. Run localdot up, then try again.");
    return 1;
  }
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), RESTART_WATCH_MS + 15_000);
  const owned = AbortSignal.any([signal, lifetime.signal]);
  const request = daemonRequester(context.port, token, owned, io.fetch ?? fetch);
  const status = async (cellId: string) =>
    BrowserStatus.parse(await request(`/api/cells/${cellId}/browser`, 200));
  try {
    const cells = Cells.parse(await request("/api/cells", 200)).filter(
      (cell) => !context.cellId || cell.id === context.cellId,
    );
    if (!cells.length) {
      io.err(context.cellId ? "No computer has that ID." : "There is no computer yet.");
      return 1;
    }
    if (context.operation === "status") {
      for (const cell of cells)
        for (const line of describe(cell.id, await status(cell.id))) io.out(line);
      return 0;
    }
    const running = cells.filter((cell) => cell.state === "ready");
    const [cell] = running;
    if (running.length !== 1 || !cell) {
      io.err(
        running.length
          ? "More than one computer is running. Choose one with --cell <id>."
          : "No computer is running, so its web browser is off. Start the computer first.",
      );
      return 2;
    }
    const cellId = cell.id;
    const before = await status(cellId);
    if (before.state === "off") {
      for (const line of describe(cellId, before)) io.err(line);
      return 1;
    }
    BrowserStatus.parse(await request(`/api/cells/${cellId}/browser/restart`, 202, "POST"));
    io.out("Restarting the web browser. Its saved sign-ins are kept; open pages are closed.");
    const deadline = Date.now() + RESTART_WATCH_MS;
    // The restart first takes the old browser down, then starts it again.
    await sleep(2000, undefined, { signal: owned });
    while (Date.now() < deadline) {
      const now = await status(cellId);
      if (now.state === "ready") {
        io.out("The web browser is running again.");
        return 0;
      }
      if (now.state === "failed" || now.state === "off") {
        for (const line of describe(cellId, now)) io.err(line);
        return 1;
      }
      await sleep(1000, undefined, { signal: owned });
    }
    io.err("The web browser is still restarting. Check it with localdot browser status.");
    return 1;
  } catch {
    io.err(
      signal.aborted
        ? "Interrupted."
        : "localDot's daemon did not answer. Check that localDot is running (localdot up), then try again.",
    );
    return signal.aborted ? 130 : 1;
  } finally {
    clearTimeout(timer);
    lifetime.abort();
  }
}
