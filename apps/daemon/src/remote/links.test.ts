import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { TicketRegistry } from "../cells/secrets.ts";
import { RemoteLinks } from "./links.ts";
import { revocableResponse } from "./response.ts";

const homes: string[] = [],
  stores: RemoteLinks[] = [];
const options = {
  label: "Alex",
  expiresInHours: 24,
  maxTasks: 2,
  taskBudgetUSD: 3,
  model: { provider: "openai", model: "gpt-6.1-sol" },
};
const make = (now?: () => number) => {
  const home = mkdtempSync(join(tmpdir(), "localdot-share-"));
  homes.push(home);
  const links = new RemoteLinks(home, now);
  stores.push(links);
  return { home, links };
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});
it("stores only a private hash, restores grants and never exposes the credential in listings", () => {
  const { home, links } = make();
  const issued = links.create(options);
  expect(links.authenticate(issued.token)?.label).toBe("Alex");
  const saved = readFileSync(join(home, "remote-links.json"), "utf8");
  expect(saved).not.toContain(issued.token);
  expect(JSON.stringify(links.list())).not.toContain("digest");
  expect(statSync(join(home, "remote-links.json")).mode & 0o777).toBe(0o600);
  const restored = new RemoteLinks(home);
  stores.push(restored);
  expect(restored.authenticate(issued.token)?.id).toBe(issued.grant.id);
});
it("revokes just one of several permanent links and its stream tickets", () => {
  const { links } = make();
  const first = links.create({ ...options, expiresInHours: null }),
    second = links.create(options);
  const tickets = new TicketRegistry(),
    dropped = vi.fn();
  tickets.onRevoke(dropped);
  links.onRevoke((id) => tickets.revokeScope(id));
  const ownerTicket = tickets.issue("cell");
  const firstTicket = tickets.issue(
    "cell",
    first.grant.id,
    () => !!links.authenticate(first.token),
  );
  const secondTicket = tickets.issue(
    "cell",
    second.grant.id,
    () => !!links.authenticate(second.token),
  );
  links.revoke(first.grant.id);
  expect(links.authenticate(first.token)).toBeUndefined();
  expect(tickets.resolve(firstTicket)).toBeUndefined();
  expect(tickets.resolve(ownerTicket)).toBe("cell");
  expect(tickets.resolve(secondTicket)).toBe("cell");
  expect(dropped).toHaveBeenCalledWith(firstTicket, "scope");
});
it("expires existing readers without waiting for another request", async () => {
  vi.useFakeTimers();
  const { links } = make();
  const issued = links.create({ ...options, expiresInHours: 1 });
  const response = revocableResponse(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
    ),
    () => !!links.authenticate(issued.token),
    (end) =>
      links.onRevoke((id) => {
        if (id === issued.grant.id) end();
      }),
  );
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  const pending = reader.read();
  const assertion = expect(pending).rejects.toThrow("Shared access ended");
  await vi.advanceTimersByTimeAsync(3600000);
  await assertion;
  expect(links.authenticate(issued.token)).toBeUndefined();
});
it("reserves quotas atomically, refunds a failed start, and persists successful task ownership", () => {
  const { home, links } = make();
  const issued = links.create({ ...options, maxTasks: 1 });
  const first = links.reserve(issued.grant.id);
  expect(() => links.reserve(issued.grant.id)).toThrow();
  first.finish();
  first.finish();
  expect(links.list()[0]?.tasks).toBe(0);
  const next = links.reserve(issued.grant.id);
  const id = ulid();
  next.finish(id);
  expect(links.owns(issued.grant.id, id)).toBe(true);
  expect(() => links.reserve(issued.grant.id)).toThrow();
  const restored = new RemoteLinks(home);
  stores.push(restored);
  expect(() => restored.reserve(issued.grant.id)).toThrow();
});
it("limits selectable models to the owner's saved choices", () => {
  const { links } = make();
  const fixed = links.create(options);
  expect(() => links.select(fixed.grant.id, 0)).toThrow();
  const other = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const flexible = links.create({ ...options, chooseModel: true, models: [options.model, other] });
  links.select(flexible.grant.id, 1);
  expect(links.reserve(flexible.grant.id).model).toEqual(other);
  for (const index of [-1, 2, 0.5, Infinity])
    expect(() => links.select(flexible.grant.id, index)).toThrow();
});
it.each([
  "/api/keys",
  "/api/agent/settings",
  "/api/remote-access/links",
  "/api/install-code",
  "/api/access-links",
  "/api/exports/stream",
  "/api/accounts",
  "/api/agent/rules",
])("denies owner endpoint %s, including when session settings are enabled", (path) => {
  const { links } = make();
  const issued = links.create({ ...options, settings: true });
  const row = links.authenticate(issued.token)!;
  for (const method of ["GET", "POST", "PUT", "DELETE"])
    expect(links.permits(row, method, path)).toBe(false);
});
it("enforces replay permission and action ownership separately", () => {
  const { links } = make();
  const id = ulid();
  const issued = links.create(options);
  const row = links.authenticate(issued.token)!;
  expect(links.permits(row, "GET", `/api/sessions/${id}/recording/video.mp4`)).toBe(false);
  expect(links.permits(row, "GET", `/api/sessions/${id}/clock`)).toBe(true);
  expect(links.permits(row, "GET", "/api/clock")).toBe(true);
  expect(links.permits(row, "POST", "/api/clock")).toBe(false);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/messages`)).toBe(false);
  links.reserve(row.id).finish(id);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/messages`)).toBe(true);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/approvals/answer`)).toBe(false);
  const allowed = links.create({ ...options, replay: true });
  expect(
    links.permits(
      links.authenticate(allowed.token)!,
      "HEAD",
      `/api/sessions/${id}/recording/video.mp4`,
    ),
  ).toBe(true);
  links.revoke(row.id);
  expect(links.permits(row, "GET", "/api/cells")).toBe(false);
});
it("fails closed without destroying corrupt records or preventing local startup", () => {
  const { home } = make();
  const path = join(home, "remote-links.json");
  writeFileSync(path, "{corrupt");
  const broken = new RemoteLinks(home);
  stores.push(broken);
  expect(broken.authenticate("x".repeat(43))).toBeUndefined();
  expect(() => broken.create(options)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("{corrupt");
});
it("normal response completion unsubscribes without cancelling a finished stream", async () => {
  const cleanup = vi.fn();
  const response = revocableResponse(
    new Response("ok"),
    () => true,
    () => cleanup,
  );
  expect(await response.text()).toBe("ok");
  expect(cleanup).toHaveBeenCalledOnce();
});
