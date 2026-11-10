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
it("keeps the owner's apps and keys off a link unless it opts in, links made before included", () => {
  const { home, links } = make();
  const plain = links.create(options);
  expect(plain.grant.apps).toBe(false);
  expect(links.create({ ...options, apps: true }).grant.apps).toBe(true);
  const path = join(home, "remote-links.json");
  const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
  writeFileSync(path, JSON.stringify(rows.map(({ apps: _, ...row }) => row)), { mode: 0o600 });
  const restored = new RemoteLinks(home);
  stores.push(restored);
  expect(restored.authenticate(plain.token)?.apps).toBe(false);
  expect(restored.list().map((link) => link.apps)).toEqual([false, false]);
});
it("shows the signed-in web browser only to a link with the owner's apps", () => {
  const { links } = make();
  const cell = ulid();
  const paths = [
    ["POST", `/api/cells/${cell}/browser-stream-ticket`],
    ["GET", `/api/browsers/${cell}`],
    ["HEAD", `/api/browsers/${cell}`],
    ["GET", `/api/browsers/${cell}/status`],
  ] as const;
  for (const setting of [{}, { replay: true, settings: true }]) {
    const row = links.authenticate(links.create({ ...options, ...setting }).token);
    if (!row) throw new Error("the link did not authenticate");
    for (const [method, path] of paths) expect(links.permits(row, method, path), path).toBe(false);
    expect(links.permits(row, "POST", `/api/cells/${cell}/stream-ticket`)).toBe(true);
  }
  const row = links.authenticate(links.create({ ...options, apps: true }).token);
  if (!row) throw new Error("the link did not authenticate");
  for (const [method, path] of paths) expect(links.permits(row, method, path), path).toBe(true);
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
  "/api/computer-size",
])("denies owner endpoint %s, including when session settings are enabled", (path) => {
  const { links } = make();
  const issued = links.create({ ...options, settings: true });
  const row = links.authenticate(issued.token)!;
  for (const method of ["GET", "POST", "PUT", "DELETE"])
    expect(links.permits(row, method, path)).toBe(false);
});
it("gives a guest no way to answer a card, even on a task of its own", () => {
  const { links } = make();
  const issued = links.create({ ...options, settings: true });
  const row = links.authenticate(issued.token)!;
  const id = "0".repeat(26);
  links.reserve(row.id).finish(id);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/messages`)).toBe(true);
  for (const path of [
    `/api/agent/sessions/${id}/blockers/${id}/dismiss`,
    `/api/agent/sessions/${id}/blockers/${id}/model`,
    "/api/keyd/unlock",
    "/api/keys",
    "/api/runtime/start",
    `/api/cells/${id}/start`,
    `/api/connectors/github/sign-in`,
  ])
    expect(links.permits(row, "POST", path), path).toBe(false);
});
it("enforces replay permission and action ownership separately", () => {
  const { links } = make();
  const id = ulid();
  const issued = links.create(options);
  const row = links.authenticate(issued.token)!;
  expect(links.permits(row, "GET", `/api/sessions/${id}/recording/video.mp4`)).toBe(false);
  expect(links.permits(row, "GET", `/api/sessions/${id}/clock`)).toBe(false);
  expect(links.permits(row, "GET", "/api/clock")).toBe(true);
  expect(links.permits(row, "POST", "/api/clock")).toBe(false);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/messages`)).toBe(false);
  links.reserve(row.id).finish(id);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/messages`)).toBe(true);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/approvals/answer`)).toBe(false);
  // A side question is the owner's, even about a task the guest started.
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/side-question`)).toBe(false);
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
const LIVE = ["events", "history", "stream", "clock"] as const;
const RECORDING = [
  "card",
  "recording",
  "recording/video.mp4",
  "manifest",
  "fragments/0",
  "frames/01JXYZ0000000000000000FRAM",
  "thumbs/01JXYZ0000000000000000FRAM",
  "thumbnail",
  "summary",
  "events",
  "history",
  "replay",
] as const;
const SETTINGS = [
  {},
  { replay: true },
  { settings: true },
  { chooseModel: true, models: [options.model] },
  { replay: true, settings: true, chooseModel: true, models: [options.model] },
];
const signIn = (links: RemoteLinks, setting: object = {}) => {
  const row = links.authenticate(links.create({ ...options, ...setting }).token);
  if (!row) throw new Error("the link did not authenticate");
  return row;
};
it.each(SETTINGS)("reads only its own tasks and conversations (%o)", (setting) => {
  const { links } = make();
  const row = signIn(links, setting);
  const own = ulid(),
    other = ulid();
  links.reserve(row.id).finish(own);
  for (const method of ["GET", "HEAD"]) {
    expect(links.permits(row, method, `/api/agent/sessions/${own}`)).toBe(true);
    for (const part of LIVE)
      expect(links.permits(row, method, `/api/sessions/${own}/${part}`), part).toBe(true);
    expect(links.permits(row, method, `/api/agent/sessions/${other}`)).toBe(false);
    for (const part of ["stream", "clock"])
      expect(links.permits(row, method, `/api/sessions/${other}/${part}`), part).toBe(false);
    for (const part of RECORDING)
      expect(links.permits(row, method, `/api/sessions/${other}/${part}`), part).toBe(!!row.replay);
    // The routes answer a link with its own conversations only.
    expect(links.permits(row, method, "/api/conversation")).toBe(true);
    expect(links.permits(row, method, "/api/conversations")).toBe(true);
    expect(links.permits(row, method, `/api/conversations/${other}/latest`)).toBe(false);
  }
  for (const path of ["/api/conversation/new", "/api/conversation/continue"])
    expect(links.permits(row, "POST", path), path).toBe(true);
  for (const path of [`/api/agent/sessions/${other}/messages`, `/api/agent/sessions/${other}/stop`])
    expect(links.permits(row, "POST", path), path).toBe(false);
  for (const path of ["archive", "pin", "title"])
    expect(links.permits(row, "POST", `/api/conversations/${own}/${path}`), path).toBe(false);
});
it("keeps a link's own conversation on show, by its own tasks only", () => {
  const { links } = make();
  const row = signIn(links);
  const own = ulid(),
    other = ulid();
  links.reserve(row.id).finish(own);
  expect(links.shown(row.id)).toBeUndefined();
  expect(links.show(row.id, other)).toBe(false);
  expect(links.shown(row.id)).toBeUndefined();
  expect(links.show(row.id, own)).toBe(true);
  expect(links.shown(row.id)).toBe(own);
  expect(links.show(row.id, null)).toBe(true);
  expect(links.shown(row.id)).toBeNull();
});
it("offers a link that allows switching its models and the owner's configured ones", () => {
  const { links } = make();
  const deepseek = { provider: "deepseek", model: "deepseek-flash" };
  const plan = { provider: "claude-code", model: "default" };
  const configured = [plan, deepseek, { provider: "openai", model: "gpt-off", off: true as const }];
  // As a link made before rc.44 reads back: its two models, switching allowed.
  const old = signIn(links, { chooseModel: true, model: plan, models: [plan, deepseek] });
  expect(links.choices(old)).toEqual([plan, deepseek]);
  expect(links.choices(old, configured)).toEqual([
    plan,
    deepseek,
    { provider: "openai", model: "gpt-off" },
  ]);
  // One made with only its own model still offers what the owner has configured now.
  const one = signIn(links, { chooseModel: true, models: [options.model] });
  expect(links.choices(one, [deepseek])).toEqual([options.model, deepseek]);
  links.select(one.id, 1, [deepseek]);
  expect(links.active(one.id)?.model).toEqual(deepseek);
  expect(links.reserve(one.id).model).toEqual(deepseek);
  // Without switching, only its model, whatever is configured.
  const fixed = signIn(links);
  expect(links.choices(fixed, [deepseek])).toEqual([options.model]);
  expect(() => links.select(fixed.id, 0, [deepseek])).toThrow();
});
it("keeps a link without Replay away from every recording, its own task's too", () => {
  const { links } = make();
  const row = signIn(links);
  const own = ulid();
  links.reserve(row.id).finish(own);
  for (const part of RECORDING.filter((part) => part !== "events" && part !== "history"))
    expect(links.permits(row, "GET", `/api/sessions/${own}/${part}`), part).toBe(false);
  expect(links.permits(row, "GET", "/api/sessions")).toBe(false);
  expect(links.permits(row, "GET", "/api/session-index")).toBe(false);
});
it("answers for the task in every path that names one, whichever rule lets the path through", () => {
  const { links } = make();
  const row = signIn(links, { settings: true, chooseModel: true, models: [options.model] });
  const other = ulid();
  const named = [
    ...LIVE.map((part) => `/api/sessions/${other}/${part}`),
    ...RECORDING.map((part) => `/api/sessions/${other}/${part}`),
    `/api/agent/sessions/${other}`,
    ...["messages", "stop", "answer", "model", "files/report.pdf", "conversation-files"].map(
      (part) => `/api/agent/sessions/${other}/${part}`,
    ),
    `/api/conversations/${other}`,
    `/api/conversations/${other}/latest`,
    `/api/sessions/${other.toLowerCase()}/events`,
  ];
  for (const path of named)
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"])
      expect(links.permits(row, method, path), `${method} ${path}`).toBe(false);
});
it("never lets a link read files on the computer, even of a task it started", () => {
  const { links } = make();
  const row = links.authenticate(links.create({ ...options, replay: true }).token);
  if (!row) throw new Error("the link did not authenticate");
  const id = ulid();
  links.reserve(row.id).finish(id);
  for (const action of ["about", "text", "table", "download", "thumbnail"])
    for (const method of ["GET", "HEAD", "POST"])
      expect(
        links.permits(row, method, `/api/agent/sessions/${id}/computer-files/${action}`),
        `${method} ${action}`,
      ).toBe(false);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/preview-link`)).toBe(false);
});

