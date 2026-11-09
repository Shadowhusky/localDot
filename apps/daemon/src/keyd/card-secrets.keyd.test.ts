import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type SecretBinding, sealPassphrase, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toolHarness } from "../agent/testing/harness.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor, vaultLocked } from "./monitor.ts";
import { ServiceKeys } from "./service-keys.ts";
import { KEYD_TESTS, type KeydProcess, startKeyd } from "./testing/keyd-process.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const json = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const SECRET = `real-secret-value-for-test-${Date.now().toString(36)}`;
const PASSPHRASE = `correct horse battery ${Date.now().toString(36)}`;
const weather: SecretBinding = {
  id: "weather",
  kind: "http",
  hosts: ["api.weather.example"],
  header: "authorization",
  format: "bearer",
};

const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile());

describe.skipIf(!KEYD_TESTS)("a task's unlock card, against the real keyd", () => {
  let vaultHome: string;
  let daemonHome: string;
  let keyd: KeydProcess;
  let monitor: KeydMonitor;
  let client: KeydClient;
  let app: ReturnType<typeof createApp>;
  const start = async () => {
    keyd = await startKeyd({ home: vaultHome, vault: "passphrase" });
    client = new KeydClient(keyd.socketPath);
    monitor = new KeydMonitor(client);
    app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog: new EventLog(daemonHome),
      keys: { keyd: client, monitor },
    });
  };
  const health = async () =>
    (await (await app.request(url("/api/keyd"), { headers: json })).json()) as { sealKey: string };
  beforeAll(async () => {
    vaultHome = mkdtempSync("/tmp/ld-keyd-");
    daemonHome = mkdtempSync("/tmp/ld-card-");
    await start();
    const { sealKey } = await health();
    const chose = await app.request(url("/api/keyd/unlock"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sealed: await sealPassphrase(sealKey, PASSPHRASE) }),
    });
    expect(chose.status).toBe(200);
    const saved = await app.request(url("/api/keys"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        binding: weather,
        sealed: await sealSecret(sealKey, weather, SECRET),
      }),
    });
    expect(saved.status).toBe(200);
    await keyd.stop();
    await start();
  });
  afterAll(async () => {
    await keyd?.stop();
    rmSync(vaultHome, { recursive: true, force: true });
    rmSync(daemonHome, { recursive: true, force: true });
  });

  it("raises from keyd's real refusal, opens from the real unlock, and keeps nothing typed", async () => {
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
    ];
    const h = toolHarness();
    try {
      await monitor.refresh();
      expect(vaultLocked(monitor.health)).toBe(true);
      h.tools.keysLocked = () => vaultLocked(monitor.health);
      h.tools.credentials = new ServiceKeys({
        keyd: client,
        ports: { reserve: () => 4797, release: () => {} },
      });
      // As the runner hears the vault open.
      monitor.subscribe((now) => {
        if (now.online && !vaultLocked(now)) h.session.keysUnlocked();
      });

      const { body } = await h.call("api_request", {
        key_id: "weather",
        url: "https://api.weather.example/today",
      });
      expect(JSON.stringify(body)).toContain("423");
      const raised = h.events().filter((event) => event.type === "blocker.raise");
      expect(raised.map((event) => event.data.blocker)).toEqual([{ kind: "keys_locked" }]);
      const told = h.session.inboxSequence;

      const { sealKey } = await health();
      const sealed = await sealPassphrase(sealKey, PASSPHRASE);
      const opened = await app.request(url("/api/keyd/unlock"), {
        method: "POST",
        headers: json,
        body: JSON.stringify({ sealed }),
      });
      expect(opened.status).toBe(200);
      expect(h.session.keysLocked).toBe(false);
      expect(h.events().filter((event) => event.type === "blocker.clear")).toHaveLength(1);
      expect(h.session.inboxSequence).toBe(told + 1);

      const printed = JSON.stringify(logged.map((spy) => spy.mock.calls));
      const said = (await h.session.inbox(0, 0)).items.map((item) => item.text).join("\n");
      for (const secret of [PASSPHRASE, SECRET, sealed.ct]) {
        expect(JSON.stringify(h.events())).not.toContain(secret);
        expect(said).not.toContain(secret);
        expect(printed).not.toContain(secret);
        expect(keyd.stderr()).not.toContain(secret);
        for (const file of [...filesUnder(h.home), ...filesUnder(daemonHome)])
          expect(readFileSync(file, "latin1"), file).not.toContain(secret);
      }
    } finally {
      h.close();
      for (const spy of logged) spy.mockRestore();
    }
  });
});
