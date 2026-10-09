import {
  type AutonomyPolicy,
  CAREFUL_AUTONOMY,
  type ComputerAction,
  DEFAULT_AUTONOMY,
  ulid,
} from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import type { NativeActionIdentity } from "../../gateway/gateway.ts";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { computerTool } from "../tools/computer.ts";
import type { ToolCallContext, ToolDeps } from "../tools/deps.ts";
import { authorizePrepared, toolRisk } from "./authorize.ts";
import { type EvidenceRow, MANUAL_DRAWING_TASK } from "./fixtures/manual-drawing-task.ts";

const SECRET = "synthetic-known-secret-0123";

function harness(policy: AutonomyPolicy | undefined, screen?: "browser") {
  const session = new AgentSession(ulid(), ulid(), "task", { append: vi.fn() }, policy);
  const asks = vi.spyOn(session, "requestApproval").mockResolvedValue("approve");
  const handoffs = vi.spyOn(session, "takeover").mockResolvedValue({ by: "user" });
  const signal = new AbortController().signal;
  const ctx = {
    session,
    generation: { id: 1, signal },
    lease: { generation: { id: 1, signal }, signal, check() {}, finish() {} },
    check() {},
    callId: ulid(),
    step: ulid(),
    redact: redactor([SECRET]),
    signal,
    ...(screen ? { screen: { selection: { screen }, finish() {} } } : {}),
  } as unknown as ToolCallContext;
  return { ctx, asks, handoffs };
}

async function native(
  ctx: ToolCallContext,
  action: ComputerAction,
  identity: NativeActionIdentity,
) {
  const deps = {
    gateway: {
      run: async (
        context: { authorizeAgent(r: unknown): Promise<unknown> },
        request: { verb: string },
      ) => {
        const permit = await context.authorizeAgent({
          action: request,
          identity,
          revalidate: async () => true,
        });
        return permit ? { ok: true } : { ok: false, cancelled: "user" };
      },
    },
  } as unknown as ToolDeps;
  return computerTool(deps, ctx, action);
}

async function run(ctx: ToolCallContext, row: EvidenceRow) {
  if (row.kind === "native") return native(ctx, row.action, row.identity);
  const facts = toolRisk(row.tool, row.input);
  if (!facts) return undefined;
  return authorizePrepared(ctx, {
    tool: row.tool,
    input: row.input,
    target: null,
    facts,
    revalidate: async () => true,
  });
}

async function replay(policy: AutonomyPolicy | undefined) {
  const perRow: { id: string; asks: number; handoffs: number }[] = [];
  for (const row of MANUAL_DRAWING_TASK) {
    const h = harness(policy);
    await run(h.ctx, row);
    perRow.push({
      id: row.id,
      asks: h.asks.mock.calls.length,
      handoffs: h.handoffs.mock.calls.length,
    });
  }
  return perRow;
}

describe("the manual drawing task under the autonomy presets", () => {
  it("replays all 37 recorded cards and hand-offs", () => {
    expect(MANUAL_DRAWING_TASK).toHaveLength(37);
    expect(MANUAL_DRAWING_TASK.filter((row) => row.id.startsWith("H"))).toHaveLength(4);
  });

  it("Balanced, the default, works through every step without asking or handing off", async () => {
    const rows = await replay(DEFAULT_AUTONOMY);
    expect(rows.filter((row) => row.asks > 0).map((row) => row.id)).toEqual([]);
    expect(rows.filter((row) => row.handoffs > 0).map((row) => row.id)).toEqual([]);
  });

  it("Careful asks once for every non-reading step and never hands off", async () => {
    const rows = await replay(CAREFUL_AUTONOMY);
    const authorized = rows.filter((row) => row.id !== "H4");
    expect(authorized.filter((row) => row.asks !== 1).map((row) => row.id)).toEqual([]);
    expect(rows.filter((row) => row.handoffs > 0).map((row) => row.id)).toEqual([]);
  });

  it("the model's own request for help is not a policy decision", () => {
    const row = MANUAL_DRAWING_TASK.find((candidate) => candidate.id === "H4");
    expect(row?.kind).toBe("model");
    if (row?.kind === "model") expect(toolRisk(row.tool, row.input)).toBeUndefined();
  });
});

