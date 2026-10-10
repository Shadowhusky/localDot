import { afterEach, expect, it } from "vitest";
import { ExperienceRecorder } from "../experience-recorder.ts";
import { MemoryStore } from "../memory.ts";
import { toolHarness } from "../testing/harness.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function fixture() {
  const base = toolHarness();
  const h = { ...base, memory: new MemoryStore(base.home) };
  fixtures.push(h);
  const recorder = new ExperienceRecorder({ memory: h.memory, changed: () => {} });
  h.eventLog.subscribe((id, event) => recorder.event(id, event));
  h.tools.saveExperience = (id, lesson) => recorder.save(id, lesson);
  return h;
}

it.each([undefined, null])(
  "finishes in one call with no lesson (%s), even at the action limit",
  async (experience) => {
    const h = fixture();
    h.session.actionLimit = 4;
    for (let i = 0; i < 3; i++) await h.call("shell", { command: "pwd" });
    const done = await h.call("done", {
      summary: "Checked",
      ...(experience === undefined ? {} : { experience }),
    });
    expect(done.body.ok).toBe(true);
    expect(done.body.final).toBe(true);
    expect(h.events().some((e) => e.type === "task.result")).toBe(true);
    expect(h.memory.experiences()).toHaveLength(0);
  },
);

it("saves a distilled lesson, then retrieves its full procedure through recall", async () => {
  const h = fixture();
  await h.call("shell", { command: "pwd" });
  const experience = {
    scope: "Report export",
    when: "Long tables span multiple pages",
    procedure: "Repeat the header on each page and verify the exported document.",
    recheck: "Inspect the first and last page.",
    cues: ["paginated tables"],
    outcome: "worked",
  };
  const result = await h.call("done", { summary: "Checked", experience });
  expect(result.body.final).toBe(true);
  expect(h.memory.experiences()).toHaveLength(1);
  // Simulate the next run's lookup, excluding its own ID rather than the source task.
  h.tools.recallExperience = (query) => h.memory.recallMemory(query, "next-task");
  const recall = await h.call("recall", { query: "paginated tables" });
  expect(recall.body.content[0]?.text).toContain(experience.procedure);
  expect(recall.body.content[0]?.text).toContain("<untrusted");
  expect(h.session.taint.sources).toContainEqual({ kind: "recall", origin: "earlier tasks" });
});
