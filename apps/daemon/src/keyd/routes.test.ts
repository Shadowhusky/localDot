import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor } from "./monitor.ts";
import { FAKE_SEAL_KEY, type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const json = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const sealed = {
  v: 1,
  epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  nonce: "AAECAwQFBgcICQoL",
  ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
};
const binding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test", "b.example.test"],
  header: "Authorization",
  format: "bearer",
  methods: ["GET"],
  paths: ["/v1/a&b/"],
};

let keyd: FakeKeyd;
let app: ReturnType<typeof createApp>;
let changed: string[];
let client: KeydClient;
let home: string;
let afterChange: (id: string) => Promise<{ restart: boolean }>;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  changed = [];
  client = new KeydClient(keyd.socketPath, 1000);
  home = mkdtempSync(join(tmpdir(), "local dot's keys-"));
  const eventLog = new EventLog(home);
  afterChange = async (id: string) => {
    changed.push(id);
    return { restart: id === "weather" };
  };
  app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    keys: { keyd: client, monitor: new KeydMonitor(client), afterChange: (id) => afterChange(id) },
  });
});
afterEach(async () => {
  await keyd.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const post = (body: unknown) =>
  app.request(url("/api/keys"), { method: "POST", headers: json, body: JSON.stringify(body) });

describe("key routes", () => {
  it("need the install token", async () => {
    for (const [method, path] of [
      ["GET", "/api/keyd"],
      ["GET", "/api/keys"],
      ["POST", "/api/keys"],
      ["DELETE", "/api/keys/weather"],
    ] as const) {
      expect((await app.request(url(path), { method })).status).toBe(401);
      expect(
        (
          await app.request(url(path), {
            method,
            headers: { ...json, origin: "https://attacker.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`http://attacker.example:${PORT}${path}`, {
            method,
            headers: json,
          })
        ).status,
      ).toBe(403);
    }
    expect(keyd.calls).toHaveLength(0);
  });

  it("report keyd's health with its seal key, audit state and hairpin guard", async () => {
    keyd.auditOk = false;
    const res = await app.request(url("/api/keyd"), { headers: json });
    expect(await res.json()).toEqual({
      online: true,
      bootId: keyd.bootId,
      sealKey: FAKE_SEAL_KEY,
      audit: { ok: false, error: "disk full" },
      hairpin: { state: "active", source: "nat-pmp", addresses: 1 },
      reenter: 0,
      rebound: 0,
    });
    keyd.hairpin = { state: "unknown", addresses: 0, error: "nat-pmp: timeout" };
    const unknown = await app.request(url("/api/keyd"), { headers: json });
    expect(((await unknown.json()) as { hairpin: unknown }).hairpin).toEqual(keyd.hairpin);
  });

  it("relay a sealed key to keyd byte for byte, the id in the path", async () => {
    const res = await post({ binding, sealed });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: { id: "weather", kind: "http" }, restart: true });
    expect(changed).toEqual(["weather"]);
    const call = keyd.calls.find((c) => c.method === "PUT");
    const { id: _id, ...fields } = binding;
    expect(call?.path).toBe("/v1/secrets/weather");
    expect(call?.body).toEqual({ ...fields, sealed });
    const list = await app.request(url("/api/keys"), { headers: json });
    expect(((await list.json()) as { keys: { id: string }[] }).keys.map((k) => k.id)).toEqual([
      "weather",
    ]);
  });

  it("refuse plaintext: a value field, or anything but a sealed key, never reaches keyd", async () => {
    for (const body of [
      { binding, sealed, value: "real-secret-value-for-test" },
      { binding: { ...binding, value: "real-secret-value-for-test" }, sealed },
      { binding, value: "real-secret-value-for-test" },
      { binding, sealed: { ...sealed, plain: "real-secret-value-for-test" } },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(
      (await app.request(url("/api/keys"), { method: "POST", headers: json, body: "not json" }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(url("/api/keys"), {
          method: "POST",
          headers: json,
          body: "x".repeat(70_000),
        })
      ).status,
    ).toBe(413);
    expect(keyd.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("bounds chunked bodies and counts UTF-8 bytes, not characters", async () => {
    const body = new ReadableStream({
      start(controller) {
        const chunk = new TextEncoder().encode("é".repeat(20_000));
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await app.request(
      new Request(url("/api/keys"), {
        method: "POST",
        headers: json,
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too-large" });
    expect(keyd.calls).toHaveLength(0);
  });

  it("serializes conflicting saves so only one environment name is assigned", async () => {
    vi.spyOn(client, "secrets").mockImplementation(async () => [...keyd.records.values()]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = client.putSecret.bind(client);
    vi.spyOn(client, "putSecret").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return put(...args);
    });
    const first = post({ binding: { ...binding, id: "weather-api" }, sealed });
    await entered.promise;
    const second = post({ binding: { ...binding, id: "weather_api" }, sealed });
    await nextTurn();
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status)).toEqual([200, 409]);
    expect([...keyd.records.keys()]).toEqual(["weather-api"]);
    expect(changed).toEqual(["weather-api"]);
  });

  it("finishes a change notification before deleting and allows replacing the same name", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    afterChange = async (id) => {
      changed.push(id);
      if (changed.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return { restart: false };
    };
    const saving = post({ binding, sealed });
    await entered.promise;
    const deleting = app.request(url("/api/keys/weather"), { method: "DELETE", headers: json });
    await nextTurn();
    expect(keyd.records.has("weather")).toBe(true);
    release.resolve();
    expect((await saving).status).toBe(200);
    expect((await deleting).status).toBe(204);
    expect((await post({ binding, sealed })).status).toBe(200);
    expect((await post({ binding, sealed })).status).toBe(200);
    expect(keyd.records.size).toBe(1);
  });

  it("does not poison later changes after a failed save", async () => {
    keyd.failures.set("PUT /v1/secrets/", { status: 500, code: "vault" });
    expect((await post({ binding, sealed })).status).toBe(502);
    expect(changed).toHaveLength(0);
    expect((await post({ binding, sealed })).status).toBe(200);
    expect(changed).toEqual(["weather"]);
  });

  it("reports a saved key as needing a restart if refreshing computers fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    afterChange = async () => {
      throw new Error("sensitive-refresh-diagnostic");
    };
    const res = await post({ binding, sealed });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key: { id: "weather" }, restart: true });
    expect(keyd.records.has("weather")).toBe(true);
    expect(
      (await app.request(url("/api/keys/weather"), { method: "DELETE", headers: json })).status,
    ).toBe(204);
    expect(keyd.records.has("weather")).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-refresh-diagnostic");
  });

  it("map keyd's refusals to what the form can act on", async () => {
    keyd.failures.set("PUT /v1/secrets/", { status: 400, code: "bad-seal" });
    expect((await post({ binding, sealed })).status).toBe(409);
    keyd.failures.set("PUT /v1/secrets/", { status: 400, code: "bad-binding" });
    const bad = await post({ binding, sealed });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad-binding" });
    keyd.failures.set("PUT /v1/secrets/", { status: 500, code: "vault" });
    expect((await post({ binding, sealed })).status).toBe(502);
    keyd.failures.set("PUT /v1/secrets/", { status: 423, code: "vault-locked" });
    const locked = await post({ binding, sealed });
    expect(locked.status).toBe(423);
    expect(await locked.json()).toEqual({
      error: "vault-locked",
      message: "Saved keys are locked. On that computer, run: localdot unlock",
    });
  });

  it("refuse a name whose variable another key's stand-in already has", async () => {
    keyd.records.set("weather_api", {
      id: "weather_api",
      kind: "http",
      createdAt: "t",
      updatedAt: "t",
    });
    const res = await post({ binding: { ...binding, id: "weather-api" }, sealed });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "name-taken",
      message: expect.stringContaining("LOCALDOT_KEY_WEATHER_API"),
    });
    expect(keyd.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  it("delete a key by a valid name only", async () => {
    await post({ binding, sealed });
    expect(
      (await app.request(url("/api/keys/weather"), { method: "DELETE", headers: json })).status,
    ).toBe(204);
    expect(changed).toEqual(["weather", "weather"]);
    expect(
      (await app.request(url("/api/keys/weather"), { method: "DELETE", headers: json })).status,
    ).toBe(404);
    expect(changed).toHaveLength(2);
    expect(
      (await app.request(url("/api/keys/..%2Fx"), { method: "DELETE", headers: json })).status,
    ).toBe(400);
  });

  it("still removes a key whose name was reserved after it was added", async () => {
    const at = "2026-10-01T00:00:00Z";
    keyd.records.set("webpush-vapid", {
      id: "webpush-vapid",
      kind: "http",
      hosts: ["api.example.test"],
      header: "Authorization",
      format: "bearer",
      createdAt: at,
      updatedAt: at,
    });
    const res = await app.request(url("/api/keys/webpush-vapid"), {
      method: "DELETE",
      headers: json,
    });
    expect(res.status).toBe(204);
    expect(keyd.records.has("webpush-vapid")).toBe(false);
  });

  it("say the key layer is offline when keyd is not running", async () => {
    await keyd.stop();
    const res = await app.request(url("/api/keys"), { headers: json });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "key-layer-offline" });
    expect(await (await app.request(url("/api/keyd"), { headers: json })).json()).toMatchObject({
      online: false,
    });
  });
});

describe("KeydMonitor", () => {
  it("tells listeners when keyd goes away and comes back with a new boot", async () => {
    const client = new KeydClient(keyd.socketPath, 500);
    const monitor = new KeydMonitor(client);
    const seen: string[] = [];
    monitor.subscribe((now, before) =>
      seen.push(`${before.online}->${now.online}:${now.bootId ?? "-"}`),
    );
    const first = keyd.bootId;
    await monitor.refresh();
    await keyd.stop();
    await monitor.refresh();
    keyd.restart();
    await keyd.start();
    await monitor.refresh();
    await monitor.refresh();
    expect(seen).toEqual([`false->true:${first}`, "true->false:-", `false->true:${keyd.bootId}`]);
    expect(keyd.bootId).not.toBe(first);
  });
});
