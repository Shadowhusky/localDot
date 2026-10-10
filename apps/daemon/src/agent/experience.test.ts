import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvent, ulid } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { parseExperience } from "./experience.ts";
import { ExperienceRecorder } from "./experience-recorder.ts";
import { MemoryStore } from "./memory.ts";
import { memoryBudget, memoryTokens } from "./memory-budget.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dot-experience-"));
  homes.push(home);
  return { home, memory: new MemoryStore(home) };
}
const lesson = {
  scope: "northstar repository",
  when: "Node 24, pnpm workspace",
  procedure:
    "Install with pnpm --frozen-lockfile, generate the client, then run pnpm test. Running tests before generation fails.",
  recheck: "Read repository instructions; check Node and lockfile versions, then run the tests.",
};

it("reuses scoped setup experience in a fresh task and routine, without contaminating unrelated tasks", () => {
  const { home, memory } = fixture();
  const source = ulid();
  memory.learn(source, lesson, ulid());
  const later = new MemoryStore(home);
  for (const task of ["Fix a bug in northstar", "Daily automation: test northstar repository"])
    expect(later.bootMemory(task).memory).toContain("generate the client");
  expect(later.bootMemory("Test the weather app").memory).not.toContain("generate the client");
  expect(later.bootMemory("Fix northstar").memory).toContain("untrusted observations");
  expect(later.bootMemory("Fix northstar").memory).toContain(source);
  expect(later.read("MEMORY.md")).not.toContain("generate the client");
});

it("consolidates a corrected procedure and honors deletion in What dot knows", () => {
  const { memory } = fixture();
  memory.learn(ulid(), lesson, ulid());
  expect(memory.learn(ulid(), lesson, ulid())).toBeUndefined();
  memory.learn(
    ulid(),
    {
      ...lesson,
      procedure: "Use pnpm setup before testing; the old generation command was removed.",
    },
    ulid(),
  );
  expect(memory.experiences()).toHaveLength(1);
  const entry = memory.experiences()[0];
  if (!entry) throw new Error("missing experience");
  expect(memory.bootMemory("northstar").memory).toContain("old generation command was removed");
  memory.deleteEntry(entry.file, entry.id, entry.revision);
  expect(memory.bootMemory("northstar").memory).not.toContain("Experience:");
});

it("saves a distilled recovery, never promotes raw step titles into a lesson", () => {
  const { memory } = fixture();
  const id = ulid();
  const recorder = new ExperienceRecorder({
    memory,
    changed: () => {},
  });
  const emit = (type: string, data: unknown, step: string) =>
    recorder.event(
      id,
      parseEvent({ v: 1, id: ulid(), seq: 1, t: 0, agent: "dot", type, data, step }),
    );
  expect(recorder.save(id, lesson)).toBe(false);
  emit("step.start", { kind: "shell" }, "first");
  emit("tool.start", { tool: "shell", title: "pnpm test" }, "first");
  emit("tool.end", { ok: false, exitCode: 1 }, "first");
  emit("step.start", { kind: "shell" }, "second");
  emit("tool.start", { tool: "shell", title: "pnpm generate && pnpm test" }, "second");
  emit("tool.end", { ok: true, exitCode: 0 }, "second");
  expect(memory.experiences()).toHaveLength(0);
  emit("task.result", { summary: "Checks passed", files: [] }, "finish");
  expect(memory.experiences()).toHaveLength(0);
  expect(recorder.save(id, lesson)).toBe(true);
  expect(memory.experiences()).toHaveLength(1);
  expect(memory.bootMemory("Repair northstar").memory).toContain("generate the client");
});

it("refuses credentials and bounds automatic context", () => {
  const { memory } = fixture();
  expect(() =>
    memory.learn(ulid(), { ...lesson, procedure: `token=sk-proj-${"A".repeat(40)}` }, ulid()),
  ).toThrow();
  for (let i = 0; i < 8; i++)
    memory.learn(ulid(), { ...lesson, scope: `northstar component${i}` }, ulid());
  const text = memory.bootMemory("Work on northstar").memory;
  expect(text.match(/Experience:/g)).toHaveLength(3);
  expect(text.length).toBeLessThanOrEqual(20000);
});