it("never lets a shared link rename, tag, pin, archive or delete a conversation, or change a task's dot", () => {
  const { links } = make();
  const id = ulid();
  const row = links.authenticate(links.create({ ...options, replay: true, settings: true }).token);
  if (!row) throw new Error("the link did not authenticate");
  links.reserve(row.id).finish(id);
  expect(links.permits(row, "POST", `/api/agent/sessions/${id}/messages`)).toBe(true);
  for (const path of [
    `/api/conversations/${id}`,
    `/api/conversations/${id}/title`,
    `/api/conversations/${id}/tag`,
    `/api/conversations/${id}/pin`,
    `/api/conversations/${id}/archive`,
    `/api/agent/sessions/${id}/persona`,
  ])
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(links.permits(row, method, path), `${method} ${path}`).toBe(false);
});
it("never lets a shared link read or change the computer's size, even with replay and settings", () => {
  const { links } = make();
  const row = links.authenticate(
    links.create({ ...options, replay: true, settings: true, chooseModel: true }).token,
  );
  if (!row) throw new Error("the link did not authenticate");
  links.reserve(row.id).finish(ulid());
  for (const path of ["/api/computer-size", "/api/computer-size/", "/api/computer-size?x=1"])
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
      expect(links.permits(row, method, path), `${method} ${path}`).toBe(false);
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
