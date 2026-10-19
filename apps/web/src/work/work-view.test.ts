import { type LocalDotEvent, ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyAgentModel } from "../agent/model.ts";
import { projectAgentEvent } from "../agent/reducer.ts";
import { WORK_LIMITS, WorkHistory, workCard, workTail } from "./work-view.ts";

const step = ulid();
const event = (seq: number, type: string, data: unknown, id = step) =>
  ({
    v: 1,
    id: ulid(),
    seq,
    t: seq * 1_000_000,
    agent: "main",
    step: id,
    type,
    data,
  }) as LocalDotEvent;
function start(tool = "shell") {
  return projectAgentEvent(emptyAgentModel(), event(0, "tool.start", { tool, title: "Run tests" }));
}
describe("work display projection", () => {
  it("bounds both long lines and many lines", () => {
    for (const text of ["a".repeat(200_000), "line\n".repeat(10000)]) {
      const result = workTail(text);
      expect(result.shortened).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(WORK_LIMITS.text);
      expect(result.text.split("\n").length).toBeLessThanOrEqual(WORK_LIMITS.lines);
    }
  });
  it("uses terminal control sanitization and never mutates the model", () => {
    const model = projectAgentEvent(
      start(),
      event(1, "tool.output", {
        stream: "stdout",
        chunk: "\x1b[31mPASS\x1b[0m\n<script>not executable</script>",
      }),
    );
    const before = JSON.stringify(model);
    expect(workCard(model)?.text).toBe("PASS\n<script>not executable</script>");
    expect(JSON.stringify(model)).toBe(before);
  });
  it("shows only file changes attached to the current step", () => {
    let model = projectAgentEvent(
      start("files"),
      event(1, "file.change", { path: "a.txt", op: "modify", patch: "+new" }),
    );
    expect(workCard(model)?.text).toContain("a.txt\n+new");
    model = projectAgentEvent(
      model,
      event(2, "tool.start", { tool: "shell", title: "Next command" }, ulid()),
    );
    expect(workCard(model)?.text).not.toContain("a.txt");
  });
  it("leaves visual tools, unknown tools, and human handovers on the actual screen", () => {
    for (const tool of ["computer", "browser_read", "private_input", "unknown"])
      expect(workCard(start(tool))).toBeNull();
    for (const patch of [{ pendingAsk: "ask" }, { pendingTakeover: "handover" }])
      expect(workCard({ ...start(), ...patch })).toBeNull();
  });
  it("never exposes future output when seeking backwards", () => {
    const history = new WorkHistory();
    let model = emptyAgentModel();
    for (const e of [
      event(0, "tool.start", { tool: "shell", title: "Run" }),
      event(1, "tool.output", { stream: "stdout", chunk: "first\n" }),
      event(2, "tool.output", { stream: "stdout", chunk: "future\n" }),
    ]) {
      model = projectAgentEvent(model, e);
      history.add(e, model);
    }
    expect(history.at(999)?.text).toBe("");
    expect(history.at(1000)?.text).toBe("first\n");
    expect(history.at(2000)?.text).toContain("future");
    expect(history.at(1500)?.text).not.toContain("future");
  });
  it("bounds a long replay and falls back to the original screen outside retained work", () => {
    const history = new WorkHistory();
    let model = start();
    for (let i = 1; i < 1000; i++) {
      const e = event(i, "tool.output", { stream: "stdout", chunk: `${"a".repeat(7000)} ${i}\n` });
      model = projectAgentEvent(model, e);
      history.add(e, model);
    }
    expect(history.frames.length).toBe(WORK_LIMITS.frames);
    expect(JSON.stringify(history.frames).length).toBeLessThan(1_100_000);
    expect(history.at(0)).toBeNull();
    const saved = history.frames.length;
    history.add(event(1, "tool.output", { stream: "stdout", chunk: "old" }), model);
    expect(history.frames.length).toBe(saved);
  });
});
