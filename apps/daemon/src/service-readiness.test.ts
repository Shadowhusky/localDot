import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceReadinessReply } from "../../../packages/protocol/src/install-services.ts";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";
import { ManagedServiceReadiness, managedServiceFromEnv } from "./service-readiness.ts";

const identity = {
  ownerId: "e".repeat(32),
  release: { version: "1.2.3", packageSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
};
const keyd = () => ({
  service: { ...structuredClone(identity), pid: 42 },
  bootId: "keyd-boot-1",
  version: "0.1.0",
  sealKey: "a".repeat(87),
  cells: 0,
  secrets: 0,
  limits: { perTaskUSD: 1, perDayUSD: 2 },
  day: { date: "2026-10-07", spentUSD: 0 },
  audit: { ok: true },
  hairpin: { state: "active", addresses: 1 },
});
function fixture() {
  const read = vi.fn(async (): Promise<unknown> => keyd());
  const recoveredFor = vi.fn((_bootId: string) => true);
  const readiness = new ManagedServiceReadiness(identity, read, recoveredFor, 41);
  return { read, recoveredFor, readiness };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("distinguishes unmanaged mode from a malformed managed identity", () => {
  expect(managedServiceFromEnv({})).toBeNull();
  expect(managedServiceFromEnv({ LOCALDOT_SERVICE_IDENTITY: JSON.stringify(identity) })).toEqual(
    identity,
  );
  for (const raw of [
    "",
    "null",
    "[]",
    "{}",
    " ".repeat(1025),
    JSON.stringify({ ...identity, foreign: true }),
  ])
    expect(() => managedServiceFromEnv({ LOCALDOT_SERVICE_IDENTITY: raw })).toThrow(
      /^Invalid installed service identity\.$/,
    );
});
it("cannot report readiness until the entire startup promise succeeds", async () => {
  const { readiness } = fixture(),
    work = deferred();
  expect((await readiness.snapshot()).ready).toBe(false);
  const starting = readiness.runStartup(() => work.promise);
  expect(await readiness.snapshot()).toMatchObject({ recovery: "starting", ready: false });
  work.resolve();
  await starting;
  const result = await readiness.snapshot();
  expect(result).toMatchObject({
    recovery: "ready",
    ready: true,
    service: { pid: 41 },
    keyd: { service: { pid: 42 } },
  });
  expect(ServiceReadinessReply.safeParse(result).success).toBe(true);
  await expect(readiness.runStartup(async () => {})).rejects.toThrow("already attempted");
  result.service.ownerId = "f".repeat(32);
  expect((await readiness.snapshot()).service.ownerId).toBe(identity.ownerId);
});
it("failed recovery stays failed even when keyd is healthy", async () => {
  const { readiness } = fixture();
  await expect(
    readiness.runStartup(async () => {
      throw new Error("recovery");
    }),
  ).rejects.toThrow("recovery");
  expect(await readiness.snapshot()).toMatchObject({ recovery: "failed", ready: false });
  await expect(readiness.runStartup(async () => {})).rejects.toThrow();
});
it("requires completed admission recovery for the freshly observed keyd boot", async () => {
  const { read, recoveredFor, readiness } = fixture();
  recoveredFor.mockImplementation((bootId) => bootId === "keyd-boot-1");
  await readiness.runStartup(async () => {});
  expect((await readiness.snapshot()).ready).toBe(true);
  read.mockResolvedValue({ ...keyd(), bootId: "keyd-boot-2" });
  expect(await readiness.snapshot()).toMatchObject({ ready: false, checks: { admission: false } });
  recoveredFor.mockReturnValue(true);
  expect((await readiness.snapshot()).ready).toBe(true);
  recoveredFor.mockReturnValue(false);
  expect((await readiness.snapshot()).ready).toBe(false);
});
it.each(["success", "failure"])("shutdown wins over late startup %s", async (kind) => {
  const { readiness } = fixture(),
    work = deferred();
  const startup = readiness
    .runStartup(async () => {
      await work.promise;
      if (kind === "failure") throw new Error("failed");
    })
    .catch(() => {});
  readiness.stopping();
  work.resolve();
  await startup;
  expect(await readiness.snapshot()).toMatchObject({ recovery: "stopping", ready: false });
});
it.each([
  "legacy",
  "owner",
  "version",
  "package",
  "manifest",
  "pid",
  "audit",
  "hairpin",
  "zero-addresses",
  "invalid",
  "offline",
])("refuses readiness for %s keyd status", async (kind) => {
  const { readiness, read } = fixture();
  const value = keyd();
  if (kind === "legacy") read.mockResolvedValue({ ...value, service: undefined });
  if (kind === "owner") value.service.ownerId = "f".repeat(32);
  if (kind === "version") value.service.release.version = "9.9.9";
  if (kind === "package") value.service.release.packageSha256 = "d".repeat(64);
  if (kind === "manifest") value.service.release.manifestSha256 = "d".repeat(64);
  if (kind === "pid") value.service.pid = 0;
  if (kind === "audit") value.audit.ok = false;
  if (kind === "hairpin") value.hairpin.state = "unknown";
  if (kind === "zero-addresses") value.hairpin.addresses = 0;
  if (!["legacy", "invalid", "offline"].includes(kind)) read.mockResolvedValue(value);
  if (kind === "invalid") read.mockResolvedValue({ service: value.service });
  if (kind === "offline") read.mockRejectedValue(new Error("sensitive diagnostic"));
  await readiness.runStartup(async () => {});
  const result = await readiness.snapshot();
  expect(result.ready).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/sensitive|sealKey|secrets|spentUSD/);
});
it("coalesces in-flight keyd checks but never caches a completed healthy observation", async () => {
  const { readiness, read } = fixture(),
    gate = deferred();
  await readiness.runStartup(async () => {});
  read.mockImplementation(async () => {
    await gate.promise;
    return keyd();
  });
  const a = readiness.snapshot(),
    b = readiness.snapshot();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  gate.resolve();
  expect((await a).ready).toBe(true);
  expect((await b).ready).toBe(true);
  read.mockRejectedValue(new Error("offline"));
  expect((await readiness.snapshot()).ready).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
});
it("a stop during the keyd observation cannot return a stale ready response", async () => {
  const { readiness, read } = fixture(),
    gate = deferred();
  await readiness.runStartup(async () => {});
  read.mockImplementation(async () => {
    await gate.promise;
    return keyd();
  });
  const result = readiness.snapshot();
  readiness.stopping();
  gate.resolve();
  expect(await result).toMatchObject({ recovery: "stopping", ready: false });
});

const logs: { root: string; log: EventLog }[] = [];
afterEach(async () => {
  for (const item of logs.splice(0)) {
    item.log.close();
    await rm(item.root, { recursive: true, force: true });
  }
});
async function appFixture() {
  const root = await mkdtemp(join(tmpdir(), "localdot-ready-")),
    log = new EventLog(root);
  logs.push({ root, log });
  const f = fixture(),
    token = "t".repeat(43);
  const app = createApp({ token, port: 4750, eventLog: log, serviceReadiness: f.readiness });
  return { ...f, app, token, url: "http://127.0.0.1:4750/api/service/ready" };
}
it("exposes authenticated noncached 503/200 readiness separately from HTTP liveness", async () => {
  const f = await appFixture(),
    headers = { authorization: `Bearer ${f.token}` };
  expect((await f.app.request("http://127.0.0.1:4750/healthz")).status).toBe(200);
  let response = await f.app.request(f.url, { headers });
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await f.readiness.runStartup(async () => {});
  response = await f.app.request(f.url, { headers });
  expect(response.status).toBe(200);
  expect(ServiceReadinessReply.parse(await response.json()).ready).toBe(true);
  f.readiness.stopping();
  expect((await f.app.request(f.url, { headers })).status).toBe(503);
});
it.each(["token", "host", "origin"])("refuses %s failures before probing keyd", async (kind) => {
  const f = await appFixture(),
    headers: Record<string, string> = { authorization: `Bearer ${f.token}` };
  if (kind === "token") headers.authorization = "Bearer wrong";
  if (kind === "host") headers.host = "foreign.example";
  if (kind === "origin") headers.origin = "https://foreign.example";
  const response = await f.app.request(f.url, { headers });
  expect(response.status).toBe(kind === "token" ? 401 : 403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(f.read).not.toHaveBeenCalled();
});
it("rejects internally inconsistent ready replies", () => {
  const f = fixture();
  return f.readiness.snapshot().then((reply) => {
    expect(ServiceReadinessReply.safeParse({ ...reply, ready: true }).success).toBe(false);
    expect(
      ServiceReadinessReply.safeParse({ ...reply, checks: { ...reply.checks, recovery: true } })
        .success,
    ).toBe(false);
  });
});
