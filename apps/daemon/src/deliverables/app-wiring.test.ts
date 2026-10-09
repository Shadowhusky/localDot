import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileVersionsReply, ProofReply } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../agent/session.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { FrameStore } from "../gateway/frames.ts";
import { deliverableScenarios, deliverablesDeps } from "./testing/qa-scenarios.ts";

const TOKEN = "a".repeat(43);
const PORT = 4747;
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-deliverables-app-"));
  homes.push(home);
  const log = new EventLog(home);
  const s = new AgentSession(log.createSession("T"), "01JXYZ0000000000000000CE11", "task", log);
  log.append(s.id, {
    type: "session.start",
    agent: "main",
    data: { screen: { w: 1, h: 1, scale: 1 }, os: "linux", title: "T" },
  });
  const effects: string[] = [];
  const fixture = {
    home,
    // The fixture daemon's frame WebPs, read as files (no module import from apps/web).
    assets: join(import.meta.dirname, "../../../web/e2e/fixtures/ui-assets"),
    log,
    frames: new FrameStore(home),
    effects,
    session: () => s,
  };
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog: log,
    deliverables: deliverablesDeps(fixture),
  });
  deliverableScenarios(app, fixture);
  const call = (path: string, init: RequestInit = {}, env?: unknown) =>
    app.request(
      `http://127.0.0.1:${PORT}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          host: `127.0.0.1:${PORT}`,
          ...(init.headers ?? {}),
        },
      },
      env,
    );
  return { s, app, call, effects };
}
describe("deliverables in the app", () => {
  it("sits behind the token and the host guard", async () => {
    const { s, app } = setup();
    const path = `/api/agent/sessions/${s.id}/files/a.csv/versions`;
    expect((await app.request(`http://127.0.0.1:${PORT}${path}`)).status).toBe(401);
    expect(
      (
        await app.request(`http://evil.example${path}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(403);
  });
  it("serves the fixture's files, versions, previews, proof and Open on Mac", async () => {
    const { s, call, effects } = setup();
    expect((await call("/__qa/files", { method: "POST" })).status).toBe(200);
    expect((await call("/__qa/revise", { method: "POST" })).status).toBe(200);
    const versions = FileVersionsReply.parse(
      await (await call(`/api/agent/sessions/${s.id}/files/totals.csv/versions`)).json(),
    );
    expect(versions.versions.map((v) => v.label)).toEqual([1, 2]);
    const ods = await call(`/api/agent/sessions/${s.id}/files/report.ods/preview?v=1`);
    expect(ods.headers.get("x-localdot-preview")).toBe("computer");
    const proof = ProofReply.parse(await (await call(`/api/agent/sessions/${s.id}/proof`)).json());
    expect(proof.results[0]?.frames.map((f) => f.role)).toEqual(["start", "change", "end"]);
    expect(proof.results[0]?.checked).toBe("opens, 4 sheets");
    const open = await call(
      `/api/agent/sessions/${s.id}/files/report.ods/open`,
      {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(open.status).toBe(200);
    expect(effects).toContain(`open:localDot/T (${s.id.slice(-6).toLowerCase()})/report.ods`);
  });
});
