import type { ShellChunk, ShellDone } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellExecutionUncertainError } from "../desktopd/tools-client.ts";
import { toolHarness } from "./testing/harness.ts";
import { USER_SPOKE } from "./tools/deps.ts";
import { openingSleepMs } from "./tools/shell.ts";

const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});
function setup() {
  const h = toolHarness();
  fixtures.push(h.close);
  return h;
}
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((part) => part.text ?? "").join("\n");
// A sleep that only the caller's signal ends.
const endless = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>((_resolve, reject) =>
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
const WAITING = {
  summary: "Waiting for the build",
  completion: { status: "waiting", evidence: "The build is still running", wait_seconds: 30 },
  input_request: null,
  experience: null,
};

describe("a wait of dot's and the user's messages", () => {
  it("ends for a message dot hasn't taken in, at once when one is already there", () => {
    const { session } = setup();
    const waiting = session.listenForUser(new AbortController().signal);
    expect(waiting.spoke).toBe(false);
    session.post("steer", "Stop and use the other branch");
    expect(waiting.spoke).toBe(true);
    expect(waiting.signal.aborted).toBe(true);
    // That message has ended a wait; the next wait runs.
    const next = session.listenForUser(new AbortController().signal);
    expect(next.spoke).toBe(false);
    next.end();
    session.post("steer", "And keep the tests");
    expect(session.listenForUser(new AbortController().signal).spoke).toBe(true);
  });

  it("runs on for what dot already heard, localDot's own notes, Resume and queued follow-ups", () => {
    const { session } = setup();
    const heard = session.post("steer", "Use the cheaper airline");
    session.heard(heard.seq);
    session.remind("(A reminder of localDot's.)");
    session.post("resume", "");
    session.enqueue("After that, book the hotel");
    const waiting = session.listenForUser(new AbortController().signal);
    expect(waiting.spoke).toBe(false);
    waiting.end();
    session.post("steer", "Window seat");
    expect(waiting.spoke).toBe(false);
  });

  it("ends a delegated agent's wait for nothing: it doesn't hear the user", async () => {
    const h = setup();
    h.tools.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1)));
    h.session.post("steer", "Check the logs instead");
    const sub = await h.call("done", WAITING, "sub-child-1");
    expect(text(sub.body)).toContain("Waited 30 seconds");
    const own = await h.call("done", WAITING);
    expect(text(own.body)).toContain("A new user instruction arrived");
  });
});

describe("waiting for progress with done", () => {
  it("ends as the user's message comes", async () => {
    const h = setup();
    h.tools.sleep = endless;
    const waiting = h.call("done", WAITING);
    setTimeout(() => h.session.post("steer", "Skip the build, just deploy"), 20);
    const { body } = await waiting;
    expect(body.ok).toBe(true);
    expect(text(body)).toContain("A new user instruction arrived");
  });

  it("runs its course for a message the brain had already put in its history", async () => {
    const h = setup();
    h.tools.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1)));
    const item = h.session.post("steer", "Wait for the build, then deploy");
    const inbox = await h.app.request("/v1/inbox?after=0&waitMs=0", { headers: h.auth });
    expect(((await inbox.json()) as { items: unknown[] }).items).toHaveLength(1);
    const ack = await h.app.request("/v1/transcript", {
      method: "POST",
      headers: h.auth,
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: item.text,
            sourceInbox: { seq: item.seq, messageId: item.messageId },
          },
        ],
        inboxAfter: item.seq,
      }),
    });
    expect(ack.status).toBe(204);
    const { body } = await h.call("done", WAITING);
    expect(text(body)).toContain("Waited 30 seconds");
  });
});

