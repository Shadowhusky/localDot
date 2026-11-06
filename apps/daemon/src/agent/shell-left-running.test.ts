import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import { toolHarness } from "./testing/harness.ts";
import type { ToolDeps } from "./tools/deps.ts";

const undo: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of undo.splice(0).reverse()) await step();
});
// The real desktop service's routes and the real client, running real commands.
function fixture() {
  const h = toolHarness();
  undo.push(h.close);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dot-left-running-")));
  undo.push(() => rmSync(home, { recursive: true, force: true }));
  const app = new Hono();
  addToolRoutes(app, {
    home,
    env: { PATH: process.env.PATH },
    browser: {
      read: async () => {
        throw new Error("unused");
      },
      navigate: async () => {
        throw new Error("unused");
      },
    },
  });
  const requests: string[] = [];
  const tools = new DesktopdTools({ baseUrl: "http://desktop.test", token: "fixture" }, (async (
    url,
    init,
  ) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return app.request(path, init as RequestInit);
  }) as typeof fetch);
  undo.push(() => tools.close());
  h.tools.desktop = () => tools as unknown as ReturnType<ToolDeps["desktop"]>;
  return { h, requests };
}
const text = (body: { content: { text?: string }[] }) =>
  body.content.map((part) => part.text ?? "").join("\n");
const inbox = async (h: ReturnType<typeof toolHarness>) => {
  const reply = await h.app.request("/v1/inbox?after=0&waitMs=0", { headers: h.auth });
  return ((await reply.json()) as { items: { text: string }[] }).items.map((item) => item.text);
};

describe("a real command left running", () => {
  it("reports the end the computer gave, exit code and output, when it comes", async () => {
    const { h } = fixture();
    const call = h.call("shell", {
      command: `head -c 300 /dev/zero | tr '\\0' 'x'; echo; sleep 1; echo finished-late; exit 3`,
    });
    await vi.waitFor(() => expect(h.events().some((e) => e.type === "tool.start")).toBe(true));
    h.session.post("steer", "Also add the changelog");
    const { body } = await call;
    expect(text(body)).toContain("has not finished");
    expect(h.session.leftRunning).toBe(1);
    expect(h.events().some((e) => e.type === "tool.end")).toBe(false);
    await vi.waitFor(() => expect(h.session.leftRunning).toBe(0), { timeout: 5000 });
    expect(h.events().find((e) => e.type === "tool.end")?.data).toEqual({ ok: false, exitCode: 3 });
    const note = (await inbox(h))[1];
    expect(note).toContain("Exit code 3.");
    expect(note).toContain("finished-late");
  }, 10_000);

  it("is stopped by Stop through the same stop request and receipt as any command", async () => {
    const { h, requests } = fixture();
    const call = h.call("shell", { command: "echo started; sleep 30" });
    await vi.waitFor(() => expect(h.events().some((e) => e.type === "tool.start")).toBe(true));
    h.session.post("steer", "Also add the changelog");
    await call;
    expect(h.session.leftRunning).toBe(1);
    expect(requests).toEqual(["/shell"]);
    h.session.stop();
    await h.session.toolsSettled();
    expect(requests).toContain("/shell/stop");
    expect(h.session.leftRunning).toBe(0);
  }, 15_000);
});
