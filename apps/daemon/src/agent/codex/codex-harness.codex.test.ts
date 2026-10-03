import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccountRead,
  AppServerRpc,
  CODEX_VERSION,
  RpcError,
  schemaContract,
  ThreadStartResult,
  Turn,
  TurnCompleted,
  threadStartParams,
} from "@localdot/codex-harness";
import { afterEach, describe, expect, it } from "vitest";
import { preparePinnedFixture } from "../../../../../harness/codex/src/testing/pinned-fixture.ts";
import { SessionStoppedError } from "../session.ts";
import { CODEX_CRASHED, CODEX_DONE } from "./driver.ts";
import { type Answer, fakeAuthJson, startOpenAiMock } from "./testing/openai-mock.ts";
import { PINNED_PNG, pinnedDriver } from "./testing/pinned-driver.ts";

// Separate explicit suite: missing opt-in/archive/platform is a failure, never a passing skip.
if (process.env.LOCALDOT_CODEX_TESTS !== "1")
  throw new Error("Pinned offline probes require LOCALDOT_CODEX_TESTS=1.");
const archive = process.env.LOCALDOT_CODEX_ARCHIVE;
if (!archive) throw new Error("Pinned offline probes require the exact local archive.");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Owned offline fixture cleanup failed.");
});
const opaque = (value: unknown) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
};
async function prepare() {
  const fixture = await preparePinnedFixture(archive as string);
  cleanup.push(() => fixture.close());
  return fixture;
}
const exec = (input: string, n = 1) => ({
  type: "custom_tool_call",
  id: `ctc_fixture_${n}`,
  call_id: `call_fixture_${n}`,
  namespace: "functions",
  name: "exec",
  input,
  status: "completed",
});
function execResult(bodies: Record<string, unknown>[], callId: string): unknown {
  for (const body of bodies) {
    for (const item of (body.input as { type: string; call_id?: string; output?: unknown }[]) ??
      []) {
      if (item.call_id !== callId || !/_output$/.test(item.type) || !Array.isArray(item.output))
        continue;
      for (const part of item.output as { text?: string }[]) {
        if (part.text?.startsWith("{")) return JSON.parse(part.text);
      }
    }
  }
  return undefined;
}
const done = (n: number) =>
  exec(
    'await tools.mcp__localdot__done({ summary: "Inert offline fixture finished", artifacts: [] });',
    n,
  );
async function until(signal: AbortSignal, predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    signal.throwIfAborted();
    assert.ok(Date.now() < deadline, "Owned pinned probe did not reach its asserted boundary.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function groupGone(pid: number | undefined) {
  assert.ok(pid);
  assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
}
async function start(answer?: Answer) {
  const fixture = await prepare();
  const mock = await startOpenAiMock(answer);
  cleanup.push(async () => {
    await mock.close();
    expect(mock.errors).toEqual([]);
  });
  writeFileSync(join(fixture.roots.home, "auth.json"), fakeAuthJson(), { mode: 0o600 });
  const process = fixture.appServer({ purpose: "account", base: mock.base });
  const notes: { method: string; params: unknown }[] = [],
    failures: unknown[] = [];
  const rpc = new AppServerRpc({
    input: process.stdout as NonNullable<typeof process.stdout>,
    output: process.stdin as NonNullable<typeof process.stdin>,
    signal: fixture.signal,
    onServerRequest: () => ({
      error: { code: -32001, message: "Offline probe refuses tools." },
      current: () => false,
    }),
    onNotification: (method, params) => {
      assert.ok(notes.length < 1024);
      notes.push({ method, params });
    },
    onFailure: (error) => {
      failures.push(error);
    },
  });
  cleanup.push(async () => {
    rpc.close();
    await process.stop();
    await process.closed;
    expect(failures).toEqual([]);
  });
  await process.started;
  await rpc.request(
    "initialize",
    { clientInfo: { name: "localdot", title: "localDot", version: "0.0.0" } },
    { signal: fixture.signal, validateResult: opaque },
  );
  rpc.notify("initialized", {});
  const read = (refreshToken = false) =>
    rpc.request(
      "account/read",
      { refreshToken },
      { signal: fixture.signal, validateResult: AccountRead.parse },
    );
  const newThread = async () => {
    const result = await rpc.request(
      "thread/start",
      threadStartParams({
        cwd: fixture.work.path,
        model: "gpt-6-astra",
        developerInstructions: "Inert offline probe. Use only localdot tools.",
      }),
      { signal: fixture.signal, validateResult: ThreadStartResult.parse },
    );
    expect(result.model).toBe("gpt-6-astra");
    expect(result.approvalsReviewer).toBe("user");
    return result.thread.id;
  };
  const turn = async (threadId: string, text: string, image?: string) => {
    const before = notes.length;
    await rpc.request(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text }, ...(image ? [{ type: "image", url: image }] : [])],
      },
      {
        signal: fixture.signal,
        validateResult: (value) => {
          opaque(value);
          return Turn.parse((value as { turn?: unknown }).turn);
        },
      },
    );
    while (!notes.slice(before).some((note) => note.method === "turn/completed")) {
      fixture.signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return TurnCompleted.parse(
      notes.slice(before).find((note) => note.method === "turn/completed")?.params,
    ).turn;
  };
  return { fixture, mock, process, rpc, notes, read, newThread, turn };
}

