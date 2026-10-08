import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transfers } from "../agent/transfers.ts";
import { createApp } from "../app.ts";
import type { EventLog } from "../event-log.ts";
import { type PlaceDownload, QuarantineStore } from "./quarantine.ts";
import { quarantineRoutes } from "./quarantine-routes.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "quarantine-api-"));
  homes.push(home);
  const store = await QuarantineStore.open(home),
    transfers = new Transfers();
  const parent = ulid();
  const scope = { signal: new AbortController().signal, check() {} };
  const item = await store.ingest(
    {
      parentCellId: parent,
      browserCellId: ulid(),
      browserInstance: randomUUID(),
      sessionId: ulid(),
      source: "files.example.test",
      name: "report.txt",
    },
    Readable.from([Buffer.from("verified")]),
    scope,
  );
  const place = vi.fn<PlaceDownload>(async (request, chunks) => {
    const data: Uint8Array[] = [];
    for await (const part of chunks) data.push(part);
    expect(createHash("sha256").update(Buffer.concat(data)).digest("hex")).toBe(request.sha256);
    return { ...request, path: `~/Downloads/${request.name}` };
  });
  const access = vi.fn((_id: string, signal: AbortSignal) =>
    transfers.acquire(parent, [signal], () => {}),
  );
  const app = createApp({ token: "fixture", port: 4747, eventLog: {} as EventLog });
  quarantineRoutes(app, { store, exists: (id) => id === parent, place, access });
  const release = {
    revision: item.revision,
    name: item.name,
    bytes: item.bytes,
    sha256: item.sha256,
    to: "computer",
  };
  const request = (suffix = "", body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`http://127.0.0.1:4747/api/cells/${parent}/quarantine${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { home, store, transfers, parent, item, place, access, app, request, release };
}

describe("authenticated user quarantine routes", () => {
  it("returns metadata only without releasing any file", async () => {
    const f = await fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [f.item] });
    expect(f.place).not.toHaveBeenCalled();
    expect(f.access).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([
    { authorization: "Bearer model-tool-token" },
    { origin: "https://untrusted.example" },
    { host: "untrusted.example" },
  ])("uses the existing install-token, origin and host guard %#", async (headers) => {
    const f = await fixture();
    const response = await f.request(`/${f.item.id}/release`, f.release, headers);
    expect([401, 403]).toContain(response.status);
    expect(f.place).not.toHaveBeenCalled();
    expect(f.access).not.toHaveBeenCalled();
  });
  it("releases the exact approved tuple once and returns the persisted receipt on replay", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) {
      const response = await f.request(`/${f.item.id}/release`, f.release);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: f.item.id,
        state: "released",
        receipt: { path: "~/Downloads/report.txt" },
      });
    }
    expect(f.place).toHaveBeenCalledOnce();
    await f.transfers.wait(f.parent);
  });
  it.each(["revision", "name", "bytes", "sha256", "to"])(
    "refuses a changed approval %s",
    async (field) => {
      const f = await fixture();
      const body = {
        ...f.release,
        [field]:
          field === "revision" || field === "bytes"
            ? 999
            : field === "sha256"
              ? "0".repeat(64)
              : "changed",
      };
      expect([400, 409]).toContain((await f.request(`/${f.item.id}/release`, body)).status);
      expect(f.place).not.toHaveBeenCalled();
      await f.transfers.wait(f.parent);
    },
  );
  it("discards only the exact revision and never invokes desktop access", async () => {
    const f = await fixture();
    expect((await f.request(`/${f.item.id}/discard`, { revision: 2 })).status).toBe(409);
    expect((await f.request(`/${f.item.id}/discard`, { revision: 1 })).status).toBe(200);
    expect(f.store.get(f.parent, f.item.id)?.state).toBe("discarded");
    expect(f.place).not.toHaveBeenCalled();
    expect(f.access).not.toHaveBeenCalled();
  });
  it("keeps a lost placement reply pending and reconciles the same transfer without another copy", async () => {
    const f = await fixture();
    f.place.mockRejectedValueOnce(new Error("uncertain reply"));
    expect((await f.request(`/${f.item.id}/release`, f.release)).status).toBe(503);
    const pending = f.store.get(f.parent, f.item.id);
    expect(pending?.state).toBe("releasing");
    expect((await f.request(`/${f.item.id}/release`, f.release)).status).toBe(200);
    expect(f.place.mock.calls[1]?.[0].transferId).toBe(f.place.mock.calls[0]?.[0].transferId);
    expect(f.place.mock.calls[1]?.[3]).toEqual({ reconcileOnly: true });
  });
  it("rejects cross-parent IDs, extra authority fields and oversized input before placement", async () => {
    const f = await fixture();
    expect((await f.request(`/${ulid()}/release`, f.release)).status).toBe(404);
    expect(
      (await f.request(`/${f.item.id}/release`, { ...f.release, token: "private" })).status,
    ).toBe(400);
    expect(
      (await f.request(`/${f.item.id}/release`, { ...f.release, name: "x".repeat(4096) })).status,
    ).toBe(413);
    expect(f.place).not.toHaveBeenCalled();
    expect(f.access).not.toHaveBeenCalled();
  });
});
