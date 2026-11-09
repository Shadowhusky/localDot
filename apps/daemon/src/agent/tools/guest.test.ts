import type { KeydRecord } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceRecorder } from "../experience-recorder.ts";
import { toolsFor } from "../guest.ts";
import { MemoryStore } from "../memory.ts";
import { PeopleStore } from "../people.ts";
import { toolHarness } from "../testing/harness.ts";
import type { RoutineToolPort } from "./routine.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
const at = "2026-10-02T00:00:00Z";
const KEY: KeydRecord = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test"],
  createdAt: at,
  updatedAt: at,
};
// A task started through a shared link, or the owner's own when `guest` is undefined.
function task(guest: { apps: boolean } | undefined) {
  const routines = {
    propose: vi.fn(),
    list: vi.fn(() => []),
    pause: vi.fn(),
    name: vi.fn(() => undefined),
    followUp: vi.fn(),
  };
  const h = toolHarness({ routines: routines as unknown as RoutineToolPort });
  fixtures.push(h);
  if (guest) h.session.guest = guest;
  const recall = vi.fn(() => [
    { title: "Pay the rent", day: "2026-09-03", kind: "summary" as const, snippet: "Paid" },
  ]);
  h.tools.recall = recall;
  h.tools.recallExperience = vi.fn(() => "");
  const credentials = { list: vi.fn(async () => [KEY]), request: vi.fn() };
  h.tools.credentials = credentials;
  const contacts = new PeopleStore(h.home);
  const people = vi.spyOn(contacts, "find");
  h.tools.people = contacts;
  return { ...h, recall, credentials, people, routines, memory: new MemoryStore(h.home) };
}
const OWNERS = {
  recall: { query: "rent" },
  remember: { file: "USER.md", op: "append", text: "Alex is staying until Friday." },
  people: { op: "find", query: "Henry" },
  routine: { op: "list" },
  follow_up_at: { at: "2026-10-09T09:00", note: "Check the parcel" },
} as const;
const ACCOUNTS = {
  credentials: { action: "list" },
  api_request: { key_id: "weather", url: "https://api.example.test/now" },
  switch_screen: { screen: "browser" },
  browser_upload: { files: ["~/report.pdf"] },
} as const;
const said = (body: { content: { text?: string }[] }) =>
  body.content.map((part) => part.text ?? "").join("\n");

describe("a task started through a shared link", () => {
  it.each([false, true])(
    "is refused the owner's history, memory, contacts and routines (apps %s)",
    async (apps) => {
      const h = task({ apps });
      for (const [name, input] of Object.entries(OWNERS)) {
        const reply = await h.call(name, input);
        expect(reply.body.ok, name).toBe(false);
        expect(said(reply.body), name).toContain("shared link");
      }
      expect(h.recall).not.toHaveBeenCalled();
      expect(h.people).not.toHaveBeenCalled();
      expect(h.routines.list).not.toHaveBeenCalled();
      expect(h.routines.followUp).not.toHaveBeenCalled();
      expect(h.memory.read("USER.md")).not.toContain("Alex");
      expect(
        h.events().filter((e) => e.type === "step.end" && e.data.status === "blocked"),
      ).toHaveLength(Object.keys(OWNERS).length);
    },
  );
  it("is refused the owner's keys, apps and signed-in browser unless its link allows them", async () => {
    const closed = task({ apps: false });
    for (const [name, input] of Object.entries(ACCOUNTS)) {
      const reply = await closed.call(name, input);
      expect(reply.body.ok, name).toBe(false);
      expect(said(reply.body), name).toContain("shared link");
    }
    expect(closed.credentials.list).not.toHaveBeenCalled();
    for (const input of [
      { kind: "key", key_id: "weather" },
      { kind: "app", app: "GitHub" },
      { kind: "keys_locked" },
    ])
      expect(said((await closed.call("request_fix", input)).body)).toContain("shared link");
    expect(said((await closed.call("request_fix", { kind: "computer" })).body)).not.toContain(
      "shared link",
    );
    expect(closed.credentials.list).not.toHaveBeenCalled();
    const context = await closed.call("work_context", {});
    expect(said(context.body)).not.toContain("weather");
    expect(closed.credentials.list).not.toHaveBeenCalled();

    const open = task({ apps: true });
    const listed = await open.call("credentials", { action: "list" });
    expect(said(listed.body)).not.toContain("shared link");
    expect(open.credentials.list).toHaveBeenCalled();
  });
  it("refuses a connected app's tool its link doesn't allow, even one the task names anyway", async () => {
    const h = task({ apps: false });
    const entry = { exposed: "github__list_issues" };
    h.session.connectors = {
      specs: [
        {
          name: "github__list_issues",
          app: "GitHub",
          description: "List issues.",
          inputSchema: {},
        },
      ],
      get: (name) => (name === entry.exposed ? (entry as never) : undefined),
    };
    const reply = await h.call("github__list_issues", {});
    expect(reply.body.ok).toBe(false);
    expect(said(reply.body)).toContain("shared link");
  });
  it("leaves the owner's own task every tool", async () => {
    const h = task(undefined);
    const reply = await h.call("recall", { query: "rent" });
    expect(reply.body.ok).toBe(true);
    expect(h.recall).toHaveBeenCalled();
    expect(said((await h.call("credentials", { action: "list" })).body)).not.toContain(
      "shared link",
    );
  });
  it("keeps no lesson from a shared link's task in the owner's memory", async () => {
    const h = task({ apps: true });
    const recorder = new ExperienceRecorder({ memory: h.memory, changed: () => {} });
    h.eventLog.subscribe((id, event) => recorder.event(id, event));
    const save = vi.fn((id: string, lesson: never) => recorder.save(id, lesson));
    h.tools.saveExperience = save;
    await h.call("shell", { command: "pwd" });
    // The guest's own reply came after the command's output.
    h.session.tainted = false;
    const done = await h.call("done", {
      summary: "Checked",
      experience: {
        scope: "Report export",
        when: "Long tables",
        procedure: "Repeat the header on each page.",
        recheck: "Inspect the last page.",
        outcome: "worked",
      },
    });
    expect(done.body.ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(h.memory.experiences()).toHaveLength(0);
  });
  it("can't move to the web browser without its link's apps, by any route", async () => {
    const h = task({ apps: false });
    const generation = h.session.generation;
    if (!generation) throw new Error("no brain generation");
    await expect(
      h.session.switchScreen("browser", h.session.admitCall(generation)),
    ).rejects.toThrow(/shared link/);
  });
});

describe("what a shared link's task's tools can reach", () => {
  it("is none of the owner's history, contacts or schedule, and their sign-ins and keys only when allowed", () => {
    const h = task(undefined);
    h.tools.logins = { login: vi.fn(), saveLogin: vi.fn() };
    expect(toolsFor(h.tools, undefined)).toBe(h.tools);
    for (const apps of [false, true]) {
      const reach = toolsFor(h.tools, { apps });
      for (const owners of ["recall", "recallExperience", "saveExperience", "people", "routines"])
        expect(reach, owners).not.toHaveProperty(owners);
      for (const accounts of ["logins", "credentials"])
        expect(Object.hasOwn(reach, accounts), accounts).toBe(apps);
      expect(reach.desktop).toBe(h.tools.desktop);
    }
  });
});