it("does not save a learned procedure when automatic memory writes are disallowed", () => {
  const { memory } = fixture();
  const id = ulid();
  const recorder = new ExperienceRecorder({
    memory,
    allowed: () => false,
    changed: () => {},
  });
  for (const [type, data] of [
    ["step.start", { kind: "shell" }],
    ["tool.end", { ok: true }],
  ] as const)
    recorder.event(
      id,
      parseEvent({ v: 1, id: ulid(), seq: 1, t: 0, agent: "dot", step: "setup", type, data }),
    );
  expect(recorder.save(id, lesson)).toBe(false);
  expect(memory.experiences()).toHaveLength(0);
});

function send(recorder: ExperienceRecorder, id: string, type: string, data: unknown, step = "one") {
  recorder.event(
    id,
    parseEvent({ v: 1, id: ulid(), seq: 1, t: 0, agent: "dot", type, data, step }),
  );
}

it.each(["browser", "gui", "app", "think", "file", "shell"])(
  "learns from %s work across fresh sessions",
  (kind) => {
    const { home, memory } = fixture();
    const id = ulid();
    const recorder = new ExperienceRecorder({ memory, changed: () => {} });
    send(recorder, id, "step.start", { kind });
    send(recorder, id, "tool.start", {
      tool: kind === "think" ? "connector" : kind,
      title: "Observed work",
    });
    send(recorder, id, kind === "gui" ? "action.result" : "tool.end", { ok: true });
    const skill = {
      scope: "Spreadsheet import",
      when: "Delimited text with leading-zero identifiers",
      procedure: "Import identifiers as text to retain leading zeros.",
      recheck: "Compare the first identifier and row count with the source.",
      cues: ["CSV account numbers", "表格导入"],
      outcome: "worked" as const,
    };
    expect(recorder.save(id, skill)).toBe(true);
    const next = new MemoryStore(home);
    expect(next.bootMemory("Keep the account numbers when reading this CSV").memory).toContain(
      "leading zeros",
    );
    expect(next.bootMemory("帮我处理表格导入").memory).toContain("leading zeros");
    expect(parseExperience(next.experiences()[0]?.text ?? "")).toEqual(skill);
  },
);

it("can remember failed approaches without falsely claiming a success", () => {
  const { memory } = fixture();
  const id = ulid();
  const recorder = new ExperienceRecorder({ memory, changed: () => {} });
  for (const step of ["one", "two"]) {
    send(recorder, id, "step.start", { kind: "browser" }, step);
    send(recorder, id, "tool.end", { ok: false }, step);
  }
  expect(recorder.save(id, lesson)).toBe(false);
  expect(recorder.save(id, { ...lesson, outcome: "failed" })).toBe(true);
  expect(memory.bootMemory("northstar").memory).toContain("Outcome: failed");
});

it("does not learn from recall itself, blocked work, stopped sessions or rejected verification", () => {
  const { memory } = fixture();
  const id = ulid();
  const recorder = new ExperienceRecorder({ memory, changed: () => {} });
  send(recorder, id, "step.start", { kind: "think" });
  send(recorder, id, "tool.start", { tool: "recall", title: "Recall earlier work" });
  send(recorder, id, "tool.end", { ok: true });
  expect(recorder.save(id, lesson)).toBe(false);
  send(recorder, id, "step.start", { kind: "gui" });
  send(recorder, id, "action.result", { ok: true });
  send(recorder, id, "step.verify", { status: "failed" });
  expect(recorder.save(id, lesson)).toBe(false);
  send(recorder, id, "step.end", { status: "blocked" });
  expect(recorder.save(id, { ...lesson, outcome: "failed" })).toBe(false);
  send(recorder, id, "session.end", { reason: "stopped" });
  expect(recorder.save(id, { ...lesson, outcome: "failed" })).toBe(false);
  expect(memory.experiences()).toHaveLength(0);
});

