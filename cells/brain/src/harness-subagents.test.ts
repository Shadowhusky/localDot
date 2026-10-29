import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { EventOf, SubagentBrief, SubagentResume } from "@localdot/protocol";
import { APICallError } from "ai";
import { expect, it, vi } from "vitest";
import { driveHarness, type HarnessHost, type HarnessStep } from "./harness.ts";
import { subagentBrief } from "./harness-subagents.ts";

type State = EventOf<"subagent.state">["data"];
const ok = { ok: true, content: [{ type: "text" as const, text: "Completed" }] };
const done: HarnessStep = { text: "", calls: [{ id: "done", name: "done", input: {} }] };
const idle: HarnessStep = { text: "Waiting for the agents", calls: [] };
const look = (id: string, continued?: true): HarnessStep => ({
  text: "",
  calls: [{ id, name: "look", input: {} }],
  ...(continued ? { continued } : {}),
});
const start = (description: string): HarnessStep => ({
  text: "",
  calls: [
    {
      id: "spawn",
      name: "start_agent",
      input: { description, prompt: `${description} in detail` },
    },
  ],
});

function journal() {
  const records: { sessionId: string; event: unknown }[] = [];
  return {
    records,
    append: async (sessionId: string, event: unknown) => {
      records.push({ sessionId, event: structuredClone(event) });
    },
  };
}
async function* say(text: string): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
async function* fetchOnce(url: string): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "tool-call" };
  yield {
    type: "block-end",
    index: 0,
    block: {
      type: "tool-call",
      id: "fetch-source" as never,
      name: "web_fetch",
      arguments: JSON.stringify({ url }),
    },
  };
  yield { type: "finish", reason: { kind: "tool-calls" } };
}
// A model call that only ends when its request is cancelled.
async function* hang(signal?: AbortSignal): AsyncIterable<StreamChunk> {
  await new Promise<void>((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  yield { type: "finish", reason: { kind: "stop" } };
}
const limit = () =>
  new APICallError({
    message: "Insufficient credit",
    url: "http://llm.ldot/route",
    requestBodyValues: {},
    statusCode: 402,
    responseHeaders: {},
    responseBody: "{}",
  });
const flat = (options: GenerateOptions) => JSON.stringify(options.messages);
const contextOf = (request: Parameters<HarnessHost["request"]>[1]) =>
  request.context.map((item) => item.text).join("\n");
const fetchTool = { name: "web_fetch", description: "Fetch", parameters: { type: "object" } };

function host(over: Partial<HarnessHost> & Pick<HarnessHost, "request">): HarnessHost {
  return {
    sessionId: "01M5RESUMESESSION000000000A",
    task: "Research and report",
    signal: new AbortController().signal,
    execute: async (id, _signal, native) => ({
      result: native ?? ok,
      conclude: id.startsWith("done") && native?.ok !== false,
    }),
    stopping: async () => false,
    ...over,
  };
}
const childOf = (states: State[], label: string) => states.find((s) => s.label === label)?.id ?? "";

it("wakes a child a restart interrupted, with the history it had, and tells dot", async () => {
  const records = journal();
  const states: State[] = [];
  const briefs: SubagentBrief[] = [];
  const abort = new AbortController();
  let childTurns = 0;
  let rootTurns = 0;
  await expect(
    driveHarness(
      host({
        signal: abort.signal,
        journal: records,
        onSubagent: (state) => states.push(state),
        subagents: { resume: [], brief: (brief) => briefs.push(brief) },
        delegation: {
          tools: [fetchTool],
          execute: async () => ({
            ok: true,
            content: [{ type: "text", text: "Source A says 42" }],
          }),
          request: (options) =>
            childTurns++ === 0
              ? fetchOnce("https://a.example")
              : (async function* () {
                  abort.abort();
                  yield* hang(options.signal);
                })(),
        },
        request: async () => (rootTurns++ === 0 ? start("Research sources") : idle),
      }),
    ),
  ).rejects.toThrow();
  const id = childOf(states, "Research sources");
  expect(states).toEqual([
    { id, runId: expect.any(String), label: "Research sources", state: "running" },
  ]);
  const brief = briefs.at(-1) as SubagentBrief;
  expect(brief).toMatchObject({ id, instructions: "Research sources in detail" });
  expect(brief.progress).toContain("web_fetch: https://a.example");

  const resumed: State[] = [];
  const resume: SubagentResume[] = [
    { ...brief, runId: String(states[0]?.runId), reason: "restarted" },
  ];
  let history = "";
  let told = "";
  rootTurns = 0;
  await driveHarness(
    host({
      journal: records,
      onSubagent: (state) => resumed.push(state),
      subagents: { resume, brief: () => {} },
      delegation: {
        tools: [fetchTool],
        execute: async () => ok,
        request: (options) => {
          expect(options.sessionId).toBe(id);
          history = flat(options);
          return say("Source A confirmed");
        },
      },
      request: async (_signal, request) => {
        if (rootTurns++ === 0) told = contextOf(request);
        return resumed.some((s) => s.state === "completed") ? done : idle;
      },
    }),
  );
  expect(history).toContain("Source A says 42");
  expect(history).toContain("localDot resumed you");
  expect(told).toContain(`Research sources (agent ${id}): localDot restarted`);
  expect(resumed.map((s) => [s.id, s.state, s.resumed])).toEqual([
    [id, "running", true],
    [id, "completed", undefined],
  ]);
});

it("wakes a child a usage limit stopped only when dot continues after its own pause", async () => {
  const states: State[] = [];
  let childTurns = 0;
  let rootTurn = 0;
  let before = -1;
  const contexts: string[] = [];
  await driveHarness(
    host({
      onSubagent: (state) => states.push(state),
      subagents: { resume: [], brief: () => {} },
      delegation: {
        tools: [],
        execute: async () => ok,
        request: () => {
          if (childTurns++ === 0) throw limit();
          return say("Finished after the limit");
        },
      },
      request: async (_signal, request) => {
        contexts.push(contextOf(request));
        if (rootTurn++ === 0) return start("Summarise the files");
        if (!states.some((s) => s.state === "interrupted")) return idle;
        if (before === -1) {
          before = -2;
          return look("look-1");
        }
        if (before === -2) {
          before = childTurns;
          return look("look-2", true);
        }
        return states.some((s) => s.state === "completed") ? done : idle;
      },
    }),
  );
  expect(before).toBe(1);
  expect(childTurns).toBe(2);
  const id = childOf(states, "Summarise the files");
  expect(states.every((s) => s.id === id)).toBe(true);
  expect(states.map((s) => [s.state, s.reason, s.resumed])).toEqual([
    ["running", undefined, undefined],
    ["interrupted", "limit", undefined],
    ["running", undefined, true],
    ["completed", undefined, undefined],
  ]);
  expect(contexts.join("\n")).toContain("Summarise the files (agent");
});

it("hands an earlier task's unfinished agents to fresh ones within the cap, once each", async () => {
  const states: State[] = [];
  const release = new Map<string, () => void>();
  const prompts = new Map<string, string>();
  const resume = ["one", "two", "three", "four"].map(
    (name, i): SubagentResume => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      runId: `run-${name}`,
      label: `Part ${name}`,
      instructions: `Write part ${name}`,
      progress: `Its plan:\n[completed] Outline ${name}`,
      reason: i === 3 ? "error" : "restarted",
    }),
  );
  const [first, second] = resume as [SubagentResume, SubagentResume];
  const briefs: SubagentBrief[] = [];
  let told = "";
  const run = driveHarness(
    host({
      onSubagent: (state) => states.push(state),
      subagents: {
        resume: [...resume, { ...first }, { ...second, id: "stopped-agent", reason: "stopped" }],
        brief: (brief) => briefs.push(brief),
      },
      delegation: {
        tools: [],
        execute: async () => ok,
        request: (options) =>
          (async function* () {
            const id = String(options.sessionId);
            prompts.set(id, flat(options));
            await new Promise<void>((resolve) => release.set(id, resolve));
            yield* say(`Finished ${id}`);
          })(),
      },
      request: async (_signal, request) => {
        told ||= contextOf(request);
        return states.filter((s) => s.state === "completed").length === 4 ? done : idle;
      },
    }),
  );
  await vi.waitUntil(() => release.size === 3);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect([...release.keys()]).toEqual(resume.slice(0, 3).map((r) => r.id));
  release.get(first.id)?.();
  await vi.waitUntil(() => release.size === 4, { timeout: 5000 });
  for (const finish of release.values()) finish();
  await run;
  expect(told).toContain("1 more resume when a running agent finishes.");
  const started = states.filter((s) => s.state === "running");
  expect(started.map((s) => s.id)).toEqual(resume.map((r) => r.id));
  expect(started.every((s) => s.resumed && s.label.startsWith("Part "))).toBe(true);
  expect(prompts.get(first.id)).toContain("Write part one");
  expect(prompts.get(first.id)).toContain("[completed] Outline one");
  // Handed on again later, it is still asked what the first agent was.
  expect(briefs.findLast((b) => b.id === first.id)?.instructions).toBe("Write part one");
  expect(states.some((s) => s.id === "stopped-agent")).toBe(false);
});