describe("consequential steps still stop under Balanced", () => {
  const web = (name: string, role = "button") => ({
    target: {
      point: { x: 10, y: 10 },
      source: "dom" as const,
      role,
      name,
      url: "https://shop.example.test/item/7",
    },
    window: 3,
    point: { x: 10, y: 10 },
  });
  it.each([
    ["a Send button on a web page", { action: "click", point: { x: 10, y: 10 } }, web("Send")],
    ["a Buy button on a web page", { action: "click", point: { x: 10, y: 10 } }, web("Buy now")],
  ] as const)("%s asks", async (_name, action, identity) => {
    const h = harness(DEFAULT_AUTONOMY);
    await native(h.ctx, action, identity);
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
  });

  it.each<[string, ComputerAction]>([
    ["Enter", { action: "key", keys: ["Return"] }],
    ["Typing past a Tab, whose space presses Send,", { action: "type", text: "Hi Bob.\t " }],
  ])("%s in a compose field on the signed-in browser asks", async (_name, action) => {
    const h = harness(DEFAULT_AUTONOMY, "browser");
    await native(h.ctx, action, {
      target: {
        point: { x: 5, y: 5 },
        source: "ax",
        role: "textbox",
        name: "Input field",
        app: "Chromium",
      },
      window: null,
      point: { x: 5, y: 5 },
    });
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
    expect(h.asks.mock.calls[0]?.[1]).toMatchObject({ actionClass: "send" });
  });

  it("a push after a comment with an apostrophe asks", async () => {
    const h = harness(DEFAULT_AUTONOMY);
    await run(h.ctx, {
      id: "c",
      kind: "tool",
      tool: "shell",
      input: { command: "# Push the branch so it's on the remote\ngit push origin main" },
    });
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
    expect(h.asks.mock.calls[0]?.[1]).toMatchObject({ actionClass: "post" });
  });

  describe("the desktop's terminal window", () => {
    const terminal: NativeActionIdentity = {
      target: {
        point: { x: 300, y: 200 },
        source: "ax",
        role: "terminal",
        name: "Terminal",
        app: "Xfce4-terminal",
      },
      window: 4,
      point: { x: 300, y: 200 },
    };
    const enter: ComputerAction = { action: "key", keys: ["Return"] };
    const push: ComputerAction = { action: "type", text: "git push origin main\n" };

    it.each([enter, push])("runs a line while the desktop is signed out: %j", async (action) => {
      const h = harness(DEFAULT_AUTONOMY);
      await native(h.ctx, action, terminal);
      expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([0, 0]);
    });

    it("runs Enter once the desktop is signed in, and asks for it under Careful", async () => {
      const h = harness(DEFAULT_AUTONOMY);
      h.ctx.session.taskAutonomy.signIn("desktop");
      await native(h.ctx, enter, terminal);
      expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([0, 0]);
      const careful = harness(CAREFUL_AUTONOMY);
      careful.ctx.session.taskAutonomy.signIn("desktop");
      await native(careful.ctx, enter, terminal);
      expect(careful.asks.mock.calls[0]?.[1]).toMatchObject({ actionClass: "unknown" });
    });

    it("names a typed push and shows its command once the desktop is signed in", async () => {
      const h = harness(DEFAULT_AUTONOMY);
      h.ctx.session.taskAutonomy.signIn("desktop");
      await native(h.ctx, push, terminal);
      expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
      const card = h.asks.mock.calls[0]?.[1];
      expect(card).toMatchObject({ actionClass: "post" });
      expect(card?.fields).toContainEqual(["Command", "git push origin main\n"]);
    });
  });

  it.each([
    ["git push", "git push origin main"],
    ["posting data to a remote host", "curl -s -d @report.json https://api.example.test/v1/items"],
  ])("%s asks", async (_name, command) => {
    const h = harness(DEFAULT_AUTONOMY);
    await run(h.ctx, { id: "c", kind: "tool", tool: "shell", input: { command } });
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
  });

  it("saving to its memory runs, and asks under Careful", async () => {
    const remember = {
      id: "m",
      kind: "tool",
      tool: "remember",
      input: { file: "MEMORY.md", op: "append", text: "Prefers the soft brush." },
    } as const;
    const h = harness(DEFAULT_AUTONOMY);
    await run(h.ctx, remember);
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([0, 0]);
    const careful = harness(CAREFUL_AUTONOMY);
    await run(careful.ctx, remember);
    expect([careful.asks.mock.calls.length, careful.handoffs.mock.calls.length]).toEqual([1, 0]);
  });

  it("an upload asks", async () => {
    const h = harness(DEFAULT_AUTONOMY);
    await authorizePrepared(h.ctx, {
      tool: "browser_upload",
      input: { files: ["~/report.pdf"] },
      target: null,
      facts: { operation: "files_upload" },
      revalidate: async () => true,
    });
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
  });

  it("a password field hands off", async () => {
    const h = harness(DEFAULT_AUTONOMY);
    await native(
      h.ctx,
      { action: "type", text: "hunter" },
      {
        target: {
          point: { x: 1, y: 1 },
          source: "dom",
          role: "textbox",
          name: "Password",
          url: "https://login.example.test/",
          secret: true,
        },
        window: 2,
        point: { x: 1, y: 1 },
      },
    );
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([0, 1]);
  });

  it.each(["Protected field", "Passwort"])(
    "a field the page marks secret hands off even when named %s",
    async (name) => {
      const h = harness(DEFAULT_AUTONOMY);
      await native(
        h.ctx,
        { action: "type", text: "hunter" },
        {
          target: {
            point: { x: 1, y: 1 },
            source: "dom",
            role: "textbox",
            name,
            url: "https://login.example.test/",
            secret: true,
          },
          window: 2,
          point: { x: 1, y: 1 },
        },
      );
      expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([0, 1]);
    },
  );

  it("a known secret in the typed text hands off", async () => {
    const h = harness(DEFAULT_AUTONOMY);
    await native(
      h.ctx,
      { action: "type", text: `token ${SECRET}` },
      { target: null, window: 2, point: null },
    );
    expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([0, 1]);
  });
});