it("bounds combined memory with multilingual text and a small model context", () => {
  const { memory } = fixture();
  for (const file of ["USER.md", "MEMORY.md"] as const)
    for (let i = 0; i < 20; i++)
      memory.addEntry(file, `项目${i} ${"界面与用户偏好🙂".repeat(35)}`, i === 0);
  memory.learn(ulid(), lesson, ulid());
  for (const context of [4096, 32768, 128000, 1000000]) {
    const { user, memory: text } = memory.bootMemory("northstar", context);
    expect(memoryTokens(user) + memoryTokens(text)).toBeLessThanOrEqual(memoryBudget(context));
    expect(user.isWellFormed() && text.isWellFormed()).toBe(true);
  }
});

it("refreshes revalidated lessons, flags old observations and honors user edits", () => {
  const { home } = fixture();
  let day = new Date("2026-01-01T12:00:00Z");
  const memory = new MemoryStore(home, { now: () => day });
  memory.learn(ulid(), lesson, ulid());
  day = new Date("2026-10-10T12:00:00Z");
  expect(memory.bootMemory("northstar").memory).toContain("older observation");
  memory.learn(ulid(), lesson, ulid());
  expect(memory.experiences()).toHaveLength(1);
  expect(memory.bootMemory("northstar").memory).not.toContain("older observation");
  const entry = memory.experiences()[0];
  if (!entry) throw new Error("Missing lesson");
  memory.editEntry(entry.file, entry.id, entry.revision, {
    text: entry.text.replace("generate the client", "use the reviewed method"),
  });
  memory.learn(ulid(), lesson, ulid());
  expect(memory.bootMemory("northstar").memory).toContain("reviewed method");
});

it("retrieves full lessons on demand and forgets deleted ones after restart", () => {
  const { home, memory } = fixture();
  memory.learn(ulid(), { ...lesson, cues: ["constellation workspace"] }, ulid());
  expect(memory.recallMemory("constellation workspace")).toContain(lesson.procedure);
  const source = memory.experiences()[0];
  if (!source) throw new Error("Missing lesson");
  expect(
    memory.recallMemory("northstar", source.source.kind === "task" ? source.source.sessionId : ""),
  ).not.toContain(lesson.procedure);
  memory.deleteEntry(source.file, source.id, source.revision);
  expect(new MemoryStore(home).recallMemory("constellation workspace")).not.toContain(
    lesson.procedure,
  );
  memory.addEntry("USER.md", "Always use metric units when discussing measurements", true);
  expect(memory.recallMemory("measurement units")).toContain("metric units");
});

it("does not lose useful lessons behind 90 newer daily notes", () => {
  const { home } = fixture();
  let day = new Date("2025-01-01T12:00:00Z");
  const memory = new MemoryStore(home, { now: () => day });
  memory.learn(ulid(), lesson, ulid());
  for (let i = 1; i <= 91; i++) {
    day = new Date(Date.UTC(2025, 0, 1 + i, 12));
    memory.appendNote(ulid(), `Unrelated daily observation ${i}`);
  }
  expect(new MemoryStore(home).bootMemory("northstar").memory).toContain(lesson.procedure);
});

it("keeps distinct applicability conditions and selects the matching variant", () => {
  const { memory } = fixture();
  memory.learn(
    ulid(),
    { ...lesson, when: "Legacy desktop", procedure: "Use the older desktop route." },
    ulid(),
  );
  memory.learn(
    ulid(),
    { ...lesson, when: "Mobile browser", procedure: "Use the responsive browser route." },
    ulid(),
  );
  expect(memory.experiences()).toHaveLength(2);
  const selected = memory.bootMemory("northstar on the mobile browser").memory;
  expect(selected).toContain("responsive browser route");
  expect(selected).not.toContain("older desktop route");
});

it("can recall a durable fact saved earlier in the same task after context compaction", () => {
  const { memory } = fixture();
  const session = ulid();
  memory.apply(session, "USER.md", "append", "Prefers metric units for measurements");
  expect(memory.recallMemory("measurement units", session)).toContain("metric units");
});
