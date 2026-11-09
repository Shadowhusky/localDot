import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../event-log.ts";
import { redactor } from "../redact.ts";
import { sideQuestionEvents, sideQuestionPrompt } from "../side-question.ts";
import { runSideAgent, type SideGo } from "./agent.ts";
import type { SideReaders } from "./tools.ts";

// Questions the old one-shot answer couldn't reach, on one task: each fact is in the task's record
// somewhere, but not in what was said, which was all a side question was given.
let home: string;
let log: EventLog;
let id: string;
let frameId: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ld-side-answers-"));
  log = new EventLog(home);
  id = log.createSession("task");
  const say = (type: string, data: Record<string, unknown>, step?: string) =>
    log.append(id, { type, agent: "main", data, ...(step ? { step } : {}) } as never);
  say("message.user", { messageId: ulid(), kind: "task", text: "Fix the build and report back." });
  say("message.assistant", { messageId: ulid(), text: "On it." });
  const shell = ulid();
  say("step.start", { kind: "shell", intent: "Running the tests" }, shell);
  say("tool.start", { tool: "shell", title: "pnpm test" }, shell);
  say(
    "tool.output",
    { stream: "stderr", chunk: "FAIL src/cart.test.ts\nExpected 12,480 but got 12,311\n" },
    shell,
  );
  say("tool.end", { ok: false, exitCode: 1 }, shell);
  say("step.end", { status: "failed" }, shell);
  say("thought.delta", { text: "The December row looks double counted." });
  frameId = ulid();
  say("observe", { frameId, width: 1280, height: 800 });
});
afterAll(() => {
  log.close();
  rmSync(home, { recursive: true, force: true });
});

const readers = (): SideReaders => ({
  sessionId: id,
  logFile: log.logFile(id),
  redact: redactor([]),
  frame: async () => ({ png: Buffer.from("the-frame"), ageMs: 8000 }),
  desktop: () =>
    ({
      readFile: async () => ({
        path: "~/notes/plan.md",
        content: "Ship on Friday.",
        bytes: 15,
        truncated: false,
        binary: false,
      }),
      listDir: async () => ({
        path: "~",
        entries: [{ name: "plan.md", type: "file", bytes: 15 }],
        truncated: false,
      }),
      fetchFile: async () => {
        throw new Error("not used");
      },
    }) as never,
  handedFiles: async () => [{ sessionId: id, name: "report.md", bytes: 20, available: true }],
  handedFile: () => "Total net: 12,480",
  recall: () => [
    {
      title: "Quarterly close",
      day: "2026-10-02",
      kind: "summary",
      snippet: "We agreed to round to the nearest ten.",
    },
  ],
  web: {
    get: async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      body: Buffer.from(
        "<html><head><title>Docs</title></head><body><p>Release 4.2 fixes rounding.</p></body></html>",
      ),
      truncated: false,
    }),
  },
});

async function asked(
  question: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ read: string; images: number; sources: readonly string[]; steps: string[] }> {
  const steps: string[] = [];
  let read = "";
  let images = 0;
  const { prompt, system } = sideQuestionPrompt(sideQuestionEvents(log.logFile(id)), question);
  const reply = await runSideAgent({
    models: [
      {
        provider: "test",
        model: "m",
        role: "main",
        tools: true,
        images: true,
        run: async (go: SideGo) => {
          const result = await go.tools.call(tool, input, go.signal);
          read = result.text;
          images = result.images?.length ?? 0;
          await go.tools.call("finish", { status: "found", answer: "Answered." }, go.signal);
        },
      },
    ],
    readers: readers(),
    question,
    system,
    prompt,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if ("progress" in event) steps.push(event.progress);
    },
  });
  return { read, images, sources: reply.sources, steps };
}

const record = (question: string) =>
  sideQuestionPrompt(sideQuestionEvents(log.logFile(id)), question).prompt;

describe("what a side question can answer now that it couldn't", () => {
  it.each([
    [
      "Why did the tests fail?",
      "search_log",
      { query: "FAIL", only: "terminal" },
      "Expected 12,480 but got 12,311",
      "terminal",
      "Checking the terminal output…",
    ],
    [
      "Why does dot think December is wrong?",
      "search_log",
      { query: "December" },
      "double counted",
      "log",
      "Searching the task's log…",
    ],
    [
      "What's in plan.md?",
      "read_file",
      { path: "~/notes/plan.md" },
      "Ship on Friday.",
      "file",
      "Reading plan.md…",
    ],
    [
      "What's the total in the report?",
      "task_files",
      { name: "report.md" },
      "Total net: 12,480",
      "deliverable",
      "Reading report.md…",
    ],
    [
      "What did we agree last quarter?",
      "recall",
      { query: "rounding agreed" },
      "round to the nearest ten",
      "earlier",
      "Searching earlier conversations…",
    ],
    [
      "What does https://example.org/release say?",
      "web_fetch",
      { url: "https://example.org/release" },
      "Release 4.2 fixes rounding.",
      "web",
      "Reading example.org…",
    ],
  ])("%s", async (question, tool, input, fact, source, step) => {
    // Not in the record it used to be given alone.
    expect(record(question)).not.toContain(fact);
    const { read, sources, steps } = await asked(question, tool, input);
    expect(read).toContain(fact);
    expect(sources).toContain(source);
    expect(steps).toEqual([step]);
  });

  it("What's on the screen?", async () => {
    expect(record("What's on the screen?")).not.toContain("the-frame");
    const { read, images, sources, steps } = await asked(
      "What's on the screen?",
      "look_at_screen",
      {},
    );
    expect(images).toBe(1);
    expect(read).toContain("as dot last saw it 8 seconds ago");
    expect(sources).toEqual(["screen"]);
    expect(steps).toEqual(["Looking at the screen…"]);
  });
});
