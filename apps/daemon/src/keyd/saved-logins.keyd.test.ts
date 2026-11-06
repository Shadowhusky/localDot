import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealLogin, sealLoginImport, sealPassphrase } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { KeydClient } from "./client.ts";
import { KeydMonitor } from "./monitor.ts";
import { KEYD_TESTS, type KeydProcess, startKeyd } from "./testing/keyd-process.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const json = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const STAMP = Date.now().toString(36);
const PASSWORD = `canary-export-password-${STAMP}`;
const ACCOUNT = `canary-export-account-${STAMP}@example.com`;
const NOTE = `canary-export-note-${STAMP}`;
const BROKEN = `canary-export-broken-${STAMP}`;
const TYPED = `canary-typed-password-${STAMP}`;
const CANARIES = [PASSWORD, NOTE, BROKEN, TYPED];

const EXPORT = new TextEncoder().encode(
  [
    "name,url,username,password,note",
    `Site,https://site.example.com/login,${ACCOUNT},${PASSWORD},${NOTE}`,
    `Plain,http://plain.example.com,${ACCOUNT},${PASSWORD},${NOTE}`,
    `Twice,https://site.example.com/other,${ACCOUNT},${PASSWORD},${NOTE}`,
    `Empty,https://empty.example.com,${ACCOUNT},,${NOTE}`,
    `Broken,https://broken.example.com,${ACCOUNT},"${BROKEN}`,
  ].join("\n"),
);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile());
}

// The whole route down to keyd's strict decoding, seal and vault; what proves the file reaches only
// keyd is that its values turn up nowhere else, whichever way it went.
describe.skipIf(!KEYD_TESTS)("saved logins through the daemon, against the real keyd", () => {
  let keyd: KeydProcess;
  let keydHome: string;
  let home: string;
  let client: KeydClient;
  let app: ReturnType<typeof createApp>;
  const logged: string[] = [];
  const seen: string[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const reply = await app.request(url(path), { headers: json, ...init });
    const text = await reply.text();
    seen.push(text);
    return { status: reply.status, text, json: () => JSON.parse(text) };
  };
  const sealKey = async () => (await client.status()).sealKey;

  beforeAll(async () => {
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        logged.push(args.map(String).join(" "));
      });
    keydHome = mkdtempSync("/tmp/ld-keyd-");
    keyd = await startKeyd({ home: keydHome, vault: "passphrase" });
    client = new KeydClient(keyd.socketPath);
    home = mkdtempSync(join(tmpdir(), "local dot's logins-"));
    app = createApp({
      token: TOKEN,
      port: PORT,
      eventLog: new EventLog(home),
      keys: { keyd: client, monitor: new KeydMonitor(client) },
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await keyd?.stop();
    rmSync(keydHome, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("says it takes saved logins, and takes none until the vault is unlocked", async () => {
    expect((await client.status()).savedLogins).toBe(true);
    const sealed = await sealLoginImport(await sealKey(), EXPORT);
    const locked = await request("/api/logins/import", {
      method: "POST",
      body: JSON.stringify({ sealed }),
    });
    expect(locked.status).toBe(423);
    await client.unlockVault(await sealPassphrase(await sealKey(), `passphrase-${STAMP}`));
  });

  it("imports an export sealed in the page, and answers in counts and line numbers", async () => {
    const sealed = await sealLoginImport(await sealKey(), EXPORT);
    const reply = await request("/api/logins/import", {
      method: "POST",
      body: JSON.stringify({ sealed }),
    });
    expect(reply.status).toBe(200);
    expect(reply.json()).toMatchObject({ rows: 5, imported: 1, alreadySaved: 0 });
    const reasons = Object.fromEntries(
      (reply.json().skipped as { reason: string; lines: number[] }[]).map((skip) => [
        skip.reason,
        skip.lines,
      ]),
    );
    expect(reasons).toEqual({
      "no-password": [5],
      "not-https": [3],
      "same-site": [4],
      unreadable: [6],
    });
    expect(reply.text).not.toContain("example.com");
    const again = await request("/api/logins/import", {
      method: "POST",
      body: JSON.stringify({ sealed: await sealLoginImport(await sealKey(), EXPORT) }),
    });
    expect(again.json()).toMatchObject({ imported: 0, alreadySaved: 1 });
  });

  it("lists sites and accounts, never a password, and keeps the login to its own site", async () => {
    const list = await request("/api/logins");
    expect(list.json()).toEqual({
      logins: [{ origin: "https://site.example.com", username: ACCOUNT, confirm: true }],
    });
    expect((await client.login("https://site.example.com"))?.password).toBe(PASSWORD);
    for (const origin of [
      "https://sub.site.example.com",
      "https://site.example.com.evil.test",
      "https://site.example.com:8443",
    ]) {
      expect(await client.findLogin(origin)).toBeUndefined();
      expect(await client.login(origin)).toBeUndefined();
    }
  });

  it("adds, edits and removes a login only as ciphertext", async () => {
    const plain = await request("/api/logins", {
      method: "POST",
      body: JSON.stringify({
        origin: "https://typed.example.com",
        username: "a",
        password: TYPED,
      }),
    });
    expect(plain.status).toBe(400);
    const add = await request("/api/logins", {
      method: "POST",
      body: JSON.stringify({
        sealed: await sealLogin(await sealKey(), {
          origin: "https://typed.example.com",
          username: "typed-account",
          password: TYPED,
        }),
      }),
    });
    expect(add.json()).toEqual({
      login: { origin: "https://typed.example.com", username: "typed-account", confirm: true },
    });
    const edit = await request("/api/logins", {
      method: "POST",
      body: JSON.stringify({
        sealed: await sealLogin(await sealKey(), {
          origin: "https://typed.example.com",
          username: "renamed-account",
        }),
      }),
    });
    expect(edit.json().login.username).toBe("renamed-account");
    expect(await client.login("https://typed.example.com")).toEqual({
      username: "renamed-account",
      password: TYPED,
      confirm: true,
    });
    const gone = await request(`/api/logins/${encodeURIComponent("https://typed.example.com")}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect(await client.findLogin("https://typed.example.com")).toBeUndefined();
    const refused = await request(`/api/logins/${encodeURIComponent("http://typed.example.com")}`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(400);
  });

  it("refuses a file that isn't an export without quoting any of it", async () => {
    const sealed = await sealLoginImport(
      await sealKey(),
      new TextEncoder().encode(`a,b\n${PASSWORD},${NOTE}\n`),
    );
    const reply = await request("/api/logins/import", {
      method: "POST",
      body: JSON.stringify({ sealed }),
    });
    expect(reply.status).toBe(400);
    expect(reply.json().error).toBe("not-an-export");
  });

  it("leaves no value in a reply, a log, the event log, keyd's files or its stderr", async () => {
    const wrote = [...filesUnder(home), ...filesUnder(keydHome)].flatMap((file) => {
      try {
        return [readFileSync(file, "latin1")];
      } catch {
        return [];
      }
    });
    const everywhere = [...seen, ...logged, keyd.stderr(), ...wrote];
    expect(wrote.length).toBeGreaterThan(0);
    for (const text of everywhere)
      for (const canary of CANARIES) expect(text.includes(canary)).toBe(false);
    // The account shows in the list the user asked for and nowhere that keeps it.
    for (const text of [...logged, keyd.stderr(), ...wrote])
      expect(text.includes(ACCOUNT)).toBe(false);
  });
});
