import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretBinding, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor } from "./monitor.ts";
import { KEYD_TESTS, type KeydProcess, startKeyd } from "./testing/keyd-process.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const json = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const CANARY = `real-secret-value-for-test-${Date.now().toString(36)}`;
const groq: SecretBinding = {
  id: "groq",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: new URL("https://api.groq.com/openai/v1").href,
};

let keyd: KeydProcess;
let keydHome: string;
let home: string;
let app: ReturnType<typeof createApp>;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

describe.skipIf(!KEYD_TESTS)("the key form's routes against the real keyd", () => {
  beforeAll(async () => {
    keydHome = mkdtempSync("/tmp/ld-keyd-");
    keyd = await startKeyd({ home: keydHome });
    const client = new KeydClient(keyd.socketPath);
    home = mkdtempSync(join(tmpdir(), "local dot's keys-"));
    app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog: new EventLog(home),
      keys: { keyd: client, monitor: new KeydMonitor(client) },
    });
  });
  afterAll(async () => {
    await keyd?.stop();
    rmSync(keydHome, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("stores a key sealed to keyd's boot key, which only keyd can open", async () => {
    const health = (await (await app.request(url("/api/keyd"), { headers: json })).json()) as {
      sealKey: string;
    };
    const sealed = await sealSecret(health.sealKey, groq, CANARY);
    const moved = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        binding: { ...groq, baseURL: "https://attacker.example/v1" },
        sealed,
      }),
    });
    expect(moved.status).toBe(409);
    const stored = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ binding: groq, sealed }),
    });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      key: { id: "groq", kind: "llm", provider: "openai-compatible" },
      restart: false,
    });
    const keys = (await (await app.request(url("/api/keys"), { headers: json })).json()) as {
      keys: unknown[];
    };
    expect(JSON.stringify(keys)).not.toContain(CANARY);
    for (const file of filesUnder(home))
      expect(readFileSync(file, "latin1"), file).not.toContain(CANARY);
  });

  it("refuses a seal made for an earlier keyd", async () => {
    const health = (await (await app.request(url("/api/keyd"), { headers: json })).json()) as {
      sealKey: string;
    };
    const sealed = await sealSecret(health.sealKey, groq, CANARY);
    await keyd.stop();
    keyd = await startKeyd({ home: keydHome });
    const res = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ binding: groq, sealed }),
    });
    expect(res.status).toBe(409);
  });
});