describe("a command's opening sleep", () => {
  // The desktop's shell: a command runs until it is stopped, as `sleep` does.
  function sleepy(h: ReturnType<typeof setup>) {
    const stopped: string[] = [];
    const base = h.tools.desktop("cell");
    if (!base) throw new Error("no desktop");
    h.tools.desktop = () => ({
      ...base,
      shell: async (req, _onChunk: (c: ShellChunk) => void, signal?: AbortSignal) => {
        h.desktop.shellCalls.push(req.command);
        await endless(0, signal).catch(() => stopped.push(req.command));
        return {
          done: true as const,
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
          truncated: false,
          ms: 5,
        };
      },
    });
    return stopped;
  }

  it("is stopped by the user's message, before anything after it runs", async () => {
    const h = setup();
    const stopped = sleepy(h);
    const running = h.call("shell", { command: "sleep 90; echo waited", timeout_sec: 120 });
    setTimeout(() => h.session.post("steer", "Don't wait, check the page now"), 20);
    const { body } = await running;
    expect(stopped).toEqual(["sleep 90; echo waited"]);
    expect(body.ok).toBe(true);
    expect(text(body)).toContain(USER_SPOKE);
    expect(text(body)).toContain("before anything after the sleep ran");
    const ends = h.events().filter((e) => e.type === "step.end");
    expect(ends.at(-1)?.data).toEqual({ status: "cancelled" });
  });

  it("doesn't start when the user's message came while dot chose it", async () => {
    const h = setup();
    sleepy(h);
    h.session.post("steer", "Stop waiting");
    const { body } = await h.call("shell", { command: "sleep 60 && curl -s localhost:3000" });
    expect(body.ok).toBe(false);
    expect(text(body)).toContain("Not run: the user sent a new message");
    expect(h.desktop.shellCalls).toEqual([]);
  });

  it("lets a command that ends by itself finish, and the message ends the next wait instead", async () => {
    const h = setup();
    h.tools.sleep = endless;
    let release!: () => void;
    const base = h.tools.desktop("cell");
    if (!base) throw new Error("no desktop");
    h.tools.desktop = () => ({
      ...base,
      shell: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          done: true as const,
          exitCode: 0,
          signal: null,
          timedOut: false,
          truncated: false,
          ms: 5,
        };
      },
    });
    const running = h.call("shell", { command: "pnpm test" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.session.post("steer", "Also run the linter");
    release();
    const { body } = await running;
    expect(body.ok).toBe(true);
    expect(text(body)).toContain("Exit code 0.");
    expect(text((await h.call("done", WAITING)).body)).toContain("A new user instruction arrived");
  });

  it("tells the wait's message apart when the user queued it for after this task", async () => {
    const h = setup();
    const stopped = sleepy(h);
    const running = h.call("shell", { command: "sleep 90; echo waited", timeout_sec: 120 });
    setTimeout(() => h.session.enqueue("Then deploy it"), 20);
    const { body } = await running;
    expect(stopped).toEqual(["sleep 90; echo waited"]);
    expect(text(body)).toContain("queued a message for after this task");
    const inbox = await h.app.request("/v1/inbox?after=0&waitMs=0", { headers: h.auth });
    const { items } = (await inbox.json()) as { items: { kind: string; text: string }[] };
    expect(items).toMatchObject([{ kind: "steer", text: "Then deploy it" }]);
    const delivery = h
      .events()
      .filter((e) => e.type === "message.delivery")
      .map((e) => (e.data as { state: string }).state);
    expect(delivery).toEqual(["steering", "woke"]);
  });

  it("leaves a queued message queued through a short wait, and through other commands", async () => {
    const h = setup();
    h.tools.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1)));
    h.session.enqueue("Then deploy it");
    const short = await h.call("shell", { command: "sleep 2; echo waited" });
    expect(text(short.body)).toContain("Exit code 0.");
    const other = await h.call("shell", { command: "pnpm test" });
    expect(text(other.body)).toContain("Exit code 0.");
    const inbox = await h.app.request("/v1/inbox?after=0&waitMs=0", { headers: h.auth });
    expect(((await inbox.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("is only the sleep a command starts with, after nothing but cd, export or assignments", () => {
    expect(openingSleepMs("sleep 90; echo waited")).toBe(90_000);
    expect(openingSleepMs("sleep 480; cd ~/site && pgrep -f stageB")).toBe(480_000);
    expect(openingSleepMs("export DISPLAY=:1\nsleep 20\nxdotool type hi")).toBe(20_000);
    expect(openingSleepMs("cd ~/app && sleep 1.5 && curl -s localhost")).toBe(1500);
    expect(openingSleepMs("sleep 2m")).toBe(120_000);
    for (const command of [
      "pnpm build && sleep 30",
      "sleep 5 &",
      "sleep 5 | cat",
      "sleep $DELAY; echo",
      "X=1 sleep 5",
      "cd 'my app' && sleep 5",
      "sleep 10 # for the page",
    ])
      expect(openingSleepMs(command)).toBeUndefined();
  });
});

describe("a command that isn't a wait, when the user speaks", () => {
  // The desktop's shell: runs until the test ends it, printing what it is given.
  function building(h: ReturnType<typeof setup>) {
    const run = Promise.withResolvers<ShellDone>();
    const seen: { signal?: AbortSignal; onChunk?: (c: ShellChunk) => void } = {};
    const base = h.tools.desktop("cell");
    if (!base) throw new Error("no desktop");
    h.tools.desktop = () => ({
      ...base,
      shell: async (req, onChunk: (c: ShellChunk) => void, signal?: AbortSignal) => {
        h.desktop.shellCalls.push(req.command);
        seen.onChunk = onChunk;
        if (signal) seen.signal = signal;
        return run.promise;
      },
    });
    return { run, seen };
  }
  const ended = (exitCode = 0): ShellDone => ({
    done: true,
    exitCode,
    signal: null,
    timedOut: false,
    truncated: false,
    ms: 5,
  });
  const started = (h: ReturnType<typeof setup>) =>
    vi.waitFor(() => expect(h.desktop.shellCalls).toHaveLength(1));
  const inboxOf = async (h: ReturnType<typeof setup>) => {
    const inbox = await h.app.request("/v1/inbox?after=0&waitMs=0", { headers: h.auth });
    return ((await inbox.json()) as { items: { kind: string; text: string }[] }).items;
  };
  const toolEnds = (h: ReturnType<typeof setup>) => h.events().filter((e) => e.type === "tool.end");

  it("goes on in the background, and dot hears the message at once", async () => {
    const h = setup();
    const { run, seen } = building(h);
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    seen.onChunk?.({ stream: "stdout", chunk: `compiling ${"the sources ".repeat(20)}\n` });
    h.session.post("steer", "Also add the changelog");
    const { body } = await call;
    expect(body.ok).toBe(true);
    expect(text(body)).toContain("has not finished");
    expect(text(body)).toContain("compiling");
    expect(text(body)).not.toContain("Exit code");
    // Nothing says it ended, and the command was not asked to stop.
    expect(toolEnds(h)).toEqual([]);
    expect(seen.signal?.aborted).toBe(false);
    expect(h.session.leftRunning).toBe(1);
    expect(
      h
        .events()
        .filter((e) => e.type === "message.delivery")
        .map((e) => (e.data as { state: string }).state),
    ).toEqual(["left_running"]);

    seen.onChunk?.({ stream: "stdout", chunk: "built in 3 s\n" });
    run.resolve(ended());
    await vi.waitFor(() => expect(h.session.leftRunning).toBe(0));
    expect(toolEnds(h).at(-1)?.data).toEqual({ ok: true, exitCode: 0 });
    const said = (await inboxOf(h)).map((item) => item.text);
    expect(said[0]).toBe("Also add the changelog");
    expect(said[1]).toContain("has ended: pnpm build");
    expect(said[1]).toContain("Exit code 0.");
    expect(said[1]).toContain("built in 3 s");
  });

  it("doesn't let dot finish the task while the command runs", async () => {
    const h = setup();
    const { run } = building(h);
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    await call;
    const refused = await h.call("done", {
      summary: "Built",
      completion: { status: "complete", evidence: "It built" },
      input_request: null,
      experience: null,
    });
    expect(refused.body.ok).toBe(false);
    expect(text(refused.body)).toContain("hasn't ended");
    expect(refused.body.final).toBeUndefined();
    // The wait ends with the command, well before its 30 seconds.
    h.tools.sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
    const waiting = h.call("done", WAITING);
    await new Promise((resolve) => setTimeout(resolve, 5));
    run.resolve(ended());
    const waited = text((await waiting).body);
    expect(waited).toContain("Waited");
    expect(waited).not.toContain("Waited 30 seconds");
  });

  it("is stopped by Stop like any command, and cleanup waits for its end", async () => {
    const h = setup();
    const { run, seen } = building(h);
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    await call;
    h.session.stop();
    expect(seen.signal?.aborted).toBe(true);
    let settled = false;
    const settling = h.session.toolsSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    run.resolve({ ...ended(), exitCode: null, signal: "SIGTERM" });
    await settling;
    expect(h.session.leftRunning).toBe(0);
  });

  it("stays stopped by its own lease once the call that started it has its answer", async () => {
    const h = setup();
    const { run, seen } = building(h);
    const asking = new AbortController();
    const call = h.app.request("/v1/tools/shell", {
      method: "POST",
      headers: h.auth,
      signal: asking.signal,
      body: JSON.stringify({ callId: "c-1", input: { command: "pnpm build" } }),
    });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    await call;
    // The request that started it going away says nothing about the command now.
    asking.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen.signal?.aborted).toBe(false);
    run.resolve(ended());
    await vi.waitFor(() => expect(h.session.leftRunning).toBe(0));
  });

  it("holds the computer when its end can't be proved, exactly as if dot had waited", async () => {
    const h = setup();
    const contained = vi.fn(async () => {});
    h.tools.stopForUncertainty = contained;
    const { run } = building(h);
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    await call;
    run.reject(new ShellExecutionUncertainError());
    await vi.waitFor(() =>
      expect(contained).toHaveBeenCalledWith(h.session, "shell_execution_uncertain", undefined),
    );
    await vi.waitFor(() => expect(h.session.leftRunning).toBe(0));
    expect(h.session.stopped).toBe(true);
    // Nothing tells dot, or the log, that it ended well.
    expect(toolEnds(h).at(-1)?.data).toEqual({ ok: false });
    expect(
      h
        .events()
        .filter((e) => e.type === "step.end")
        .at(-1)?.data,
    ).toMatchObject({ status: "failed" });
  });

  it("is told if the command failed some other way", async () => {
    const h = setup();
    const { run } = building(h);
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    await call;
    run.reject(new Error("the computer refused it"));
    await vi.waitFor(() => expect(h.session.leftRunning).toBe(0));
    const said = (await inboxOf(h)).map((item) => item.text);
    expect(said[1]).toContain("the computer refused it");
    expect(toolEnds(h).at(-1)?.data).toEqual({ ok: false });
  });

  it("waits a moment first, for a command about to end", async () => {
    const h = setup();
    const { run } = building(h);
    const grace = Promise.withResolvers<void>();
    h.tools.sleep = () => grace.promise;
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    run.resolve(ended());
    const { body } = await call;
    expect(text(body)).toContain("Exit code 0.");
    expect(h.session.leftRunning).toBe(0);
    grace.resolve();
  });

  it("isn't left running again for the same message, and a delegated agent's never is", async () => {
    const h = setup();
    const first = building(h);
    const call = h.call("shell", { command: "pnpm build" });
    await started(h);
    h.session.post("steer", "Also add the changelog");
    await call;
    first.run.resolve(ended());
    await vi.waitFor(() => expect(h.session.leftRunning).toBe(0));
    h.desktop.shellCalls.length = 0;
    const second = building(h);
    const next = h.call("shell", { command: "pnpm test" });
    await started(h);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.session.leftRunning).toBe(0);
    second.run.resolve(ended());
    expect(text((await next).body)).toContain("Exit code 0.");

    h.desktop.shellCalls.length = 0;
    const third = building(h);
    const delegated = h.call("shell", { command: "pnpm lint" }, "sub-child-1");
    await started(h);
    h.session.post("steer", "And the docs");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.session.leftRunning).toBe(0);
    third.run.resolve(ended());
    expect(text((await delegated).body)).toContain("Exit code 0.");
  });
});
