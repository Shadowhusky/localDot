import { type BrainEvent, ulid } from "@localdot/protocol";
import { APICallError } from "ai";
import { expect, it, vi } from "vitest";
import { EventSink } from "./events.ts";
import type { HarnessStep } from "./harness.ts";
import { Agent } from "./loop.ts";
import { bootConfig, call, fakeApi, say, scriptedModel, type Turn } from "./testing/scripted.ts";

const steps = vi.hoisted((): (HarnessStep | undefined)[] => []);
vi.mock("./harness.ts", async (original) => {
  const actual = await original<typeof import("./harness.ts")>();
  return {
    ...actual,
    driveHarness: (host: Parameters<typeof actual.driveHarness>[0]) =>
      actual.driveHarness({
        ...host,
        request: async (signal, request) => {
          const step = await host.request(signal, request);
          steps.push(step);
          return step;
        },
      }),
  };
});

const credit = () =>
  new APICallError({
    message: "Your credit balance is too low",
    url: "http://llm.ldot/anthropic/messages",
    requestBodyValues: {},
    statusCode: 402,
    isRetryable: false,
  });

// The parent and its delegated agents share one model; each prompt goes to its own script.
function run(parent: Turn[], child: Turn[], boot: Parameters<typeof bootConfig>[0] = {}) {
  const f = fakeApi();
  const events: BrainEvent[] = [];
  const sink = new EventSink({
    send: async (e) => void events.push(...e),
    flushMs: 1,
    heartbeatMs: 10_000,
  });
  const model = scriptedModel(
    Array.from({ length: 30 }, () => () => {
      const delegated = JSON.stringify(model.prompts.at(-1)).includes("localDot subagent");
      const turn = (delegated ? child : parent).shift() ?? say("(out of script)");
      return typeof turn === "function" ? turn() : turn;
    }),
  );
  const agent = new Agent({
    boot: bootConfig(boot),
    api: f.api,
    sink,
    models: { main: model.model },
    history: [],
    sleep: async () => {},
    pauseWaitMs: 1,
  });
  return {
    f,
    events,
    model,
    outcome: agent.run(new AbortController().signal).finally(() => sink.close()),
  };
}

it("tells the harness the step after a usage-limit pause continues the task", async () => {
  steps.length = 0;
  let t: ReturnType<typeof run>;
  t = run(
    [
      () => {
        t.f.inbox.push({ seq: 1, messageId: ulid(), kind: "resume", text: "" });
        return credit();
      },
      call("update_plan", { items: [{ id: "a", text: "Check", status: "done" }] }),
      call("done", { summary: "Done" }),
    ],
    [],
  );
  expect(await t.outcome).toBe("done");
  expect(steps.map((step) => step?.continued)).toEqual([true, undefined]);
});

it("wakes the agents an earlier task left unfinished before dot's first request", async () => {
  steps.length = 0;
  const id = "00000000-0000-4000-8000-000000000001";
  const t = run(
    [
      call("done", { summary: "Report ready" }),
      call("done", { summary: "Report ready" }),
      call("done", { summary: "Report ready" }),
    ],
    [say("The report is written to ~/report.md")],
    {
      subagents: [
        {
          id,
          runId: "run-1",
          label: "Write the report",
          instructions: "Write the quarterly report",
          progress: "Its plan:\n[completed] Gather the figures",
          reason: "restarted",
        },
      ],
    },
  );
  expect(await t.outcome).toBe("done");
  const [first] = t.model.prompts.filter((p) => !JSON.stringify(p).includes("localDot subagent"));
  expect(JSON.stringify(first)).toContain(`Write the report (agent ${id}): localDot restarted`);
  const delegated = JSON.stringify(
    t.model.prompts.find((p) => JSON.stringify(p).includes("localDot subagent")),
  );
  expect(delegated).toContain("Write the quarterly report");
  expect(delegated).toContain("[completed] Gather the figures");
  expect(
    t.events.flatMap((e) =>
      e.type === "subagent.state" ? [[e.data.id, e.data.state, e.data.resumed]] : [],
    ),
  ).toEqual([
    [id, "running", true],
    [id, "completed", undefined],
  ]);
});
