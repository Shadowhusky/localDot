import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeydClient, KeydError, KeydUnavailableError } from "./client.ts";
import { FAKE_SEAL_KEY, type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const sealed = {
  v: 1 as const,
  epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  nonce: "AAECAwQFBgcICQoL",
  ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
};
const weather = {
  id: "weather",
  kind: "http" as const,
  hosts: ["api.example.test", "b.example.test"],
  header: "Authorization",
  format: "bearer" as const,
  methods: ["GET"],
  paths: ["/v1/a&b/"],
};

let keyd: FakeKeyd;
let client: KeydClient;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  client = new KeydClient(keyd.socketPath, 2000);
});
afterEach(async () => {
  await keyd.close();
});

describe("KeydClient", () => {
  it("talks only to a socket private to this user, and says why it refuses", async () => {
    chmodSync(keyd.socketPath, 0o666);
    const open = client.status();
    await expect(open).rejects.toBeInstanceOf(KeydUnavailableError);
    await expect(open).rejects.toThrow(/open to other users \(mode 666\)/);
    chmodSync(keyd.socketPath, 0o600);
    chmodSync(dirname(keyd.socketPath), 0o755);
    await expect(client.secrets()).rejects.toThrow(/open to other users \(mode 755\)/);
    await expect(client.events(() => {}, new AbortController().signal)).rejects.toThrow(/refusing/);
    chmodSync(dirname(keyd.socketPath), 0o700);
    expect((await client.status()).bootId).toBe(keyd.bootId);
    expect(keyd.calls.filter((c) => c.path !== "/v1/status")).toEqual([]);
  });

  it("reads keyd's status", async () => {
    const status = await client.status();
    expect(status).toMatchObject({
      bootId: keyd.bootId,
      sealKey: FAKE_SEAL_KEY,
      audit: { ok: true },
    });
  });

  it("relays a sealed secret with the binding unchanged and the id in the path only", async () => {
    const record = await client.putSecret(weather, sealed);
    expect(record).toMatchObject({ id: "weather", kind: "http", hosts: weather.hosts });
    const call = keyd.calls.at(-1);
    expect(call?.method).toBe("PUT");
    expect(call?.path).toBe("/v1/secrets/weather");
    const { id: _id, ...fields } = weather;
    expect(call?.body).toEqual({ ...fields, sealed });
    expect((await client.secrets()).map((r) => r.id)).toEqual(["weather"]);
  });

  it("turns keyd's error body into a KeydError with its code", async () => {
    keyd.failures.set("PUT /v1/secrets/", { status: 400, code: "bad-seal" });
    const err = await client.putSecret(weather, sealed).catch((e) => e);
    expect(err).toBeInstanceOf(KeydError);
    expect(err).toMatchObject({ status: 400, code: "bad-seal" });
  });

  it("opens, reads, revokes, mints and closes a cell", async () => {
    await client.putSecret(weather, sealed);
    const opened = await client.openCell({
      cellId: "c1",
      role: "desktop",
      port: 4791,
      secrets: ["weather"],
    });
    expect(opened.proxyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(opened.surrogates ?? {})).toEqual(["weather"]);
    expect((await client.cell("c1"))?.port).toBe(4791);
    expect(await client.revoke("c1")).toBe(1);
    expect(keyd.cells.get("c1")?.valid.has(opened.surrogates?.weather ?? "")).toBe(false);
    const minted = await client.mint("c1", ["weather"]);
    expect(minted.weather).not.toBe(opened.surrogates?.weather);
    expect(await client.closeCell("c1")).toBe(true);
    expect(await client.closeCell("c1")).toBe(false);
    expect(await client.cell("c1")).toBeUndefined();
  });

  it("refuses a reply that is not what keyd promises", async () => {
    keyd.failures.set("GET /v1/status", { status: 200, code: "x" });
    await expect(client.status()).rejects.toMatchObject({ code: "bad-reply" });
  });

  it("reports an offline keyd as unavailable, not as a crash", async () => {
    await keyd.stop();
    await expect(client.status()).rejects.toBeInstanceOf(KeydUnavailableError);
    const missing = new KeydClient("/tmp/ld-no-such-dir/keyd/admin.sock", 500);
    await expect(missing.secrets()).rejects.toMatchObject({ status: 0, code: "unavailable" });
  });

  it("streams events, drops unknown lines and ends when keyd restarts", async () => {
    const got: string[] = [];
    const ac = new AbortController();
    const done = client.events((e) => got.push(e.type), ac.signal);
    await waitFor(() => keyd.subscribers === 1);
    keyd.publish({
      type: "key.use",
      cell: "c1",
      time: "2026-10-01T12:00:00Z",
      data: {
        secretId: "weather",
        host: "api.example.test",
        method: "GET",
        path: "/v1",
        decision: "allow",
      },
    });
    keyd.publish({ type: "key.leak" } as never);
    keyd.publish({ type: "events.dropped", time: "t", data: { count: 2 } });
    await waitFor(() => got.length === 2);
    keyd.restart();
    await done;
    expect(got).toEqual(["key.use", "events.dropped"]);
  });

  it("ends the stream when its signal aborts", async () => {
    const ac = new AbortController();
    const done = client.events(() => {}, ac.signal);
    await waitFor(() => keyd.subscribers === 1);
    ac.abort();
    await done;
    await waitFor(() => keyd.subscribers === 0);
  });
});

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
