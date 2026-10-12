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
  extra: Partial<ToolDeps> = {},
) {
  const deps = {
    scaleOf: () => 1,
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
    ...extra,
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

describe("chat permission modes", () => {
  const effect = (operation: "files_delete" | "files_write") => ({
    tool: "files" as const,
    input: { op: operation === "files_delete" ? "delete" : "write", path: "/home/user/note.txt" },
    target: null,
    facts: { operation },
    revalidate: async () => true,
  });
  it("full access permits work and still asks before deletion", async () => {
    const h = harness(CAREFUL_AUTONOMY);
    h.ctx.session.permissionMode = () => "full";
    expect(await authorizePrepared(h.ctx, effect("files_write"))).toBeDefined();
    expect(h.asks).not.toHaveBeenCalled();
    await authorizePrepared(h.ctx, effect("files_delete"));
    expect(h.asks).toHaveBeenCalledTimes(1);
  });
  it.each([
    "echo 'rm -rf /home/user/data'",
    "grep -n 'unlink' source.py",
    "ls /tmp/remove-example",
    "rm -f /tmp/installer.deb",
    "cd /tmp; rm -f installer.deb; curl -sIL https://example.test/package.deb",
    "cd /var/tmp && rm -f package.zip && uname -m",
    "dd if=/dev/zero of=/dev/null count=1",
  ])(
    "full access does not mistake scratch cleanup or quoted words for destruction: %s",
    async (command) => {
      const h = harness(CAREFUL_AUTONOMY);
      h.ctx.session.permissionMode = () => "full";
      await run(h.ctx, { id: "scratch", kind: "tool", tool: "shell", input: { command } });
      expect(h.asks).not.toHaveBeenCalled();
    },
  );

  it.each([
    "rm -rf /home/user/data",
    "rm -rf /tmp/data",
    "rm -f /tmp/link/doc.txt",
    "rm -f /tmp/../home/user/data",
    "rm -f /tmp/$file",
    "cd /tmp; rm -f package.deb; rm -rf /home/user/data",
    "echo 'rm -rf /home/user/data' | sh",
    "bash -c 'rm -rf /home/user/data'",
    `python3 -c 'import os; os.remove("/home/user/data")'`,
    "dd if=/dev/zero of=/dev/sda",
    "git reset --hard",
  ])("full access keeps confirmation for destructive commands: %s", async (command) => {
    const h = harness(CAREFUL_AUTONOMY);
    h.ctx.session.permissionMode = () => "full";
    await run(h.ctx, { id: "destructive", kind: "tool", tool: "shell", input: { command } });
    expect(h.asks).toHaveBeenCalledOnce();
    expect(h.asks.mock.calls[0]?.[1]).toMatchObject({ title: "Delete or overwrite data" });
  });

  it("auto permits only a Jev approval and asks when unavailable or unsure", async () => {
    const h = harness(CAREFUL_AUTONOMY);
    h.ctx.session.permissionMode = () => "auto";
    h.ctx.session.taskAutonomy.signIn("desktop");
    const judge = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("offline"));
    h.ctx.session.autoPermit = judge;
    await authorizePrepared(h.ctx, effect("files_write"));
    expect(h.asks).not.toHaveBeenCalled();
    await authorizePrepared(h.ctx, effect("files_write"));
    await authorizePrepared(h.ctx, effect("files_write"));
    expect(h.asks).toHaveBeenCalledTimes(2);
    await authorizePrepared(h.ctx, effect("files_delete"));
    expect(judge).toHaveBeenCalledTimes(3);
    expect(h.asks).toHaveBeenCalledTimes(3);
  });
  it("auto runs identified routine controls without a judge round trip", async () => {
    const h = harness(CAREFUL_AUTONOMY);
    h.ctx.session.permissionMode = () => "auto";
    h.ctx.session.taskAutonomy.signIn("desktop");
    h.ctx.session.autoPermit = vi.fn(async () => false);
    for (const facts of [
      { operation: "window" as const },
      { operation: "scroll" as const },
      {
        operation: "click" as const,
        target: { source: "ax" as const, fresh: true, role: "button", name: "Maximize" },
      },
    ]) {
      await authorizePrepared(h.ctx, {
        tool: "computer",
        input: {},
        target: null,
        facts,
        revalidate: async () => true,
      });
    }
    expect(h.asks).not.toHaveBeenCalled();
    expect(h.ctx.session.autoPermit).not.toHaveBeenCalled();
  });
  it("auto gives the judge target evidence and still asks for an unidentified signed-in click", async () => {
    const h = harness(CAREFUL_AUTONOMY);
    h.ctx.session.permissionMode = () => "auto";
    h.ctx.session.taskAutonomy.signIn("desktop");
    const judge = vi.fn(async (_action: unknown, _signal: AbortSignal) => false);
    h.ctx.session.autoPermit = judge;
    const target = { point: { x: 10, y: 20 }, source: "coords" };
    await authorizePrepared(h.ctx, {
      tool: "computer",
      input: { action: "click" },
      target,
      facts: { operation: "click", target: { source: "coords", fresh: true } },
      revalidate: async () => true,
    });
    expect(judge.mock.calls[0]?.[0]).toMatchObject({
      target,
      facts: { signedIn: true, target: { source: "coords" } },
    });
    expect(h.asks).toHaveBeenCalledOnce();
  });
  it("does not execute an auto-approved target that changed during the check", async () => {
    const h = harness(CAREFUL_AUTONOMY);
    h.ctx.session.permissionMode = () => "auto";
    h.ctx.session.taskAutonomy.signIn("desktop");
    h.ctx.session.autoPermit = async () => true;
    expect(
      await authorizePrepared(h.ctx, { ...effect("files_write"), revalidate: async () => false }),
    ).toBeUndefined();
  });
});

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

    it("asks for Enter once the desktop is signed in", async () => {
      const h = harness(DEFAULT_AUTONOMY);
      h.ctx.session.taskAutonomy.signIn("desktop");
      await native(h.ctx, enter, terminal);
      expect([h.asks.mock.calls.length, h.handoffs.mock.calls.length]).toEqual([1, 0]);
      expect(h.asks.mock.calls[0]?.[1]).toMatchObject({ actionClass: "unknown" });
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

describe("visual click target freshness", () => {
  it.each([false, true])(
    "rechecks observed pixels before clicking (changed: %s)",
    async (changed) => {
      const h = harness(CAREFUL_AUTONOMY);
      h.ctx.session.permissionMode = () => "auto";
      h.ctx.session.taskAutonomy.signIn("desktop");
      const observe = vi.fn(async () => ({ frameId: "fresh", pointer: { x: 200, y: 288 } }));
      let crops = 0;
      const png = vi.fn(async (_session: string, _frame: string, region?: unknown) => {
        if (!region) return Buffer.from("screen");
        crops++;
        return Buffer.from(changed && crops > 1 ? "changed target" : "same target");
      });
      h.ctx.session.autoPermit = async (_action, _signal, read) => {
        expect(await read?.()).toEqual({
          image: Buffer.from("screen").toString("base64"),
          point: { x: 100, y: 144 },
        });
        return true;
      };
      const run = vi.fn(
        async (context: { authorizeAgent(r: unknown): Promise<unknown> }, action: unknown) => {
          const permit = await context.authorizeAgent({
            action,
            identity: { target: null, window: 1, point: { x: 200, y: 288 } },
            revalidate: async () => true,
          });
          return permit ? { ok: true } : { ok: false, cancelled: "user" };
        },
      );
      const result = await native(
        h.ctx,
        { action: "click", point: { x: 100, y: 144 } },
        { target: null, window: 1, point: { x: 200, y: 288 } },
        {
          scaleOf: () => 2,
          png: { png },
          gateway: { run, observe } as unknown as ToolDeps["gateway"],
        },
      );
      expect(h.asks).not.toHaveBeenCalled();
      expect(result.ok).toBe(!changed);
      expect(crops).toBe(2);
    },
  );
});
