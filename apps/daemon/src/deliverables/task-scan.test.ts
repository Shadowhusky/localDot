import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../event-log.ts";
import { TaskScanner } from "./task-scan.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function home() {
  const dir = mkdtempSync(join(tmpdir(), "localdot-scan-"));
  homes.push(dir);
  return dir;
}
describe("task scanner", () => {
  it("rescans a task only when its log grew, and knows nothing of unknown tasks", async () => {
    const log = new EventLog(home());
    const id = log.createSession("T");
    const scanner = new TaskScanner(log);
    const first = await scanner.scan(id);
    expect(await scanner.scan(id)).toBe(first);
    log.append(id, { type: "task.result", agent: "main", data: { summary: "s", files: [] } });
    const second = await scanner.scan(id);
    expect(second).not.toBe(first);
    expect(second?.results).toHaveLength(1);
    expect(await scanner.scan(ulid())).toBeUndefined();
    log.close();
  });
  it("shares one read between concurrent scans of a task", async () => {
    const log = new EventLog(home());
    const id = log.createSession("T");
    log.append(id, { type: "task.result", agent: "main", data: { summary: "s", files: [] } });
    const scanner = new TaskScanner(log);
    const [a, b] = await Promise.all([scanner.scan(id), scanner.scan(id)]);
    expect(a).toBe(b);
    expect(a?.results).toHaveLength(1);
    log.close();
  });
});