it("leaves a child dot interrupted itself asleep when dot continues", async () => {
  const states: State[] = [];
  let rootTurn = 0;
  let childTurns = 0;
  await driveHarness(
    host({
      onSubagent: (state) => states.push(state),
      subagents: { resume: [], brief: () => {} },
      delegation: {
        tools: [],
        execute: async () => ok,
        request: (options) => {
          childTurns++;
          return hang(options.signal);
        },
      },
      request: async () => {
        rootTurn++;
        if (rootTurn === 1) return start("Watch the build");
        if (rootTurn === 2)
          return {
            text: "",
            calls: [
              {
                id: "stop-it",
                name: "interrupt_agent",
                input: { agent_id: childOf(states, "Watch the build") },
              },
            ],
          };
        return rootTurn > 6 ? done : look(`look-${rootTurn}`, true);
      },
    }),
  );
  expect(childTurns).toBe(1);
  expect(states.map((s) => [s.state, s.reason])).toEqual([
    ["running", undefined],
    ["interrupted", "cancelled"],
  ]);
});

it("briefs a child from its own log within its bounds", () => {
  const event = (seq: number, type: string, data: unknown) =>
    ({ type, seq, time: seq, data }) as never;
  const brief = subagentBrief("child", "Audit copy", [
    event(1, "user/message", {
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Audit every heading" }],
    }),
    event(2, "todo/write", {
      todos: [
        { content: "Read the pages", status: "completed" },
        { content: "List fixes", status: "in_progress" },
      ],
    }),
    ...Array.from({ length: 30 }, (_, i) =>
      event(3 + i, "tool/call", {
        name: "shell",
        arguments: JSON.stringify({ command: "rg x", intent: `Search pass ${i}` }),
      }),
    ),
    event(40, "assistant/message", {
      message: { content: [{ type: "text", text: "x".repeat(20_000) }] },
    }),
    event(41, "user/message", {
      role: "user",
      source: { kind: "agent-message" },
      content: [{ type: "text", text: "Also check the footer" }],
    }),
  ]);
  expect(brief.instructions).toBe("Audit every heading\n\nAlso check the footer");
  expect(brief.progress).toContain("[in_progress] List fixes");
  expect(brief.progress).toContain("shell: Search pass 29");
  expect(brief.progress).not.toContain("Search pass 21\n");
  expect(brief.progress.length).toBeLessThanOrEqual(5000);
});
