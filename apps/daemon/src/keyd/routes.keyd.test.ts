import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SecretBinding, sealPassphrase, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor } from "./monitor.ts";
import { passphraseRecord } from "./passphrase-record.ts";
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

describe.skipIf(!KEYD_TESTS)(
  "unlocking a passphrase vault from the app, against the real keyd",
  () => {
    const PASSPHRASE = `correct horse battery ${Date.now().toString(36)}`;
    let vaultHome: string;
    let daemonHome: string;
    let passphrase: KeydProcess;
    let unlockApp: ReturnType<typeof createApp>;
    beforeAll(async () => {
      vaultHome = mkdtempSync("/tmp/ld-keyd-");
      daemonHome = mkdtempSync(join(tmpdir(), "local dot's unlock-"));
      passphrase = await startKeyd({ home: vaultHome, vault: "passphrase" });
      const client = new KeydClient(passphrase.socketPath);
      unlockApp = createApp({
        token: TOKEN,
        port: PORT,
        eventLog: new EventLog(daemonHome),
        keys: {
          keyd: client,
          monitor: new KeydMonitor(client),
          passphrases: passphraseRecord(join(daemonHome, "passphrase-chosen")),
        },
      });
    });
    afterAll(async () => {
      await passphrase?.stop();
      rmSync(vaultHome, { recursive: true, force: true });
      rmSync(daemonHome, { recursive: true, force: true });
    });
    const health = async () =>
      (await (await unlockApp.request(url("/api/keyd"), { headers: json })).json()) as {
        sealKey: string;
        vault?: { state: string; key?: string; fingerprint?: string };
      };
    const unlock = (sealed: unknown) =>
      unlockApp.request(url("/api/keyd/unlock"), {
        method: "POST",
        headers: json,
        body: JSON.stringify({ sealed }),
      });

    it("chooses the first passphrase, then opens the vault keyd locks on restart", async () => {
      const fresh = await health();
      expect(fresh.vault?.state).toBe("setup");
      const chosen = await unlock(await sealPassphrase(fresh.sealKey, PASSPHRASE));
      expect(chosen.status).toBe(200);
      const { vault } = (await chosen.json()) as { vault: { fingerprint: string } };
      expect(vault).toMatchObject({ state: "ready", key: "passphrase" });
      expect(readFileSync(join(daemonHome, "passphrase-chosen"), "utf8").trim()).toBe(
        vault.fingerprint,
      );
      const saved = await unlockApp.request(url("/api/keys"), {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          binding: groq,
          sealed: await sealSecret(fresh.sealKey, groq, CANARY),
        }),
      });
      expect(saved.status).toBe(200);

      await passphrase.stop();
      passphrase = await startKeyd({ home: vaultHome, vault: "passphrase" });
      const locked = await health();
      expect(locked.vault).toMatchObject({ state: "locked", fingerprint: vault.fingerprint });
      const wrong = await unlock(await sealPassphrase(locked.sealKey, `${PASSPHRASE}!`));
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toMatchObject({ error: "wrong-passphrase" });
      // Sealed to the keyd before the restart: the page seals again.
      const stale = await unlock(await sealPassphrase(fresh.sealKey, PASSPHRASE));
      expect(stale.status).toBe(409);
      const opened = await unlock(await sealPassphrase(locked.sealKey, PASSPHRASE));
      expect(opened.status).toBe(200);
      expect((await health()).vault?.state).toBe("ready");
      const keys = await unlockApp.request(url("/api/keys"), { headers: json });
      expect(((await keys.json()) as { keys: { id: string }[] }).keys.map((k) => k.id)).toEqual([
        "groq",
      ]);
      for (const file of [...filesUnder(vaultHome), ...filesUnder(daemonHome)])
        expect(readFileSync(file, "latin1"), file).not.toContain(PASSPHRASE);
      expect(passphrase.stderr()).not.toContain(PASSPHRASE);
    });
  },
);
