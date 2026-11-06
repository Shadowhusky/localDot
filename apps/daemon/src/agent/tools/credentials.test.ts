import type { KeydRecord } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { toolHarness } from "../testing/harness.ts";
import { dispatchTool } from "./index.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const h = toolHarness();
  fixtures.push(h);
  const saved: KeydRecord[] = [];
  h.tools.credentials = { list: vi.fn(async () => saved), request: vi.fn() };
  const call = (input: unknown) =>
    dispatchTool({ tools: h.tools }, h.session, "credentials", "call", input, (s) => s);
  return { ...h, saved, call };
}
const request = {
  action: "request",
  key_id: "weather",
  hosts: ["api.example.test"],
  label: "Weather",
  service: "Forecast",
  description: "Current conditions",
};
async function asked(h: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(h.session.pendingAsk).toBeDefined());
  return h.session.pendingAsk!;
}
it("asks privately with exact binding, resumes only with a saved key, and never types into a browser", async () => {
  const h = fixture();
  const work = h.call(request);
  const id = await asked(h);
  const fields = h.session.requestedCredentials(id);
  expect(fields[0]?.credential?.binding).toEqual({
    id: "weather",
    kind: "http",
    hosts: ["api.example.test"],
    header: "Authorization",
    format: "bearer",
  });
  expect(h.session.answerFields(id, { key: "raw-secret-should-be-refused" }, (s) => s)).toBe(false);
  h.saved.push({
    id: "weather",
    kind: "http",
    hosts: ["api.example.test"],
    header: "Authorization",
    format: "bearer",
    createdAt: "",
    updatedAt: "",
  });
  expect(h.session.answerFields(id, { key: true }, (s) => s)).toBe(true);
  const result = await work;
  expect(result.result.ok).toBe(true);
  expect(JSON.stringify(h.events())).not.toContain("raw-secret");
});
it("reuses an existing key and refuses unrelated-key replacement", async () => {
  const h = fixture();
  h.saved.push({
    id: "weather",
    kind: "http",
    hosts: ["api.example.test"],
    header: "Authorization",
    format: "bearer",
    createdAt: "",
    updatedAt: "",
  });
  expect((await h.call(request)).result.ok).toBe(true);
  expect(h.session.pendingAsk).toBeUndefined();
  expect((await h.call({ ...request, hosts: ["different.example.test"] })).result.ok).toBe(false);
});
it("handles a declined credential request without claiming success", async () => {
  const h = fixture();
  const work = h.call(request);
  h.session.decline(await asked(h));
  expect((await work).result.ok).toBe(false);
});

it("saves a general key through private input without inventing a provider or promising API access", async () => {
  const h = fixture();
  const work = h.call({
    action: "request",
    key_id: "project-license",
    kind: "secret",
    label: "Project license",
    description: "License for the project build",
  });
  const id = await asked(h);
  expect(h.session.requestedCredentials(id)[0]?.credential?.binding).toEqual({
    id: "project-license",
    kind: "secret",
  });
  expect(h.session.answerFields(id, { key: "synthetic-private-value" }, (s) => s)).toBe(false);
  h.saved.push({ id: "project-license", kind: "secret", createdAt: "", updatedAt: "" });
  expect(h.session.answerFields(id, { key: true }, (s) => s)).toBe(true);
  const result = await work;
  expect(result.result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
  expect(h.tools.credentials?.request).not.toHaveBeenCalled();
  expect(h.session.pendingAsk).toBeUndefined();
  expect(
    (await h.call({ action: "request", kind: "secret", key_id: "project-license" })).result.ok,
  ).toBe(true);
  expect((await h.call({ ...request, key_id: "project-license" })).result.ok).toBe(false);
});

function connecting(connected: () => boolean, ended = false) {
  const h = fixture();
  const remove = vi.fn(async () => undefined);
  const appsChanged = vi.fn();
  const order: string[] = [];
  const refresh = vi.fn(async () => {
    order.push("listed");
  });
  appsChanged.mockImplementation(() => order.push("started again"));
  const config = { id: "linear", name: "Linear" };
  h.tools.connectors = {
    connectTarget: (app: string) =>
      app === "linear" ? { config, host: "mcp.linear.app", added: true, ended } : undefined,
    isConnected: connected,
    refresh,
    remove,
  } as never;
  h.tools.appsChanged = appsChanged;
  return { ...h, remove, appsChanged, order };
}
const connect = { action: "connect", app: "linear" };

it("offers a card to connect an app, and moves its tools in once it is connected", async () => {
  let connected = false;
  const h = connecting(() => connected);
  const work = h.call(connect);
  const id = await asked(h);
  const event = h.events().find((e) => e.type === "ask.request") as never as {
    data?: { fields?: { kind: string; connect?: unknown }[] };
  };
  expect(event?.data?.fields?.[0]).toMatchObject({
    kind: "connect_app",
    connect: { connector: "linear", name: "Linear", host: "mcp.linear.app" },
  });
  expect(h.session.answerFields(id, { app: "yes" }, (s) => s)).toBe(false);
  connected = true;
  expect(h.session.answerFields(id, { app: true }, (s) => s)).toBe(true);
  const { result } = await work;
  expect(result.ok).toBe(true);
  expect(h.appsChanged).toHaveBeenCalledWith(h.session);
  // Its tools are listed first, or the new start wouldn't have them.
  expect(h.order).toEqual(["listed", "started again"]);
  expect(h.remove).not.toHaveBeenCalled();
});

it("takes a false answer for what it is when the app didn't connect", async () => {
  const h = connecting(() => false);
  const work = h.call(connect);
  const id = await asked(h);
  expect(h.session.answerFields(id, { app: true }, (s) => s)).toBe(true);
  const { result } = await work;
  expect(result.ok).toBe(false);
  expect(h.appsChanged).not.toHaveBeenCalled();
});

it("takes the app away again when the user turns down one it added for the offer", async () => {
  const h = connecting(() => false);
  const work = h.call(connect);
  const id = await asked(h);
  expect(h.session.decline(id)).toBe(true);
  const { result } = await work;
  expect(result.ok).toBe(false);
  expect(h.remove).toHaveBeenCalledWith("linear");
  expect(JSON.stringify(result.content)).toContain("do not ask again");
});

it("doesn't offer an app already connected, or one it can't connect", async () => {
  const h = connecting(() => true);
  const already = await h.call(connect);
  expect(already.result.ok).toBe(true);
  expect(JSON.stringify(already.result.content)).toContain("already connected");
  const unknown = await h.call({ action: "connect", app: "nothing" });
  expect(unknown.result.ok).toBe(false);
  expect(h.session.pendingAsk).toBeUndefined();
});

it("offers one whose sign-in has ended, as a reconnect", async () => {
  const h = connecting(() => true, true);
  const work = h.call(connect);
  const id = await asked(h);
  expect(h.session.answerFields(id, { app: true }, (s) => s)).toBe(true);
  expect((await work).result.ok).toBe(true);
});
