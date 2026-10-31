import type { ShellChunk } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
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

  it("lets other commands finish, and the message ends the next wait instead", async () => {
    const h = setup();
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
    h.tools.sleep = endless;
    expect(text((await h.call("done", WAITING)).body)).toContain("A new user instruction arrived");
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
