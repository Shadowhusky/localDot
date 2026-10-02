import { readdirSync } from "node:fs";
import { request } from "node:http";
import { type KeydEvent, type SecretBinding, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeydClient } from "./client.ts";
import {
  KEYD_TESTS,
  type KeydProcess,
  startKeyd,
  TEST_KEYD_PORTS,
} from "./testing/keyd-process.ts";

const CANARY = `real-secret-value-for-test-${Date.now().toString(36)}`;
const weather: SecretBinding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test"],
  header: "Authorization",
  format: "bearer",
};
const CELL = "01JXYZ0000000000000000ABCD";

let keyd: KeydProcess;
let client: KeydClient;

// A plain-HTTP request through a cell's listener, as a cell's tools send one.
function throughListener(port: number, token: string, headers: Record<string, string>) {
  return new Promise<{ status: number; reason: string | undefined }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "http://example.com/",
        headers: {
          host: "example.com",
          "proxy-authorization": `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`,
          ...headers,
        },
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          reason: res.headers["x-keyd-reason"] as string | undefined,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!KEYD_TESTS)("KeydClient against the real keyd", () => {
  beforeAll(async () => {
    keyd = await startKeyd();
    client = new KeydClient(keyd.socketPath);
  });
  afterAll(async () => {
    await keyd?.stop();
  });

  it("stores a key the browser sealed, and keyd refuses it under another binding", async () => {
    const status = await client.status();
    expect(status.bootId).toBe(keyd.bootId);
    const sealed = await sealSecret(status.sealKey, weather, CANARY);
    const tampered = { ...weather, hosts: ["api.example.test", "attacker.example"] };
    await expect(client.putSecret(tampered, sealed)).rejects.toMatchObject({
      status: 400,
      code: "bad-seal",
    });
    const record = await client.putSecret(weather, sealed);
    expect(record).toMatchObject({ id: "weather", kind: "http", hosts: ["api.example.test"] });
    const listed = await client.secrets();
    expect(listed.map((r) => r.id)).toEqual(["weather"]);
    expect(JSON.stringify(listed)).not.toContain(CANARY);
  });

  it("opens a desktop cell, alerts on a misplaced surrogate, revokes and closes", async () => {
    const events: KeydEvent[] = [];
    const ac = new AbortController();
    const stream = client.events((e) => events.push(e), ac.signal);
    const opened = await client.openCell({
      cellId: CELL,
      role: "desktop",
      port: TEST_KEYD_PORTS.from,
      secrets: ["weather"],
    });
    const surrogate = opened.surrogates?.weather ?? "";
    expect(surrogate).toMatch(/^ld_/);
    expect((await client.cell(CELL))?.intercepts).toEqual(["api.example.test"]);

    const misplaced = await throughListener(opened.port, opened.proxyToken, {
      "x-leak": surrogate,
    });
    expect(misplaced).toEqual({ status: 403, reason: "misplaced-surrogate" });
    const noToken = await throughListener(opened.port, "x".repeat(43), {});
    expect(noToken.status).toBe(407);

    await waitFor(() => events.some((e) => e.type === "key.use"));
    expect(events.find((e) => e.type === "key.use")).toMatchObject({
      cell: CELL,
      data: { secretId: "weather", host: "example.com", method: "GET", decision: "deny" },
    });
    expect(JSON.stringify(events)).not.toContain(surrogate);

    expect(await client.revoke(CELL)).toBe(1);
    expect(await throughListener(opened.port, opened.proxyToken, { "x-leak": surrogate })).toEqual({
      status: 403,
      reason: "unknown-surrogate",
    });
    const fresh = await client.mint(CELL, ["weather"]);
    expect(fresh.weather).toMatch(/^ld_/);
    expect(fresh.weather).not.toBe(surrogate);
    expect(await client.closeCell(CELL)).toBe(true);
    expect(await client.cell(CELL)).toBeUndefined();
    ac.abort();
    await stream;
  });

  it("forgets a deleted key", async () => {
    expect(await client.deleteSecret("weather")).toBe(true);
    expect(await client.deleteSecret("weather")).toBe(false);
    expect(await client.secrets()).toEqual([]);
  });

  it("rejects a missing executable and cleans up its owned home", async () => {
    const homes = () =>
      readdirSync("/tmp")
        .filter((name) => name.startsWith(`ld-keyd-${process.pid}-`))
        .sort();
    const before = homes();
    const binary = process.env.LOCALDOT_KEYD_BIN;
    process.env.LOCALDOT_KEYD_BIN = "/tmp/localdot-no-such-keyd-executable";
    try {
      await expect(startKeyd()).rejects.toThrow("keyd could not start");
      expect(homes()).toEqual(before);
    } finally {
      if (binary === undefined) delete process.env.LOCALDOT_KEYD_BIN;
      else process.env.LOCALDOT_KEYD_BIN = binary;
    }
  });
});

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
