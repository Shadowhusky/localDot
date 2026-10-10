import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isAllowedHost, isAllowedOrigin } from "../guard.ts";
import { InstallCodes } from "../install-codes.ts";
import { connectRemote } from "./connector.ts";
import { configuredRemoteDomain, RemoteAccess, remoteDomain } from "./manager.ts";

vi.mock("./connector.ts", () => ({
  connectRemote: vi.fn((options) => {
    options.status("online");
    return vi.fn();
  }),
}));
const homes: string[] = [];
const managers: RemoteAccess[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  vi.clearAllMocks();
});
function home() {
  const h = mkdtempSync(join(tmpdir(), "localdot-remote-"));
  homes.push(h);
  return h;
}
function manager(h = home(), domain: string | null = "remote.example.com") {
  const m = new RemoteAccess(h, 4750, domain, new InstallCodes("a".repeat(64), 4750));
  managers.push(m);
  return m;
}
it("is opt-in and unavailable without an operator-configured domain", () => {
  const m = manager();
  m.start();
  expect(m.snapshot().state).toBe("off");
  expect(connectRemote).not.toHaveBeenCalled();
  const missing = manager(home(), null);
  expect(missing.snapshot().supported).toBe(false);
  expect(() => missing.configure(true)).toThrow();
});
it("persists a private stable address across restarts and revokes keys and Host permission on disable", () => {
  const h = home(),
    first = manager(h);
  first.configure(true);
  const before = JSON.parse(readFileSync(join(h, "remote-access.json"), "utf8"));
  expect(statSync(join(h, "remote-access.json")).mode & 0o777).toBe(0o600);
  const origin = first.snapshot().url;
  expect(origin).toBeTruthy();
  expect(isAllowedOrigin(origin ?? undefined, 4750)).toBe(true);
  const link = new URL(first.link().url);
  expect(link.pathname).toBe("/_remote/pair");
  expect(link.search).toBe("");
  expect(link.hash).toContain("remote=");
  expect(link.hash).toContain("code=");
  expect(JSON.stringify(first.snapshot())).not.toContain(before.access);
  first.close();
  const second = manager(h);
  second.start();
  expect(second.snapshot().url).toBe(origin);
  second.configure(false);
  expect(second.snapshot().state).toBe("off");
  expect(isAllowedHost(new URL(origin ?? "").host, 4750)).toBe(false);
  const after = JSON.parse(readFileSync(join(h, "remote-access.json"), "utf8"));
  expect(after.enabled).toBe(false);
  expect(after.owner).toBe(before.owner);
  expect(after.access).not.toBe(before.access);
  const third = manager(h);
  third.start();
  expect(third.snapshot().enabled).toBe(false);
});
it("a changed service needs new opt-in and rotates credentials", () => {
  const h = home(),
    first = manager(h);
  first.configure(true);
  first.close();
  const before = JSON.parse(readFileSync(join(h, "remote-access.json"), "utf8"));
  const changed = manager(h, "other.example.com");
  changed.start();
  expect(changed.snapshot().enabled).toBe(false);
  changed.configure(true);
  const after = JSON.parse(readFileSync(join(h, "remote-access.json"), "utf8"));
  expect(after.owner).not.toBe(before.owner);
  expect(after.access).not.toBe(before.access);
});
it.each([
  "https://example.com",
  "localhost:123",
  "*.example.com",
  "example.com/path",
  "user@example.com",
  "example.com\n",
])("rejects an invalid service domain %s", (value) => {
  expect(() => remoteDomain(value)).toThrow();
});

it("corrupt optional configuration cannot start a relay or prevent local startup", () => {
  const h = home();
  writeFileSync(join(h, "remote-access.json"), "{bad json");
  const m = manager(h);
  m.start();
  expect(m.snapshot().enabled).toBe(false);
  expect(connectRemote).not.toHaveBeenCalled();
});
it("loads operator configuration without managed-service environment variables and fails closed", () => {
  const h = home();
  expect(configuredRemoteDomain(h)).toBeNull();
  writeFileSync(join(h, "remote-service.json"), JSON.stringify({ domain: "example.com" }));
  expect(configuredRemoteDomain(h)).toBe("example.com");
  writeFileSync(join(h, "remote-service.json"), JSON.stringify({ domain: "https://example.com" }));
  expect(configuredRemoteDomain(h)).toBeNull();
});
