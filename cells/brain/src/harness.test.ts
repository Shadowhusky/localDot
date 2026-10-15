import { describe, expect, it, vi } from "vitest";
import { driveHarness, type HarnessHost, type HarnessStep } from "./harness.ts";

const result = { ok: true, content: [{ type: "text" as const, text: "Completed" }] };
const step = (...names: string[]): HarnessStep => ({
  text: "Working",
  calls: names.map((name, i) => ({ name, id: `${name}-${i}`, input: {} })),
});
function host(over: Partial<HarnessHost> = {}): HarnessHost {
  return {
    sessionId: "test-session",
    task: "Test the harness",
    signal: new AbortController().signal,
    request: async () => step("done"),
    execute: async () => ({ result, conclude: true }),
    stopping: async () => false,
    ...over,
  };
}

describe("DeepSeek Harness boundary", () => {
  it("runs serially and concludes without another model request", async () => {
    const order: string[] = [];
    let active = false;
    const request = vi.fn(async () => step("shell", "files", "done"));
    await driveHarness(
      host({
        request,
        execute: async (id) => {
          expect(active).toBe(false);
          active = true;
          await new Promise((resolve) => setTimeout(resolve, 1));
          order.push(id);
          active = false;
          return { result, conclude: id.startsWith("done") };
        },
      }),
    );
    expect(order).toEqual(["shell-0", "files-1", "done-2"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("honors continuation at the turn boundary", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ text: "Checking", calls: [] })
      .mockResolvedValueOnce(step("done"));
    const stopping = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    await driveHarness(host({ request, stopping }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("propagates Stop while a model request is waiting", async () => {
    const abort = new AbortController();
    let active: AbortSignal | undefined;
    const run = driveHarness(
      host({
        signal: abort.signal,
        request: async (signal) => {
          active = signal;
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      }),
    );
    const assertion = expect(run).rejects.toThrow();
    await vi.waitUntil(() => !!active);
    abort.abort();
    expect(active?.aborted).toBe(true);
    await assertion;
  });

  it("does not swallow a tool transport or persistence error and run later actions", async () => {
    const execute = vi.fn(async () => {
      throw new Error("durable append failed");
    });
    const request = vi.fn(async () => step("shell", "files"));
    await expect(driveHarness(host({ request, execute }))).rejects.toThrow("durable append failed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("disposes the session so the same conversation can run again", async () => {
    await driveHarness(host());
    await driveHarness(host());
  });
});

describe("upstream agent capabilities reach the provider", () => {
  it("offers the upstream todo schema and settles valid and invalid native calls", async () => {
    let turn = 0;
    const native: unknown[] = [];
    await driveHarness(
      host({
        request: async (_signal, request) => {
          expect(
            request.tools.find((tool) => tool.name === "todo_write")?.parameters,
          ).toBeDefined();
          if (turn++ === 0)
            return {
              text: "Planning",
              calls: [
                {
                  id: "plan",
                  name: "todo_write",
                  input: { todos: [{ content: "Research approaches", status: "in_progress" }] },
                },
              ],
            };
          if (turn === 2)
            return {
              text: "",
              calls: [
                {
                  id: "invalid",
                  name: "todo_write",
                  input: { todos: [{ content: "", status: "pending" }] },
                },
              ],
            };
          return step("done");
        },
        execute: async (id, _signal, output) => {
          if (output) native.push({ id, ok: output.ok, text: output.content });
          return { result: output ?? result, conclude: id.startsWith("done") };
        },
      }),
    );
    expect(native).toEqual([
      expect.objectContaining({ id: "plan", ok: true }),
      expect.objectContaining({ id: "invalid", ok: false }),
    ]);
  });

  it("discovers a newly installed skill, loads upstream instructions and honors invocation policy", async () => {
    let installed = false;
    let turn = 0;
    const read = vi.fn(async (input: { op: string; path: string }) => {
      const bodies: Record<string, string> = {
        "/config/.agents/skills/verified-tool/SKILL.md":
          "---\nname: verified-tool\ndescription: A verified workflow\n---\nInspect inputs and use references/check.md before exporting.",
        "/config/.agents/skills/manual-only/SKILL.md":
          "---\nname: manual-only\ndescription: User only\ndisable-model-invocation: true\n---\nManual instructions.",
      };
      if (input.op === "list")
        return {
          ok: true,
          content: [],
          fileList: {
            path: input.path,
            truncated: false,
            entries:
              input.path === "/config/.agents/skills" && installed
                ? ["verified-tool", "manual-only"].map((name) => ({
                    name,
                    type: "dir" as const,
                    bytes: 0,
                  }))
                : [],
          },
        };
      const content = bodies[input.path];
      if (!content) return { ok: false, content: [], fileError: "not_found" as const };
      return {
        ok: true,
        content: [],
        fileRead: {
          path: input.path,
          content,
          bytes: content.length,
          binary: false,
          truncated: false,
        },
      };
    });
    await driveHarness(
      host({
        skills: { read },
        request: async (_signal, request) => {
          const context = request.context.map((item) => item.text).join("\n");
          if (turn++ === 0) {
            expect(context).not.toContain("verified-tool");
            return step("shell");
          }
          expect(context).toContain("verified-tool");
          expect(context).not.toContain("manual-only");
          if (turn === 2)
            return {
              text: "Loading the chosen workflow",
              calls: [{ id: "load", name: "skill", input: { name: "verified-tool" } }],
            };
          return step("done");
        },
        execute: async (id, _signal, output) => {
          if (id.startsWith("shell")) installed = true;
          if (id === "load") {
            expect(output?.ok).toBe(true);
            expect(JSON.stringify(output?.content)).toContain("references/check.md");
            expect(JSON.stringify(output?.content)).toContain(
              "/config/.agents/skills/verified-tool",
            );
          }
          return { result: output ?? result, conclude: id.startsWith("done") };
        },
      }),
    );
    expect(read).toHaveBeenCalled();
  });

  it("passes the actual upstream repeat-call reminder to the next model request", async () => {
    let turn = 0;
    await driveHarness(
      host({
        request: async (_signal, request) => {
          if (turn++ < 3) return step("browser_read");
          expect(request.context.some((item) => /repeat|different|same/i.test(item.text))).toBe(
            true,
          );
          return step("done");
        },
        execute: async (id) => ({ result, conclude: id.startsWith("done") }),
      }),
    );
  });
});

it("refuses a native planning call before executing its body when the host blocks execution", async () => {
  const load = vi.fn();
  let turn = 0;
  await driveHarness(
    host({
      beforeNativeCall: async () => "User has control",
      request: async () =>
        turn++ === 0
          ? {
              text: "",
              calls: [
                {
                  id: "plan",
                  name: "todo_write",
                  input: { todos: [{ content: "Must not run", status: "in_progress" }] },
                },
              ],
            }
          : step("done"),
      execute: async (id, _signal, output) => {
        if (id === "plan") {
          expect(output?.ok).toBe(false);
          load(output);
        }
        return { result: output ?? result, conclude: id.startsWith("done") };
      },
    }),
  );
  expect(load).toHaveBeenCalledOnce();
});

it("reloads changed skill instructions and retains the catalog, not stale bodies, during an outage", async () => {
  let version = 1;
  let offline = false;
  let turn = 0;
  const read = async (input: { op: string; path: string }) => {
    if (offline) throw new Error("Computer temporarily unavailable");
    if (input.op === "list")
      return {
        ok: true,
        content: [],
        fileList: {
          path: input.path,
          truncated: false,
          entries:
            input.path === "/config/.agents/skills"
              ? [{ name: "test-workflow", type: "dir" as const, bytes: 0 }]
              : [],
        },
      };
    if (input.path !== "/config/.agents/skills/test-workflow/SKILL.md")
      return { ok: false, content: [], fileError: "not_found" as const };
    const content = `---\nname: test-workflow\ndescription: Current workflow\n---\nWorkflow revision ${version}`;
    return {
      ok: true,
      content: [],
      fileRead: {
        path: input.path,
        content,
        bytes: content.length,
        binary: false,
        truncated: false,
      },
    };
  };
  const outputs: string[] = [];
  await driveHarness(
    host({
      skills: { read },
      request: async (_signal, request) => {
        expect(request.context.some((item) => item.text.includes("test-workflow"))).toBe(true);
        switch (turn++) {
          case 0:
          case 2:
          case 4:
            return {
              text: "",
              calls: [{ id: `load-${turn}`, name: "skill", input: { name: "test-workflow" } }],
            };
          case 1:
          case 3:
            return step("shell");
          default:
            return step("done");
        }
      },
      execute: async (id, _signal, output) => {
        if (id.startsWith("shell")) {
          if (version === 1) version = 2;
          else offline = true;
        }
        if (output) {
          outputs.push(JSON.stringify(output.content));
          expect(output.ok).toBe(!offline);
        }
        return { result: output ?? result, conclude: id.startsWith("done") };
      },
    }),
  );
  expect(outputs[0]).toContain("Workflow revision 1");
  expect(outputs[1]).toContain("Workflow revision 2");
  expect(outputs[2]).not.toContain("Workflow revision");
});

it.each(["binary", "truncated"] as const)(
  "does not load %s skill instructions as a valid workflow",
  async (flag) => {
    let invalid = false;
    let turn = 0;
    await driveHarness(
      host({
        skills: {
          read: async (input) => {
            if (input.op === "list")
              return {
                ok: true,
                content: [],
                fileList: {
                  path: input.path,
                  truncated: false,
                  entries:
                    input.path === "/config/.agents/skills"
                      ? [{ name: "test-workflow", type: "dir", bytes: 0 }]
                      : [],
                },
              };
            const content =
              "---\nname: test-workflow\ndescription: Workflow\n---\nDO NOT LOAD THIS PARTIAL BODY";
            return {
              ok: true,
              content: [],
              fileRead: {
                path: input.path,
                content,
                bytes: content.length,
                binary: false,
                truncated: false,
                [flag]: invalid,
              },
            };
          },
        },
        request: async () => {
          invalid = true; // Discovery succeeded; the subsequent load must independently validate.
          return turn++ === 0
            ? { text: "", calls: [{ id: "load", name: "skill", input: { name: "test-workflow" } }] }
            : step("done");
        },
        execute: async (id, _signal, output) => {
          if (id === "load") {
            expect(output?.ok).toBe(false);
            expect(JSON.stringify(output?.content)).not.toContain("DO NOT LOAD");
          }
          return { result: output ?? result, conclude: id.startsWith("done") };
        },
      }),
    );
  },
);

it("persists upstream goal state and resumes it without replaying completed tool bodies", async () => {
  const records: { sessionId: string; event: unknown }[] = [];
  const journal = {
    records,
    append: async (sessionId: string, event: unknown) => {
      records.push({ sessionId, event: structuredClone(event) });
    },
  };
  let turn = 0;
  let created = "";
  await driveHarness(
    host({
      journal,
      request: async () =>
        turn++ === 0
          ? {
              text: "",
              calls: [
                {
                  id: "create",
                  name: "create_goal",
                  input: {
                    objective: "Verify and deliver the complete project",
                    max_goal_rounds: 3,
                  },
                },
              ],
            }
          : step("done"),
      execute: async (id, _signal, native) => {
        if (id === "create") {
          expect(native?.ok).toBe(true);
          created = JSON.stringify(native?.content);
        }
        return { result: native ?? result, conclude: id.startsWith("done") };
      },
    }),
  );
  expect(records[0]?.event).toMatchObject({ type: "localdot/harness-header" });
  expect(records.some((r) => (r.event as { type: string }).type === "goal/change")).toBe(true);
  turn = 0;
  await driveHarness(
    host({
      journal,
      request: async () => (turn++ === 0 ? step("get_goal") : step("done")),
      execute: async (id, _signal, native) => {
        if (id.startsWith("get_goal")) {
          expect(native?.ok).toBe(true);
          expect(JSON.stringify(native?.content)).toContain(
            "Verify and deliver the complete project",
          );
          expect(JSON.stringify(native?.content)).toContain("disarmed");
        }
        return { result: native ?? result, conclude: id.startsWith("done") };
      },
    }),
  );
  expect(created).toContain("armed");
});

it("checkpoints every tool before effects and propagates a durable storage failure", async () => {
  const execute = vi.fn(async () => ({ result, conclude: true }));
  await expect(
    driveHarness(
      host({
        execute,
        journal: {
          records: [],
          append: async () => {
            throw new Error("storage offline");
          },
        },
      }),
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("runs an upstream child with its own model context and only delegated tools", async () => {
  let parentTurn = 0,
    childTurn = 0;
  const executeChild = vi.fn(async () => result);
  await driveHarness(
    host({
      delegation: {
        tools: [
          {
            name: "web_fetch",
            description: "Fetch a public source",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
            },
          },
        ],
        request: async function* (options) {
          expect(options.sessionId).not.toBe("test-session");
          expect(options.tools?.map((tool) => tool.name).sort()).toEqual([
            "todo_write",
            "web_fetch",
          ]);
          if (childTurn++ === 0) {
            yield { type: "block-start", index: 0, blockType: "tool-call" };
            yield {
              type: "block-end",
              index: 0,
              block: {
                type: "tool-call",
                id: "child-fetch" as never,
                name: "web_fetch",
                arguments: '{"url":"https://example.com"}',
              },
            };
            yield { type: "finish", reason: { kind: "tool-calls" } };
          } else {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield {
              type: "block-end",
              index: 0,
              block: { type: "text", text: "Verified research result" },
            };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        },
        execute: executeChild,
      },
      request: async () =>
        parentTurn++ === 0
          ? {
              text: "Delegating research",
              calls: [
                {
                  id: "delegate",
                  name: "subagent",
                  input: {
                    description: "Research",
                    prompt: "Find and verify the best tool",
                    run_in_background: false,
                  },
                },
              ],
            }
          : step("done"),
      execute: async (id, _signal, native) => {
        if (id === "delegate") {
          expect(native?.ok).toBe(true);
          expect(JSON.stringify(native?.content)).toContain("Verified research result");
        }
        return { result: native ?? result, conclude: id.startsWith("done") };
      },
    }),
  );
  expect(executeChild).toHaveBeenCalledTimes(1);
});

it("continues an active upstream goal after a model stops mid-task", async () => {
  let turn = 0;
  await driveHarness(
    host({
      request: async (_signal, request) => {
        turn++;
        if (turn === 1)
          return {
            text: "",
            calls: [
              {
                id: "goal",
                name: "create_goal",
                input: { objective: "Finish the whole requested task", max_goal_rounds: 2 },
              },
            ],
          };
        if (turn === 2) return { text: "First part finished", calls: [] };
        expect(request.context.some((item) => item.kind === "goal")).toBe(true);
        return step("done");
      },
      execute: async (id, _signal, native) => ({
        result: native ?? result,
        conclude: id.startsWith("done"),
      }),
      stopping: async () => false,
    }),
  );
  expect(turn).toBe(3);
});

it("starts a durable child, lists it and continues it through upstream messaging", async () => {
  let parentTurn = 0,
    childId = "",
    childTurns = 0;
  const records: { sessionId: string; event: unknown }[] = [];
  await driveHarness(
    host({
      journal: {
        records,
        append: async (sessionId, event) => {
          records.push({ sessionId, event: structuredClone(event) });
        },
      },
      delegation: {
        tools: [],
        execute: async () => result,
        request: async function* () {
          childTurns++;
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "Research complete" } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      request: async () => {
        parentTurn++;
        if (parentTurn === 1)
          return {
            text: "",
            calls: [
              {
                id: "spawn",
                name: "start_agent",
                input: { description: "Research", prompt: "Inspect the best approach" },
              },
            ],
          };
        if (parentTurn === 2) return step("list_agents");
        if (parentTurn === 3)
          return {
            text: "",
            calls: [
              {
                id: "continue",
                name: "send_message",
                input: { agent_id: childId, message: "Check the final detail" },
              },
            ],
          };
        return step("done");
      },
      execute: async (id, _signal, native) => {
        if (id === "spawn") {
          expect(native?.ok).toBe(true);
          const text =
            native?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
          childId = /started subagent ([^\s]+)/.exec(text)?.[1] ?? "";
          expect(childId).not.toBe("");
        }
        if (id.startsWith("list_agents")) {
          expect(native?.ok).toBe(true);
          expect(JSON.stringify(native?.content)).toContain(childId);
        }
        if (id === "continue") expect(native?.ok).toBe(true);
        return {
          result: native ?? result,
          conclude: id.startsWith("done") && native?.ok !== false,
        };
      },
    }),
  );
  expect(childTurns).toBe(2);
  expect(records.some((record) => record.sessionId === childId)).toBe(true);
  let resumed = 0;
  let resumeTurns = 0;
  await driveHarness(
    host({
      journal: {
        records,
        append: async (sessionId, event) => {
          records.push({ sessionId, event: structuredClone(event) });
        },
      },
      delegation: {
        tools: [],
        execute: async () => result,
        request: async function* (options) {
          expect(options.sessionId).toBe(childId);
          expect(JSON.stringify(options.messages)).toContain("Research complete");
          resumed++;
          yield { type: "block-start", index: 0, blockType: "text" };
          yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text: "Resumed verification complete" },
          };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      request: async () => {
        if (resumeTurns++ === 0)
          return {
            text: "",
            calls: [
              {
                id: "resume-child",
                name: "send_message",
                input: { agent_id: childId, message: "Continue after restart" },
              },
            ],
          };
        return step("done");
      },
      execute: async (id, _signal, native) => {
        if (id === "resume-child") expect(native?.ok, JSON.stringify(native)).toBe(true);
        return {
          result: native ?? result,
          conclude: id.startsWith("done") && native?.ok !== false,
        };
      },
    }),
  );
  expect(resumed).toBe(1);
});

it("deduplicates journal retries and rejects corrupt replay before model admission", async () => {
  const records: { sessionId: string; event: unknown }[] = [];
  await driveHarness(
    host({
      journal: {
        records,
        append: async (sessionId, event) => {
          const record = { sessionId, event: structuredClone(event) };
          records.push(record, structuredClone(record));
        },
      },
    }),
  );
  await driveHarness(host({ journal: { records, append: async () => {} } }));
  const damaged = structuredClone(records);
  const header = damaged[1]?.event as { header: { id: string } };
  header.header.id = "different-owner";
  const request = vi.fn(async () => step("done"));
  await expect(
    driveHarness(host({ request, journal: { records: damaged, append: async () => {} } })),
  ).rejects.toThrow("Conflicting harness header");
  expect(request).not.toHaveBeenCalled();
});

it("Stop aborts a background child's model and prevents further child effects", async () => {
  const abort = new AbortController();
  let childSignal: AbortSignal | undefined;
  let turn = 0;
  const execute = vi.fn(async () => result);
  const running = driveHarness(
    host({
      signal: abort.signal,
      delegation: {
        tools: [],
        execute,
        request: async function* (options) {
          childSignal = options.signal;
          await new Promise<void>((_, reject) =>
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            }),
          );
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      request: async () =>
        turn++ === 0
          ? {
              text: "",
              calls: [
                {
                  id: "background",
                  name: "start_agent",
                  input: { description: "Research", prompt: "Inspect the source" },
                },
              ],
            }
          : { text: "Waiting for research", calls: [] },
      execute: async (_id, _signal, native) => ({ result: native ?? result, conclude: false }),
    }),
  );
  const finished = expect(running).rejects.toThrow();
  await vi.waitUntil(() => !!childSignal);
  abort.abort();
  await finished;
  expect(childSignal?.aborted).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

it("does not let a goal restart work after the host reaches its run limit", async () => {
  let turns = 0;
  await driveHarness(
    host({
      request: async () =>
        ++turns === 1
          ? {
              text: "",
              calls: [
                {
                  id: "goal",
                  name: "create_goal",
                  input: { objective: "Finish the project", max_goal_rounds: 10 },
                },
              ],
            }
          : undefined,
      execute: async (_id, _signal, native) => ({ result: native ?? result, conclude: false }),
    }),
  );
  expect(turns).toBe(2);
});

it("waits without nudging or abandoning a child and consumes its completion wakeup", async () => {
  let turn = 0;
  const stopping = vi.fn(async () => false);
  let completed = false;
  await driveHarness(
    host({
      stopping,
      delegation: {
        tools: [],
        execute: async () => result,
        request: async function* () {
          await new Promise((resolve) => setTimeout(resolve, 60));
          yield { type: "block-start", index: 0, blockType: "text" };
          yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text: "CHILD_RESEARCH_VERIFIED" },
          };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
      request: async (_signal, request) => {
        turn++;
        if (turn === 1)
          return {
            text: "",
            calls: [
              {
                id: "child",
                name: "start_agent",
                input: { description: "Research", prompt: "Inspect source" },
              },
            ],
          };
        if (turn === 2) return { text: "Waiting for delegated research", calls: [] };
        expect(JSON.stringify(request.context)).toContain("CHILD_RESEARCH_VERIFIED");
        completed = true;
        return step("done");
      },
      execute: async (id, _signal, native) => ({
        result: native ?? result,
        conclude: id.startsWith("done"),
      }),
    }),
  );
  expect(completed).toBe(true);
  expect(turn).toBe(3);
  expect(stopping).toHaveBeenCalledTimes(1);
});

it("does not rediscover every installed skill after ordinary shell commands", async () => {
  let turn = 0;
  const read = vi.fn(async (input: { op: string; path: string }) => ({
    ok: true,
    content: [],
    fileList: { path: input.path, truncated: false, entries: [] },
  }));
  await driveHarness(
    host({
      skills: { read },
      request: async () =>
        turn++ < 20
          ? {
              text: "",
              calls: [{ id: `build-${turn}`, name: "shell", input: { command: "pnpm test" } }],
            }
          : step("done"),
      execute: async (id) => ({ result, conclude: id.startsWith("done") }),
    }),
  );
  expect(read).toHaveBeenCalledTimes(3); // One inventory, not three reads per command.
});

it("refreshes opaque shell changes after the catalog lifetime expires", async () => {
  let time = 1_000;
  let turn = 0;
  const now = vi.spyOn(Date, "now").mockImplementation(() => time);
  const read = vi.fn(async (input: { op: string; path: string }) => ({
    ok: true,
    content: [],
    fileList: { path: input.path, truncated: false, entries: [] },
  }));
  try {
    await driveHarness(
      host({
        skills: { read },
        request: async () => {
          if (turn++ > 1) return step("done");
          if (turn === 2) time += 300_001;
          return {
            text: "",
            calls: [{ id: `script-${turn}`, name: "shell", input: { command: "./setup.sh" } }],
          };
        },
        execute: async (id) => ({ result, conclude: id.startsWith("done") }),
      }),
    );
    expect(read).toHaveBeenCalledTimes(6);
  } finally {
    now.mockRestore();
  }
});