describe(`actual pinned Codex ${CODEX_VERSION} offline acceptance`, { timeout: 65_000 }, () => {
  it("regenerates all35 committed schema files from the independently verified pin", async () => {
    const fixture = await prepare(),
      { process, directory } = fixture.schema();
    process.stdout?.resume();
    process.stderr?.resume();
    await process.started;
    expect(await process.exited).toEqual({ code: 0, signal: null });
    await process.closed;
    const expected = JSON.parse(
      readFileSync(
        new URL("../../../../../harness/codex/schema/contract-0.154.0.json", import.meta.url),
        "utf8",
      ),
    );
    const actual = { codexVersion: CODEX_VERSION, ...schemaContract(directory) };
    expect(actual).toEqual(expected);
    const output = globalThis.process.env.LOCALDOT_CODEX_PROBE_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true, mode: 0o700 });
      writeFileSync(join(output, "schema-contract.json"), `${JSON.stringify(actual, null, 2)}\n`, {
        mode: 0o600,
      });
    }
  });
  it("sends store:false on both actual requests and carries encrypted reasoning into continuation", async () => {
    const h = await start((_body, index) =>
      index === 0
        ? [
            {
              type: "reasoning",
              id: "reasoning_fixture_1",
              summary: [],
              encrypted_content: "inert_encrypted_fixture_1",
            },
            {
              type: "message",
              role: "assistant",
              id: "msg_fixture_1",
              content: [{ type: "output_text", text: "ok" }],
            },
          ]
        : undefined,
    );
    const thread = await h.newThread();
    expect((await h.turn(thread, "First inert request")).status).toBe("completed");
    expect((await h.turn(thread, "Second inert continuation")).status).toBe("completed");
    expect(h.mock.responses).toHaveLength(2);
    for (const body of h.mock.responses) expect(body.store).toBe(false);
    expect(JSON.stringify(h.mock.responses[1]?.input)).toContain(
      '"encrypted_content":"inert_encrypted_fixture_1"',
    );
    expect(readFileSync(join(h.fixture.fakeHome, ".codex", "auth.json"), "utf8")).toBe(
      "Inert user-home sentinel",
    );
  });
  it("refreshes only the owned fake credentials while preserving the protected home sentinel", async () => {
    const h = await start();
    const path = join(h.fixture.roots.home, "auth.json"),
      before = readFileSync(path, "utf8");
    expect((await h.read(true)).account).toMatchObject({ type: "chatgpt", planType: "plus" });
    expect(JSON.parse(readFileSync(path, "utf8")).tokens.refresh_token).toBe("rt-2");
    expect(readFileSync(path, "utf8")).not.toBe(before);
    expect(h.mock.requests.filter((r) => r.path.startsWith("/oauth/token"))).toHaveLength(1);
    expect(readFileSync(join(h.fixture.fakeHome, ".codex", "auth.json"), "utf8")).toBe(
      "Inert user-home sentinel",
    );
    expect(existsSync(join(h.fixture.roots.home, "skills"))).toBe(false);
  });
  it("does not reuse a reader after the fake credential file changes", async () => {
    const h = await start();
    expect((await h.read()).account?.email).toBe("user@example.invalid");
    const other = JSON.parse(fakeAuthJson(2));
    for (const key of ["id_token", "access_token"] as const) {
      const parts = other.tokens[key].split(".");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      claims.email = "second@example.invalid";
      claims["https://api.openai.com/auth"].chatgpt_account_id = "acct-second-fixture";
      parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
      other.tokens[key] = parts.join(".");
    }
    other.tokens.account_id = "acct-second-fixture";
    writeFileSync(join(h.fixture.roots.home, "auth.json"), JSON.stringify(other), { mode: 0o600 });
    // This pin caches account state in a live process; replacement must read the changed file.
    expect((await h.read()).account?.email).toBe("user@example.invalid");
    h.rpc.close();
    await h.process.stop();
    await h.process.closed;
    const second = h.fixture.appServer({ purpose: "account", base: h.mock.base });
    const failures: unknown[] = [];
    const rpc = new AppServerRpc({
      input: second.stdout as NonNullable<typeof second.stdout>,
      output: second.stdin as NonNullable<typeof second.stdin>,
      signal: h.fixture.signal,
      onServerRequest: () => ({ error: { code: -32001 }, current: () => false }),
      onNotification: () => {},
      onFailure: (error) => {
        failures.push(error);
      },
    });
    cleanup.push(async () => {
      rpc.close();
      await second.stop();
      await second.closed;
      expect(failures).toEqual([]);
    });
    await second.started;
    await rpc.request(
      "initialize",
      { clientInfo: { name: "localdot", version: "0.0.0" } },
      { signal: h.fixture.signal, validateResult: opaque },
    );
    rpc.notify("initialized", {});
    expect(
      (
        await rpc.request(
          "account/read",
          { refreshToken: false },
          { signal: h.fixture.signal, validateResult: AccountRead.parse },
        )
      ).account,
    ).toMatchObject({ type: "chatgpt", email: "second@example.invalid" });
  });
  it("runs the actual tool bridge with no command tool, declines file edits, and submits the full PNG", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec(
            "const out = { names: ALL_TOOLS.map((tool) => tool.name) };" +
              'try { await tools.exec_command({ cmd: "id" }); out.command = "ran"; } catch (error) { out.command = "refused"; }' +
              'try { await tools.apply_patch("*** Begin Patch\\n*** Add File: pinned-forbidden.txt\\n+fixture\\n*** End Patch\\n"); out.patch = "ran"; } catch (error) { out.patch = "refused"; }' +
              'const shot = await tools.mcp__localdot__computer({ action: "screenshot" }); out.image = shot.content.map((part) => part.type); text(JSON.stringify(out));',
          )
        : exec(
            'await tools.mcp__localdot__done({ summary: "Inert offline probe finished", artifacts: [] });',
            index + 1,
          ),
    );
    cleanup.push(() => h.close());
    expect(await h.run()).toBe(CODEX_DONE);
    const out = execResult(h.mock.responses, "call_fixture_1") as {
      names: string[];
      command: string;
      patch: string;
      image: string[];
    };
    expect(out).toBeDefined();
    for (const tool of ["exec_command", "write_stdin", "view_image", "spawn_agent"])
      expect(out.names.some((name) => name === tool || name.endsWith(`__${tool}`))).toBe(false);
    expect(out.command).toBe("refused");
    expect(out.image).toContain("image");
    expect(
      h.decisions.filter((decision) => decision.method === "item/fileChange/requestApproval"),
    ).toEqual([expect.objectContaining({ verdict: "declined" })]);
    expect(existsSync(join(fixture.work.path, "pinned-forbidden.txt"))).toBe(false);
    expect(h.calls.map((call) => call.tool)).toEqual(["computer", "done"]);
    expect(h.calls[0]?.context.basisFrameId).toBe(h.frame);
    expect(JSON.stringify(h.mock.responses[0]?.input)).toContain(PINNED_PNG.toString("base64"));
    expect(JSON.stringify(h.mock.responses[0]?.input)).not.toContain(h.frame);
    expect(h.failures).toEqual([]);
    for (const body of h.mock.responses) expect(body.store).toBe(false);
  });
  it("keeps frame A for two same-turn clicks even when the first returns a newer image", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec(
            'const first = await tools.mcp__localdot__computer({ action: "click", point: { x: 10, y: 20 } });' +
              'const second = await tools.mcp__localdot__computer({ action: "click", point: { x: 30, y: 40 } });' +
              "text(JSON.stringify({ first: first.content.map((part) => part.type), second: second.content.map((part) => part.type) }));",
          )
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    expect(await h.run()).toBe(CODEX_DONE);
    expect(h.calls.map((call) => call.tool)).toEqual(["computer", "computer", "done"]);
    expect(h.calls[0]?.input).toMatchObject({
      action: "click",
      basedOn: h.frame,
      point: { x: 10, y: 20 },
    });
    expect(h.calls[1]?.input).toMatchObject({
      action: "click",
      basedOn: h.frame,
      point: { x: 30, y: 40 },
    });
    expect(h.calls[0]?.resultFrameId).not.toBe(h.frame);
    expect(h.calls[1]?.context.turnEpoch).toBe(h.calls[0]?.context.turnEpoch);
    expect(execResult(h.mock.responses, "call_fixture_1")).toEqual({
      first: ["image"],
      second: ["image"],
    });
    expect(h.observedFrames).toEqual([h.frame]);
    const wire = JSON.stringify(h.mock.responses);
    for (const call of h.calls) expect(wire).not.toContain(call.resultFrameId);
    expect(h.failures).toEqual([]);
  });
  it("cancels the remaining click and its image after a stale batch action, then submits a fresh full-frame turn", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec(
            'await Promise.all([tools.mcp__localdot__computer({ action: "click", point: { x: 10, y: 20 } }), tools.mcp__localdot__computer({ action: "click", point: { x: 30, y: 40 } })]);',
          )
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    // Valid, distinct pixels: an invalid PNG would let decoder omission conceal a leaked result.
    const rejectedImage =
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARElEQVRo3u3PQQkAAAgEsKtgNPsHsIYV/AqDFVhq+rUICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwtnols4l24gqkAAAAASUVORK5CYII=";
    h.reply((tool) =>
      tool === "computer"
        ? {
            ok: false,
            cancelled: "stale",
            content: [
              {
                type: "image",
                frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
                mediaType: "image/png",
                data: rejectedImage,
              },
            ],
          }
        : {
            ok: true,
            final: true,
            content: [{ type: "text", text: "Finished after fresh observation." }],
          },
    );
    let release!: () => void,
      replies = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.beforeReply(() => (++replies === 1 ? held : undefined));
    const run = h.run();
    // The pin can serialize Promise.all tool calls and can choose either call first. Hold the
    // first arriving action; retirement must prevent the other action regardless of queue order.
    await until(fixture.signal, () => h.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.calls).toHaveLength(1);
    const first = h.calls[0];
    assert.ok(first);
    expect(first.completed).toBe(false);
    release();
    expect(await run).toBe(CODEX_DONE);
    expect(h.calls.map((call) => call.tool)).toEqual(["computer", "done"]);
    expect(h.calls[0]?.input).toMatchObject({
      action: "click",
      basedOn: h.frame,
    });
    expect([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]).toContainEqual((first.input as { point: unknown }).point);
    expect(h.connections).toHaveLength(2);
    expect(h.observedFrames).toHaveLength(2);
    expect(h.observedFrames[1]).not.toBe(h.frame);
    expect(h.calls[1]?.context.basisFrameId).toBe(h.observedFrames[1]);
    expect(h.mock.responses).toHaveLength(2);
    expect(JSON.stringify(h.mock.responses[1]?.input)).toContain(PINNED_PNG.toString("base64"));
    expect(JSON.stringify(h.mock.responses[1]?.input)).toContain(
      "do not apply the canceled action automatically",
    );
    expect(JSON.stringify(h.mock.responses)).not.toContain(rejectedImage);
    expect(h.failures).toEqual([]);
  });
  it("Stop fences a pending real MCP call and closes Codex, nc and all pipes without a late image", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec(
            'const shot = await tools.mcp__localdot__computer({ action: "screenshot" }); text(JSON.stringify(shot));',
          )
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.beforeReply(() => held);
    const run = h.run();
    await until(fixture.signal, () => h.calls.length === 1);
    expect(h.endpoints[0]?.connections()).toBeGreaterThan(0);
    h.session.stop();
    expect(await run).toBe(CODEX_DONE);
    release();
    await h.connections[0]?.closed;
    expect(h.calls[0]?.completed).toBe(false);
    expect(h.mock.responses).toHaveLength(1);
    expect(h.observedFrames).toHaveLength(1);
    expect(h.endpoints[0]?.connections()).toBe(0);
    expect(existsSync(h.endpoints[0]?.socket as string)).toBe(false);
    for (const process of fixture.processes) groupGone(process.pid);
    expect(h.failures).toEqual([]);
  });
  it("preserves held takeover after a pending MCP call is canceled and only resumes after matching hand-back", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec('await tools.mcp__localdot__computer({ action: "screenshot" });')
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    let release!: () => void,
      replies = 0,
      settled = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.beforeReply(() => (++replies === 1 ? held : undefined));
    const run = h.run().finally(() => {
      settled = true;
    });
    await until(fixture.signal, () => h.calls.length === 1);
    const waiter = h.session.takeover("login", "Inert fixture hand-back");
    void waiter.catch(() => {});
    expect(h.session.generation).toBeUndefined();
    expect(h.calls[0]?.context.signal.aborted).toBe(true);
    expect(fixture.processes[0]?.stdin?.writableEnded).toBe(true);
    await until(fixture.signal, () => h.session.status === "waiting_user");
    await h.connections[0]?.closed;
    await expect(waiter).rejects.toBeInstanceOf(SessionStoppedError);
    const request = h.session.pendingTakeover;
    expect(request).toBeDefined();
    expect(h.session.generation).toBeUndefined();
    expect(h.calls[0]?.completed).toBe(false);
    expect(h.session.endTakeover("wrong-request", "ignored")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.connections).toHaveLength(1);
    expect(h.mock.responses).toHaveLength(1);
    expect(h.observedFrames).toHaveLength(1);
    expect(h.session.status).toBe("waiting_user");
    expect(settled).toBe(false);
    groupGone(fixture.processes[0]?.pid);
    release();
    expect(h.session.endTakeover(request as string, "Owned hand-back note")).toBe(true);
    expect(await run).toBe(CODEX_DONE);
    expect(h.connections).toHaveLength(2);
    expect(h.observedFrames).toHaveLength(2);
    expect(h.calls.map((call) => call.tool)).toEqual(["computer", "done"]);
    expect(h.calls[1]?.context.basisFrameId).toBe(h.observedFrames[1]);
    expect(h.calls[1]?.context.generation.id).not.toBe(h.calls[0]?.context.generation.id);
    expect(JSON.stringify(h.mock.responses[1]?.input)).toContain("Owned hand-back note");
    expect(
      h.transcripts
        .read(h.session.id)
        .filter((row) => row.sourceInbox && row.content === "Owned hand-back note"),
    ).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });
  it("pauses a failed fake refresh without daemon retry, replacement, fallback or new frames until Stop", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec('await tools.mcp__localdot__computer({ action: "screenshot" }); text("seen");')
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    h.mock.refreshFails = true;
    h.beforeReply(() => h.mock.expireAccess());
    const run = h.run();
    await until(fixture.signal, () => h.session.status === "paused");
    expect(h.signedOut).toEqual([1]);
    expect(h.calls.map((call) => call.tool)).toEqual(["computer"]);
    expect(h.mock.requests.filter((request) => request.path === "/oauth/token")).toHaveLength(1);
    expect(
      h.mock.requests.filter(
        (request) => request.method === "POST" && request.path === "/backend-api/codex/responses",
      ),
    ).toHaveLength(3); // One successful request plus this pin's two bounded unauthorized attempts.
    expect(h.mock.responses).toHaveLength(1);
    expect(h.connections).toHaveLength(1);
    expect(h.observedFrames).toHaveLength(1);
    expect(h.session.generation).toBeUndefined();
    await h.connections[0]?.closed;
    h.session.post("followup", "Ordinary text cannot resume expired sign-in");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.connections).toHaveLength(1);
    expect(h.mock.responses).toHaveLength(1);
    expect(h.session.status).toBe("paused");
    h.session.stop();
    expect(await run).toBe(CODEX_DONE);
    expect(h.failures).toEqual([]);
  });
  it("refuses a forced alternate-model sub-agent without creating a child thread or granting tools", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? {
            type: "function_call",
            id: "fc_spawn_fixture",
            call_id: "call_spawn_fixture",
            namespace: "collaboration",
            name: "spawn_agent",
            arguments: JSON.stringify({
              task_name: "inert_child",
              message: "Use computer",
              fork_turns: "none",
              model: "gpt-5.6-sol",
            }),
          }
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    expect(await h.run()).toBe(CODEX_DONE);
    expect(h.calls.map((call) => call.tool)).toEqual(["done"]);
    expect(
      new Set(
        h.mock.responses.map((body) => (body.client_metadata as { thread_id: string }).thread_id),
      ).size,
    ).toBe(1);
    expect(h.mock.responses.map((body) => body.model)).toEqual(["gpt-6-astra", "gpt-6-astra"]);
    expect(h.notes.filter((note) => note.method === "thread/started")).toHaveLength(1);
    expect(
      h.notes.some(
        (note) =>
          (note.params as { item?: { type?: string } }).item?.type === "collabAgentToolCall",
      ),
    ).toBe(false);
    const secondRequest = h.mock.responses[1];
    assert.ok(secondRequest);
    const rejected = (
      secondRequest.input as { type: string; call_id?: string; output?: unknown }[]
    ).find((item) => item.call_id === "call_spawn_fixture" && item.type.endsWith("_output"));
    expect(rejected?.output).toBe("unsupported call: collaborationspawn_agent");
    expect(h.failures).toEqual([]);
  });
  it("exposes no connector, plugin, foreign MCP or web tool and sends only allowed fixture HTTP requests", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec(
            'const out = { names: ALL_TOOLS.map((tool) => tool.name) }; try { await tools.web__run({ search_query: [{ q: "inert" }] }); out.web = "ran"; } catch { out.web = "refused"; } try { await tools.mcp__foreign__computer({ action: "screenshot" }); out.foreign = "ran"; } catch { out.foreign = "refused"; } text(JSON.stringify(out));',
          )
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    expect(await h.run()).toBe(CODEX_DONE);
    const out = execResult(h.mock.responses, "call_fixture_1") as {
      names: string[];
      web: string;
      foreign: string;
    };
    expect(out.web).toBe("refused");
    expect(out.foreign).toBe("refused");
    for (const name of out.names.filter((name) => name.startsWith("mcp__")))
      expect(name).toMatch(/^mcp__localdot__/);
    expect(out.names.some((name) => /plugin|connector|web__|spawn_agent/.test(name))).toBe(false);
    expect(h.calls.map((call) => call.tool)).toEqual(["done"]);
    for (const request of h.mock.requests)
      expect([
        "/backend-api/codex/models",
        "/backend-api/codex/responses",
        "/backend-api/wham/settings/user",
      ]).toContain(request.path.split("?")[0]);
    expect(existsSync(join(fixture.roots.home, "skills"))).toBe(false);
    expect(h.failures).toEqual([]);
  });
  it("closes the real nc bridge and pending call on app-server stdin EOF without delivering a late image", async () => {
    const fixture = await prepare();
    const h = await pinnedDriver(fixture, (_body, index) =>
      index === 0
        ? exec('await tools.mcp__localdot__computer({ action: "screenshot" });')
        : done(index + 1),
    );
    cleanup.push(() => h.close());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.beforeReply(() => held);
    const run = h.run();
    await until(fixture.signal, () => h.calls.length === 1);
    expect(h.endpoints[0]?.connections()).toBeGreaterThan(0);
    assert.ok(fixture.processes[0]?.stdin);
    fixture.processes[0].stdin.end();
    expect(await run).toBe(CODEX_CRASHED);
    release();
    await h.connections[0]?.closed;
    expect(h.calls[0]?.completed).toBe(false);
    expect(h.endpoints[0]?.connections()).toBe(0);
    expect(h.mock.responses).toHaveLength(1);
    expect(h.observedFrames).toHaveLength(1);
    for (const process of fixture.processes) groupGone(process.pid);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toBeInstanceOf(RpcError);
    expect(h.failures[0]).toMatchObject({ method: "rpc", code: -32000 });
  });
});
