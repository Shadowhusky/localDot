import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvent, ulid } from "@localdot/protocol";
import { afterEach, expect, it } from "vitest";
import { ExperienceRecorder } from "./experience-recorder.ts";
import { MemoryStore } from "./memory.ts";

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

it("automatically saves a failed-then-successful setup route only after the task finishes", () => {
  const { memory } = fixture();
  const id = ulid();
  const recorder = new ExperienceRecorder({
    memory,
    task: () => "Set up northstar repository",
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
  expect(memory.experiences()).toHaveLength(1);
  expect(memory.bootMemory("Repair northstar").memory).toContain("pnpm generate");
  expect(memory.bootMemory("Repair northstar").memory).toContain("Earlier failed attempt");
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
    task: () => "northstar",
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
