import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchReply } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { SearchIndex } from "./search-index.ts";

const TOKEN = "t".repeat(43);
const PORT = 4750;
const done: (() => void)[] = [];
afterEach(() => {
  for (const d of done.splice(0).reverse()) d();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-search-routes-"));
  const eventLog = new EventLog(home);
  const index = new SearchIndex(home, { sessions: eventLog });
  done.push(
    () => rmSync(home, { recursive: true, force: true }),
    () => eventLog.close(),
    () => index.close(),
  );
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    search: { index, feed: { complete: true } },
  });
  const get = (path: string, auth = true) =>
    app.request(`http://127.0.0.1:${PORT}${path}`, {
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    });
  return { eventLog, index, get };
}

describe("GET /api/search", () => {
  it("requires the install token", async () => {
    expect((await setup().get("/api/search?q=x", false)).status).toBe(401);
  });
  it("answers hits with titles and dates", async () => {
    const { eventLog, index, get } = setup();
    const id = eventLog.createSession("Renew the car insurance");
    index.add([
      {
        kind: "title",
        sessionId: id,
        ref: "title",
        at: "2026-09-03T09:00:00.000Z",
        text: "Renew the car insurance",
      },
    ]);
    const res = await get("/api/search?q=insurance");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const reply = SearchReply.parse(await res.json());
    expect(reply).toMatchObject({
      complete: true,
      mode: "fts",
      hits: [{ sessionId: id, title: "Renew the car insurance", kind: "title" }],
    });
  });
  it("rejects empty, oversized and malformed queries with 400", async () => {
    const { get } = setup();
    for (const path of [
      "/api/search",
      "/api/search?q=%20",
      `/api/search?q=${"a".repeat(201)}`,
      "/api/search?q=x&kind=secret",
      "/api/search?q=x&limit=0",
      "/api/search?q=x&limit=51",
      "/api/search?q=%00",
    ])
      expect((await get(path)).status, path).toBe(400);
    expect((await get(`/api/search?q=${encodeURIComponent('"NEAR( * -:')}`)).status).toBe(200);
  });
});
