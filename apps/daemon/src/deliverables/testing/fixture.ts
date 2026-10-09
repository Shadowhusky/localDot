import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { vi } from "vitest";
import { OutputStore } from "../../agent/output-store.ts";
import { EventLog } from "../../event-log.ts";
import { FrameStore } from "../../gateway/frames.ts";
import type { MacOpener } from "../open-on-mac.ts";
import { type Converter, Previews } from "../previews.ts";
import { deliverableRoutes, type ReviseDeps } from "../routes.ts";
import { TaskScanner } from "../task-scan.ts";

// Only a Host value for app.request: nothing listens on it.
export const PORT = 4747;
const homes: string[] = [];
export function cleanFixtures(): void {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}
// A daemon home with the deliverable routes on a bare Hono app (the /api token guard is
// createApp's and is tested with the app's wiring).
export function deliverablesFixture(opts: { converter?: Converter; revise?: ReviseDeps } = {}) {
  const home = mkdtempSync(join(tmpdir(), "localdot-deliverables-"));
  homes.push(home);
  const log = new EventLog(home);
  const outputs = new OutputStore(home);
  const app = new Hono();
  const downloads = join(home, "mac-downloads");
  mkdirSync(downloads);
  const launched: string[] = [];
  const quarantined: string[] = [];
  const opener: MacOpener = {
    downloads,
    platform: "darwin",
    quarantine: async (p) => void quarantined.push(p),
    launch: async (p) => void launched.push(p),
  };
  const convert = vi.fn<Converter["convert"]>(async () => "computer_off" as const);
  deliverableRoutes(app, {
    home,
    port: PORT,
    eventLog: log,
    scanner: new TaskScanner(log),
    previews: new Previews(home, opts.converter ?? { convert }),
    frames: new FrameStore(home),
    opener,
    ...(opts.revise ? { revise: opts.revise } : {}),
  });
  const task = (title = "Monthly report") => {
    const id = log.createSession(title);
    log.append(id, {
      type: "session.start",
      agent: "main",
      data: { screen: { w: 1, h: 1, scale: 1 }, os: "linux", title },
    });
    return id;
  };
  // What done does: save each file as a new version, then append the result.
  const result = (id: string, files: Record<string, string | Buffer>) => {
    const saved = Object.entries(files).map(([name, data]) => {
      const s = outputs.saveBytes(id, name, typeof data === "string" ? Buffer.from(data) : data);
      return { name, path: name, bytes: s.bytes, version: s.version };
    });
    return log.append(id, {
      type: "task.result",
      agent: "main",
      data: { summary: "Done.", files: saved },
    });
  };
  const get = (path: string) => app.request(`http://127.0.0.1:${PORT}${path}`);
  return { home, log, outputs, app, task, result, get, convert, downloads, launched, quarantined };
}
