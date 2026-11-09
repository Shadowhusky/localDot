import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Sealed, sealPassphrase } from "@localdot/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSession } from "../agent/session.ts";
import { toolHarness } from "../agent/testing/harness.ts";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor, vaultLocked } from "./monitor.ts";
import { FAKE_SEAL_KEY, type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const PASSPHRASE = "CANARY-correct-horse-battery";
const KEY_VALUE = "CANARY-sk-replacement-value";
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

let keyd: FakeKeyd;
let home: string;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  home = mkdtempSync(join(tmpdir(), "local dot's cards-"));
});
afterEach(async () => {
  await keyd.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Everything localDot keeps of a task on disk: its event log and transcript among them.
function kept(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? kept(path) : readFileSync(path, "latin1");
    })
    .join("\n");
}

// A secret typed into a card goes to keyd, sealed in the page; the daemon relays ciphertext, and
// nothing of it, sealed or not, lands in what the task keeps or says.
it("nothing typed into a card reaches the log, the transcript, dot or the daemon's own log", async () => {
  const logged = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "error"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "debug"),
  ];
  keyd.vault = { backend: "file", state: "locked", key: "passphrase" };
  const client = new KeydClient(keyd.socketPath, 1000);
  const monitor = new KeydMonitor(client);
  const eventLog = new EventLog(home);
  const app = createApp({
    token: TOKEN,
    port: PORT,
    eventLog,
    keys: { keyd: client, monitor },
  });
  const id = eventLog.createSession("task");
  const session = new AgentSession(id, "01M6R97SHHND5784EZZXSYSBGD", "task", eventLog);
  session.beginBrain();
  monitor.subscribe((now) => {
    if (now.online && !vaultLocked(now)) session.keysUnlocked();
  });
  await monitor.refresh();
  const start = session.inboxSequence;

  session.lockKeys();
  session.raiseBlocker({ kind: "key", id: "weather", problem: "rejected" });

  const sealedPassphrase: Sealed = await sealPassphrase(FAKE_SEAL_KEY, PASSPHRASE);
  const unlocked = await app.request(url("/api/keyd/unlock"), {
    method: "POST",
    headers,
    body: JSON.stringify({ sealed: sealedPassphrase }),
  });
  expect(unlocked.status).toBe(200);
  expect(session.keysLocked).toBe(false);

  const sealedKey = { alg: "x25519-hkdf-aes-256-gcm", epk: "a", nonce: "b", ct: "CANARYcipher" };
  await app.request(url("/api/keys"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      binding: {
        id: "weather",
        kind: "http",
        hosts: ["api.weather.example"],
        header: "x-key",
        format: "raw",
      },
      sealed: sealedKey,
    }),
  });
  session.clearBlockers((blocker) => blocker.kind === "key");

  const said = (await session.inbox(start, 0)).items.map((item) => item.text).join("\n");
  const log = JSON.stringify(eventLog.read(id));
  const onDisk = kept(home);
  const printed = JSON.stringify(logged.map((spy) => spy.mock.calls));
  for (const secret of [PASSPHRASE, KEY_VALUE, sealedPassphrase.ct, sealedKey.ct])
    for (const [where, text] of Object.entries({ said, log, onDisk, printed }))
      expect(text, `${where} holds a secret`).not.toContain(secret);
  // What the card left behind: that it was raised and that it went.
  expect(log).toContain("blocker.raise");
  expect(log).toContain("blocker.clear");
  session.stop();
  eventLog.close();
});

// dot's own call can't carry one either: only the kind and an id get through to the event.
it("what dot sends with request_fix goes nowhere", async () => {
  const h = toolHarness();
  try {
    h.tools.keysLocked = () => true;
    const reply = h.call("request_fix", {
      kind: "keys_locked",
      passphrase: PASSPHRASE,
      value: KEY_VALUE,
    });
    for (let i = 0; i < 2000 && !h.session.openBlockers.length; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.session.openBlockers).toHaveLength(1);
    h.session.useBlocker(h.session.openBlockers[0]?.blockerId ?? "");
    h.session.keysUnlocked();
    const { body } = await reply;
    const everything = JSON.stringify([h.events(), body]);
    expect(everything).not.toContain(PASSPHRASE);
    expect(everything).not.toContain(KEY_VALUE);
  } finally {
    h.close();
  }
});
