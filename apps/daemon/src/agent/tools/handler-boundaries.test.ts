import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopdError } from "../../desktopd/client.ts";
import {
  ShellCleanupUncertainError,
  ShellExecutionUncertainError,
} from "../../desktopd/tools-client.ts";
import { actPolicy } from "../policy.ts";
import { redactor } from "../redact.ts";
import { PausedStepError } from "../safety/step-barrier.ts";
import { PROXY_TOKEN, SURROGATE, toolHarness } from "../testing/harness.ts";
import type { ToolDeps } from "./deps.ts";
import { type DispatchDeps, dispatchTool } from "./index.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing value");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of fixtures.splice(0)) h.close();
});
function harness() {
  const h = toolHarness();
  fixtures.push(h);
  const tools = (h as unknown as { tools: ToolDeps }).tools;
  return { ...h, tools };
}
function setup() {
  const h = harness();
  const deps: DispatchDeps = { tools: h.tools, policy: actPolicy };
  const redact = redactor([PROXY_TOKEN]);
  const call = (name: string, input: unknown, g = h.session.generation, signal?: AbortSignal) =>
    dispatchTool(deps, h.session, name, "call", input, redact, g, signal);
  return { ...h, deps, call };
}
const turns = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fixture did not reach its boundary");
};

describe("handler generation and control fences", () => {
  it("drains an ignored policy abort before publishing takeover and never invokes a stale handler", async () => {
    const h = setup();
    const gate = deferred<{ kind: "act" }>();
    h.deps.policy = { decide: () => gate.promise };
    const observe = vi.spyOn(h.tools.gateway, "observe");
    const waiting = h.call("computer", { action: "screenshot" });
    await turns();
    h.deps.policy = actPolicy;
    const takeover = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await turns();
    expect(h.session.controlHeld).toBe(true);
    expect(h.events().filter((e) => e.type === "takeover.request")).toHaveLength(0);
    gate.resolve({ kind: "act" });
    expect((await waiting).result.ok).toBe(false);
    await turns();
    expect(h.events().filter((e) => e.type === "takeover.request")).toHaveLength(1);
    expect(observe).not.toHaveBeenCalled();
    h.session.retireBrain(required(h.session.generation));
    expect((await takeover).result.ok).toBe(false);
    expect(h.session.controlHeld).toBe(true);
    expect(h.events().filter((e) => e.type === "takeover.end")).toHaveLength(0);
    h.session.endTakeover(required(h.session.pendingTakeover), "Ready");
    expect(h.events().filter((e) => e.type === "takeover.end")).toHaveLength(1);
    expect(observe).not.toHaveBeenCalled();
  });
  it("refuses every tool behind takeover without desktop, memory, policy, or PNG calls", async () => {
    const h = setup();
    const held = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await turns();
    const recall = vi.fn(() => []);
    h.tools.recall = recall;
    const desktop = vi.spyOn(h.tools, "desktop"),
      memory = vi.spyOn(h.tools.memory, "apply"),
      people = vi.spyOn(required(h.tools.people), "find"),
      png = vi.spyOn(h.tools.png, "png"),
      policy = vi.spyOn(required(h.deps.policy), "decide");
    const before = policy.mock.calls.length;
    for (const [name, input] of Object.entries({
      computer: { action: "screenshot" },
      browser_read: {},
      browser_navigate: { url: "https://example.com" },
      browser_upload: { files: ["~/report.txt"] },
      switch_screen: { screen: "browser" },
      shell: { command: "pwd" },
      files: { op: "read", path: "a" },
      remember: { file: "USER.md", op: "append", text: "x" },
      recall: { query: "x" },
      people: { op: "find", query: "x" },
      done: { summary: "Done" },
      update_plan: { items: [] },
      ask_user: { question: "x" },
    })) {
      const result = await h.call(name, input);
      expect(result.result.ok).toBe(false);
      expect(result.result.content.every((c) => c.type === "text")).toBe(true);
    }
    expect(desktop).not.toHaveBeenCalled();
    expect(memory).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(people).not.toHaveBeenCalled();
    expect(png).not.toHaveBeenCalled();
    expect(policy.mock.calls.length).toBe(before);
    h.session.stop();
    await held;
  });
  it("does not encode or emit success after an old gateway result returns", async () => {
    const h = setup();
    const gate = deferred<{ frameId: string; pointer: { x: number; y: number } }>();
    vi.spyOn(h.tools.gateway, "observe").mockReturnValue(gate.promise);
    const png = vi.spyOn(h.tools.png, "png");
    const call = h.call("computer", { action: "screenshot" });
    await turns();
    const old = required(h.session.generation);
    h.session.retireBrain(old);
    h.session.beginBrain();
    const n = h.events().length;
    gate.resolve({ frameId: ulid(), pointer: { x: 0, y: 0 } });
    const result = await call;
    expect(result.result.ok).toBe(false);
    expect(png).not.toHaveBeenCalled();
    expect(h.events()).toHaveLength(n);
    expect(h.session.lastFrameId).toBeUndefined();
  });
  it("fences after delayed PNG encoding and preserves taint", async () => {
    const h = setup();
    h.session.tainted = true;
    const gate = deferred<Buffer>();
    vi.spyOn(h.tools.png, "png").mockReturnValue(gate.promise);
    const call = h.call("computer", { action: "screenshot" });
    await turns();
    h.session.retireBrain(required(h.session.generation));
    const n = h.events().length;
    gate.resolve(Buffer.from("private"));
    const result = await call;
    expect(result.result.content.every((c) => c.type === "text")).toBe(true);
    expect(h.events()).toHaveLength(n);
    expect(h.session.tainted).toBe(true);
  });
  it("passes request cancellation to files and ignores a late write result", async () => {
    const h = setup();
    const desktop = required(h.tools.desktop(h.session.cellId));
    h.tools.desktop = () => desktop;
    const gate = deferred<Awaited<ReturnType<typeof desktop.writeFile>>>();
    const write = vi.spyOn(desktop, "writeFile").mockReturnValue(gate.promise);
    const abort = new AbortController();
    const call = h.call(
      "files",
      { op: "write", path: "x", content: "y" },
      h.session.generation,
      abort.signal,
    );
    await until(() => write.mock.calls.length > 0);
    expect(write.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    abort.abort();
    const n = h.events().length;
    gate.resolve({ path: "x", bytes: 1, op: "create", patch: "+y" });
    expect((await call).result.ok).toBe(false);
    expect(h.events()).toHaveLength(n);
  });
  it("does not launch or observe when navigation refusal arrives after retirement", async () => {
    const h = setup();
    const desktop = required(h.tools.desktop(h.session.cellId));
    h.tools.desktop = () => desktop;
    let reject!: (e: unknown) => void;
    vi.spyOn(desktop, "browserNavigate").mockReturnValue(
      new Promise((_r, j) => {
        reject = j;
      }),
    );
    const launcher = vi.spyOn(h.tools, "launcher"),
      observe = vi.spyOn(h.tools.gateway, "observe");
    const call = h.call("browser_navigate", { url: "https://example.com" });
    await turns();
    h.session.retireBrain(required(h.session.generation));
    reject(new DesktopdError(409, "no page", "/browser/navigate"));
    expect((await call).result.ok).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("a held Pause and hand-offs", () => {
  const handedOff = (h: ReturnType<typeof setup>) => ({
    control: h.session.controlHeld,
    signedIn: h.session.taskAutonomy.signedIn("desktop"),
    recorded: h
      .events()
      .filter(
        (e) =>
          ["takeover.request", "tool.end", "step.end"].includes(e.type) ||
          (e.type === "agent.state" && e.data.state === "waiting_user"),
      ).length,
  });
  const nothing = { control: false, signedIn: false, recorded: 0 };

  it("refuses a takeover request: nothing is handed over, signed in or recorded", async () => {
    const h = setup();
    h.session.requestSafetyPause(ulid());
    const { result } = await h.call("request_takeover", { reason: "login", note: "Sign in" });
    expect(result).toMatchObject({ ok: false, pause: true });
    expect(handedOff(h)).toEqual(nothing);
  });
  it("refuses a takeover request when the Pause lands while its policy is deciding", async () => {
    const h = setup();
    const gate = deferred<{ kind: "act" }>();
    h.deps.policy = { decide: () => gate.promise };
    const pending = h.call("request_takeover", { reason: "login", note: "Sign in" });
    await turns();
    h.session.requestSafetyPause(ulid());
    gate.resolve({ kind: "act" });
    expect((await pending).result).toMatchObject({ ok: false, pause: true });
    expect(handedOff(h)).toEqual(nothing);
  });
  it("refuses a step's own hand-off while the Pause waits for that step to finish", async () => {
    const h = setup();
    const gate = deferred<{ kind: "act" }>();
    h.deps.policy = { decide: () => gate.promise };
    // A known credential in a command is the user's to type, so the step hands off.
    const pending = h.call("shell", { command: `printf %s ${PROXY_TOKEN}` });
    await turns();
    const pause = h.session.requestSafetyPause(ulid());
    expect(pause.phase).toBe("pausing");
    gate.resolve({ kind: "act" });
    expect((await pending).result).toMatchObject({ ok: false, pause: true });
    expect(handedOff(h)).toEqual(nothing);
    await h.session.safetyBoundary();
    h.session.confirmSafetyPause(pause.requestId, pause.revision);
    expect(h.session.safetyPause?.resumeAvailable).toBe(true);
  });
  it("the session itself refuses a hand-off while a Pause is held", async () => {
    const h = setup();
    h.session.requestSafetyPause(ulid());
    await expect(h.session.takeover("login", "Sign in")).rejects.toBeInstanceOf(PausedStepError);
    expect(handedOff(h)).toEqual(nothing);
  });
});

describe("taint and containment", () => {
  it("taints every screenshot return path, including stale, zoom, navigation and hand-back", async () => {
    for (const mode of ["screenshot", "click", "stale", "zoom", "browser", "handback"]) {
      const h = setup();
      h.session.lastFrameId = ulid();
      if (mode === "stale")
        h.setOutcome(() => ({ ok: false, cancelled: "stale", frameId: ulid() }));
      let call: ReturnType<typeof h.call>;
      if (mode === "browser") call = h.call("browser_navigate", { url: "https://example.com" });
      else if (mode === "handback") {
        call = h.call("request_takeover", { reason: "login", note: "Sign in" });
        await turns();
        h.session.endTakeover(required(h.session.pendingTakeover), "Ready");
      } else
        call = h.call(
          "computer",
          mode === "zoom"
            ? { action: "zoom", region: { x: 0, y: 0, w: 20, h: 20 } }
            : mode === "screenshot"
              ? { action: mode }
              : { action: "click", point: { x: 10, y: 20 }, basedOn: h.session.lastFrameId },
        );
      expect((await call).result.content.some((c) => c.type === "image")).toBe(true);
      expect(h.session.tainted).toBe(true);
      const memory = vi.spyOn(h.tools.memory, "apply");
      expect(
        (await h.call("remember", { file: "USER.md", op: "append", text: "Injected" })).result.ok,
      ).toBe(false);
      expect(memory).not.toHaveBeenCalled();
    }
  });
  it("only a user answer clears taint; timeout and retirement do not", async () => {
    const h = setup();
    h.session.tainted = true;
    h.tools.askTimeoutMs = 1;
    expect((await h.call("ask_user", { question: "Confirm?" })).result.ok).toBe(false);
    expect(h.session.tainted).toBe(true);
    h.tools.askTimeoutMs = 10000;
    const call = h.call("ask_user", { question: "Confirm?" });
    await turns();
    h.session.answer(required(h.session.pendingAsk), undefined, "Yes");
    expect((await call).result.ok).toBe(true);
    expect(h.session.tainted).toBe(false);
    expect(
      (await h.call("remember", { file: "USER.md", op: "append", text: "Confirmed" })).result.ok,
    ).toBe(true);
    h.session.tainted = true;
    const cancelled = h.call("ask_user", { question: "Confirm?" });
    await turns();
    h.session.retireBrain(required(h.session.generation));
    expect((await cancelled).result.ok).toBe(false);
    expect(h.session.tainted).toBe(true);
    expect(
      h
        .events()
        .filter((e) => e.type === "ask.answer" && (e.data as { by?: string }).by === "stop"),
    ).toHaveLength(1);
  });
  it.each([ShellCleanupUncertainError, ShellExecutionUncertainError])(
    "fences then awaits real containment for %s",
    async (ErrorClass) => {
      const h = setup();
      const desktop = required(h.tools.desktop(h.session.cellId));
      h.tools.desktop = () => desktop;
      vi.spyOn(desktop, "shell").mockRejectedValue(new ErrorClass());
      const gate = deferred<void>();
      const containment = vi
        .spyOn(h.tools, "stopForUncertainty")
        .mockImplementation(async (session) => {
          expect(session.stopped).toBe(true);
          expect(session.generation).toBeUndefined();
          await gate.promise;
        });
      const call = h.call("shell", { command: "echo x" });
      await until(() => containment.mock.calls.length === 1);
      expect(containment).toHaveBeenCalledTimes(1);
      const observe = vi.spyOn(h.tools.gateway, "observe");
      expect((await h.call("computer", { action: "screenshot" })).result.ok).toBe(false);
      expect(observe).not.toHaveBeenCalled();
      gate.resolve();
      const result = await call;
      expect(result.result).toMatchObject({ ok: false, final: true });
      expect(
        h.events().filter((e) => e.type === "tool.end" && (e.data as { ok?: boolean }).ok),
      ).toHaveLength(0);
    },
  );
  it.each([
    [ShellCleanupUncertainError, "generation"],
    [ShellExecutionUncertainError, "generation"],
    [ShellCleanupUncertainError, "request"],
    [ShellExecutionUncertainError, "request"],
  ] as const)("contains late %s after %s cancellation", async (ErrorClass, cancellation) => {
    const h = setup();
    const desktop = required(h.tools.desktop(h.session.cellId));
    h.tools.desktop = () => desktop;
    let reject!: (error: unknown) => void;
    const running = vi.spyOn(desktop, "shell").mockReturnValue(
      new Promise((_r, j) => {
        reject = j;
      }),
    );
    const abort = new AbortController();
    const stop = vi.spyOn(h.tools, "stopForUncertainty").mockImplementation(async (session) => {
      expect(session.stopped).toBe(true);
    });
    const call = h.call("shell", { command: "echo x" }, h.session.generation, abort.signal);
    await until(() => running.mock.calls.length > 0);
    if (cancellation === "generation") h.session.retireBrain(required(h.session.generation));
    else abort.abort();
    expect(h.session.stopped).toBe(false);
    reject(new ErrorClass());
    const result = await call;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ ok: false, final: true });
    expect(h.session.stopped).toBe(true);
  });
  it("stays fenced when containment rejects", async () => {
    const h = setup();
    const desktop = required(h.tools.desktop(h.session.cellId));
    h.tools.desktop = () => desktop;
    vi.spyOn(desktop, "shell").mockRejectedValue(new ShellCleanupUncertainError());
    vi.spyOn(h.tools, "stopForUncertainty").mockRejectedValue(new Error("containment failed"));
    expect((await h.call("shell", { command: "x" })).result).toMatchObject({
      ok: false,
      final: true,
    });
    expect(h.session.stopped).toBe(true);
  });
  it("taints shell and folder/file/page reads", async () => {
    for (const [tool, input] of [
      ["shell", { command: "x" }],
      ["files", { op: "list", path: "." }],
      ["files", { op: "read", path: "x" }],
      ["browser_read", {}],
    ] as const) {
      const h = setup();
      h.desktop.files.set("x", "data");
      expect((await h.call(tool, input)).result.ok).toBe(true);
      expect(h.session.tainted).toBe(true);
    }
  });
});

describe("bounded redaction and final publication", () => {
  it("redacts secrets across every streamed shell split in both model results and log", async () => {
    for (const secret of [PROXY_TOKEN, SURROGATE])
      for (let split = 1; split < secret.length; split++) {
        const h = setup();
        h.desktop.shellOutput = [
          { stream: "stdout", chunk: `prefix ${secret.slice(0, split)}` },
          { stream: "stderr", chunk: `${secret.slice(split)} suffix` },
        ];
        const result = await h.call("shell", { command: "echo" });
        expect(result.result.ok).toBe(true);
        const output = h
          .events()
          .filter((e) => e.type === "tool.output")
          .map((e) => (e.data as { chunk: string }).chunk)
          .join("");
        expect(output).toBe("prefix [redacted] suffix");
        expect(JSON.stringify(result)).not.toContain(secret);
      }
  });
  it("bounds UTF-8 shell output bytes in the terminal log and model tail", async () => {
    const h = setup();
    h.desktop.shellOutput = [{ stream: "stdout", chunk: "中".repeat(300000) }];
    const result = await h.call("shell", { command: "echo" });
    expect(result.result.ok).toBe(true);
    const output = h
      .events()
      .filter((e) => e.type === "tool.output")
      .map((e) => (e.data as { chunk: string }).chunk)
      .join("");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(256 * 1024);
    const content = result.result.content[0];
    if (content?.type !== "text") throw new Error("expected text");
    expect(Buffer.byteLength(content.text)).toBeLessThan(16 * 1024 + 200);
    expect(content.text).not.toContain("�");
  });
  it("contains an uncertain host memory commit instead of inviting a blind retry", async () => {
    const h = setup();
    vi.spyOn(h.tools.memory, "apply").mockImplementation(() => {
      throw new Error("I/O after journal write");
    });
    const stop = vi.spyOn(h.tools, "stopForUncertainty");
    expect(
      (await h.call("remember", { file: "USER.md", op: "append", text: "Confirmed" })).result,
    ).toMatchObject({ ok: false, final: true });
    expect(stop).toHaveBeenCalledWith(h.session, "memory_write_uncertain");
    expect(h.session.stopped).toBe(true);
  });
  it("redacts plan, file metadata, error and final-summary events", async () => {
    const h = setup();
    await h.call("update_plan", { items: [{ text: PROXY_TOKEN, status: "todo" }] });
    const protectedWrite = h.call("files", {
      op: "write",
      path: PROXY_TOKEN,
      content: PROXY_TOKEN,
    });
    await until(() => h.events().some((event) => event.type === "takeover.request"));
    expect(h.session.controlHeld).toBe(true);
    expect(h.session.endTakeover(required(h.session.pendingTakeover), "Ready")).toBe(true);
    expect((await protectedWrite).result.ok).toBe(false);
    expect(h.desktop.files.has(PROXY_TOKEN)).toBe(false);
    await h.call("done", { summary: PROXY_TOKEN });
    expect(JSON.stringify(h.events())).not.toContain(PROXY_TOKEN);
  });
  it("awaits streaming output persistence and refuses late final success after retirement", async () => {
    const h = setup();
    h.desktop.files.set("out.txt", "content");
    const gate = deferred<{ path: string; bytes: number }>();
    const save = vi.spyOn(h.tools, "saveOutput").mockReturnValue(gate.promise);
    const call = h.call("done", { summary: "done", files: ["out.txt"] });
    await until(() => save.mock.calls.length === 1);
    expect(save.mock.calls[0]?.[2]).toBeInstanceOf(ReadableStream);
    h.session.retireBrain(required(h.session.generation));
    gate.resolve({ path: "host", bytes: 7 });
    expect((await call).result.ok).toBe(false);
    expect(h.events().filter((e) => e.type === "task.result")).toHaveLength(0);
  });
});
