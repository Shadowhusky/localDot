import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AutonomyPolicy,
  BrowserReadResult,
  FileChangeResult,
  ShellChunk,
  ShellDone,
} from "@localdot/protocol";
import { CAREFUL_AUTONOMY, ulid } from "@localdot/protocol";
import { EventLog } from "../../event-log.ts";
import type { ActionContext, ActionOutcome, GuiAction } from "../../gateway/gateway.ts";
import { MemoryStore } from "../memory.ts";
import { actPolicy, type ToolPolicy } from "../policy.ts";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { createToolApi } from "../tool-api.ts";
import type { ToolDeps } from "../tools/deps.ts";
import { TranscriptStore } from "../transcript.ts";

export const TOOL_TOKEN = "t".repeat(43);
export const PROXY_TOKEN = "p".repeat(43);
export const SURROGATE = "ld_web_0123456789abcdefghijkl_abcdef";

export interface FakeDesktop {
  shellCalls: string[];
  editCalls: string[];
  shellOutput: ShellChunk[];
  shellDone: Partial<ShellDone>;
  files: Map<string, string>;
  page: BrowserReadResult;
}

// A tool API over fakes: the gateway records its actions and makes up frames, the desktop keeps
// files in a map and replays scripted shell output, PNGs are tiny placeholders.
export function toolHarness(
  opts: {
    policy?: ToolPolicy;
    maxToolCalls?: number;
    askTimeoutMs?: number;
    autoApprove?: boolean;
    autonomy?: AutonomyPolicy;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "local dot's tool api-"));
  const eventLog = new EventLog(home);
  const sessionId = eventLog.createSession("task");
  // Suites here exercise the approval machinery, so they run under the preset that asks for it.
  const session = new AgentSession(
    sessionId,
    ulid(),
    "Find the weather",
    eventLog,
    opts.autonomy ?? CAREFUL_AUTONOMY,
  );
  session.beginBrain();
  session.toolToken = TOOL_TOKEN;
  session.status = "running";
  // Legacy transport/handler fixtures simulate an explicit user answer. Security suites opt out.
  const unapprove =
    opts.autoApprove === false
      ? () => {}
      : eventLog.subscribe((id, event) => {
          if (id !== session.id || event.type !== "approval.request") return;
          queueMicrotask(() => {
            const card = session.pendingApproval;
            if (card?.approvalId !== event.data.approvalId) return;
            // Like the card, read every value it carries only in part before approving.
            for (const { field } of card.partial ?? [])
              session.approvalField(card.approvalId, field);
            session.answerApproval({
              approvalId: card.approvalId,
              generation: card.generation,
              revision: card.revision,
              decision: "approve",
            });
          });
        });

  const actions: { ctx: ActionContext; action: GuiAction }[] = [];
  let nextOutcome: (a: GuiAction) => ActionOutcome = () => ({ ok: true, frameId: ulid() });
  const desktop: FakeDesktop = {
    shellCalls: [],
    editCalls: [],
    shellOutput: [],
    shellDone: {},
    files: new Map(),
    page: {
      url: "https://example.com/",
      title: "Example",
      text: "Hello",
      outline: "",
      truncated: false,
    },
  };
  const outputs = new Map<string, Buffer>();
  const launches: unknown[] = [];
  const tools: ToolDeps = {
    gateway: {
      run: async (ctx, action) => {
        actions.push({ ctx, action });
        return nextOutcome(action);
      },
      observe: async () => ({ frameId: ulid(), pointer: { x: 10, y: 20 } }),
      cursorOf: () => ({ x: 600, y: 400 }),
    },
    scaleOf: () => 2,
    desktop: () => ({
      shell: async (req, onChunk) => {
        desktop.shellCalls.push(req.command);
        for (const c of desktop.shellOutput) onChunk(c);
        return {
          done: true,
          exitCode: 0,
          signal: null,
          timedOut: false,
          truncated: false,
          ms: 5,
          ...desktop.shellDone,
        };
      },
      readFile: async (path) => {
        const content = desktop.files.get(path);
        if (content === undefined) throw new Error("missing");
        return {
          path: `~/${path}`,
          content,
          bytes: content.length,
          truncated: false,
          binary: false,
        };
      },
      writeFile: async (path, content): Promise<FileChangeResult> => {
        const op = desktop.files.has(path) ? "modify" : "create";
        desktop.files.set(path, content);
        return { path: `~/${path}`, op, patch: `+${content}`, bytes: content.length };
      },
      editFile: async (path) => {
        desktop.editCalls.push(path);
        return { path: `~/${path}`, op: "modify", patch: "", bytes: 0 };
      },
      listDir: async (path) => ({ path: `~/${path}`, entries: [], truncated: false }),
      fetchFile: async (path) =>
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(desktop.files.get(path) ?? ""));
            c.close();
          },
        }),
      browserRead: async () => desktop.page,
      browserNavigate: async (url) => ({ url, title: "Example", loaded: true }),
    }),
    launcher: () => ({
      launch: async (req) => {
        launches.push(req);
        return { pid: 1, armedMono: 1 };
      },
    }),
    png: { png: async (_s, frameId) => Buffer.from(`png:${frameId}`) },
    memory: new MemoryStore(home),
    saveOutput: async (_s, name, source, scope) => {
      scope.check();
      const bytes = Buffer.from(await new Response(source).arrayBuffer());
      scope.check();
      outputs.set(name, bytes);
      return { path: name, bytes: bytes.length };
    },
    stopForUncertainty: async () => {},
    sleep: async () => {},
    ...(opts.askTimeoutMs ? { askTimeoutMs: opts.askTimeoutMs } : {}),
  };
  const transcripts = new TranscriptStore(home);
  const app = createToolApi({
    sessions: () => [session],
    tools,
    policy: opts.policy ?? actPolicy,
    ...(opts.maxToolCalls ? { maxToolCalls: opts.maxToolCalls } : {}),
    transcripts,
    png: tools.png,
    redactorFor: () => redactor([PROXY_TOKEN, TOOL_TOKEN]),
  });
  const auth = { authorization: `Bearer ${TOOL_TOKEN}`, "content-type": "application/json" };
  const call = async (name: string, input: unknown) => {
    const res = await app.request(`/v1/tools/${name}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ callId: "c1", input }),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        ok: boolean;
        final?: boolean;
        pause?: boolean;
        content: { type: string; text?: string; frameId?: string; data?: string }[];
      },
    };
  };
  const events = () => eventLog.read(sessionId);
  let resourcesClosed = false;
  let resourceCleanupError: AggregateError | undefined;
  const closeResources = () => {
    if (resourcesClosed) {
      if (resourceCleanupError) throw resourceCleanupError;
      return;
    }
    resourcesClosed = true;
    const errors: unknown[] = [];
    for (const close of [unapprove, () => session.stop(), () => eventLog.close()]) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      resourceCleanupError = new AggregateError(errors, "fixture resource cleanup uncertain");
      throw resourceCleanupError;
    }
  };
  return {
    home,
    closeResources,
    close: () => {
      closeResources();
      rmSync(home, { recursive: true, force: true });
    },
    tools,
    eventLog,
    session,
    app,
    auth,
    call,
    events,
    actions,
    desktop,
    outputs,
    launches,
    transcripts,
    setOutcome: (f: typeof nextOutcome) => (nextOutcome = f),
  };
}
