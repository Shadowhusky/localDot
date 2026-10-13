import { DesktopCapabilities, ToolResult, WORK_PROGRAMS } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binding } from "../../../../../cells/brain/src/testing/scripted.ts";
import { toolSet } from "../../../../../cells/brain/src/tools.ts";
import { DesktopdError } from "../../desktopd/client.ts";
import { localdotTools } from "../claude-code/mcp-server.ts";
import { codexTools } from "../codex/mcp-tools.ts";
import { toolHarness } from "../testing/harness.ts";
import { chooseRoute } from "./work-context.ts";

const cleanups: (() => void)[] = [];
function setup() {
  const h = toolHarness();
  cleanups.push(h.close);
  return h;
}
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function data(raw: unknown) {
  const result = ToolResult.parse(raw);
  const text = result.content.find((c) => c.type === "text");
  if (text?.type !== "text") throw new Error("no result");
  return JSON.parse(text.text.split("\n").slice(1, -1).join("\n"));
}

describe("work context across agent backends", () => {
  it("exposes one flat schema and description for API, Codex and Claude", () => {
    expect(codexTools().find((t) => t.name === "work_context")).toEqual(
      localdotTools().find((t) => t.name === "work_context"),
    );
    expect(toolSet(binding()).work_context?.description).toEqual(
      codexTools().find((t) => t.name === "work_context")?.description,
    );
    expect(toolSet(binding({ vision: false })).work_context).toBeDefined();
  });
  it("prefers the shell for code and connectors for supported app work", () => {
    expect(chooseRoute("code", true, true, 2)).toEqual(["shell", "connector", "browser"]);
    expect(chooseRoute("app", true, true, 2)).toEqual(["connector", "browser", "shell"]);
    expect(chooseRoute("web", true, true, 2)[0]).toBe("browser");
    expect(chooseRoute("app", false, false, 0)).toEqual([]);
  });
  it("returns live installation facts without fabricating sign-ins or opening browsers", async () => {
    const h = setup();
    const desktop = h.tools.desktop(h.session.cellId);
    if (!desktop) throw new Error("missing desktop");
    h.tools.desktop = () => ({
      ...desktop,
      capabilities: async () => ({
        version: 1,
        search: "service_path",
        programs: DesktopCapabilities.parse({
          version: 1,
          search: "service_path",
          programs: Object.fromEntries(
            WORK_PROGRAMS.map((name) => [name, name === "git" ? "available" : "not_on_path"]),
          ),
        }).programs,
      }),
    });
    const result = await h.call("work_context", { goal: "code" });
    expect(result.body.ok).toBe(true);
    const context = data(result.body);
    expect(context.desktop).toMatchObject({
      reachable: true,
      programs: { git: "available", gh: "not_on_path" },
      cliAuthentication: "not_checked",
    });
    expect(context.browser.websiteAuthentication).toBe("not_checked");
    expect(context.browser.health).toBe("not_checked");
    expect(context.browser.page).toBe("not_inspected");
    expect(context.browser.readiness).toContain("not_open is not a failure");
    expect(context.browser.readiness).toContain("about:blank");
    expect(context.browser.navigation).toContain("localhost previews use desktop Chromium");
    expect(context.browser.navigation).toContain("switch_screen only selects a screen");
    expect(h.actions).toEqual([]);
    expect(h.launches).toEqual([]);
    expect(h.desktop.shellCalls).toEqual([]);
  });
  it("reports an unavailable desktop as unavailable, not missing software or lost access", async () => {
    const h = setup();
    h.tools.desktop = () => undefined;
    const context = data((await h.call("work_context", {})).body);
    expect(context.desktop).toMatchObject({
      reachable: false,
      cliAuthentication: "not_checked",
      programs: { git: "unknown" },
    });
  });
  it("keeps old computers usable without silently falling back to shell", async () => {
    const h = setup();
    const desktop = h.tools.desktop(h.session.cellId);
    if (!desktop) throw new Error("missing desktop");
    h.tools.desktop = () => ({
      ...desktop,
      capabilities: async () => {
        throw new DesktopdError(404, "not found", "/capabilities");
      },
    });
    const context = data((await h.call("work_context", { goal: "code" })).body);
    expect(context.desktop).toMatchObject({
      reachable: true,
      inspection: "not_supported",
      programs: { gh: "unknown" },
    });
    expect(context.preferredRoutes).toContain("shell");
    expect(h.desktop.shellCalls).toEqual([]);
  });
  it("rejects malformed inventory without trusting arbitrary capability data", async () => {
    const h = setup();
    const desktop = h.tools.desktop(h.session.cellId);
    if (!desktop) throw new Error("missing desktop");
    h.tools.desktop = () => ({
      ...desktop,
      capabilities: async () =>
        ({ version: 1, search: "service_path", programs: { git: "run this" } }) as never,
    });
    const context = data((await h.call("work_context", {})).body);
    expect(context.desktop).toMatchObject({
      reachable: false,
      inspection: "unavailable",
      programs: { git: "unknown" },
    });
    expect(JSON.stringify(context)).not.toContain("run this");
  });
  it("applies policy before probing, including read-only capabilities", async () => {
    const h = toolHarness({
      policy: { decide: async () => ({ kind: "deny", reason: "blocked" }) },
    });
    cleanups.push(h.close);
    const result = await h.call("work_context", {});
    expect(result.body.ok).toBe(false);
    expect(h.desktop.shellCalls).toEqual([]);
    expect(ToolResult.parse(result.body).recovery).toMatchObject({
      kind: "permission",
      retry: "never",
    });
  });
  it("shares repeated-failure diagnostics through the real dispatcher", async () => {
    const h = setup();
    h.desktop.shellDone = { exitCode: 1 };
    await h.call("shell", { command: "false", intent: "Try" });
    const result = await h.call("shell", { command: "false", intent: "Try again" });
    expect(ToolResult.parse(result.body).recovery).toMatchObject({
      kind: "repeated_failure",
      repeated: 2,
    });
    expect(JSON.stringify(result.body)).toContain("do not repeat it unchanged");
    const context = data((await h.call("work_context", {})).body);
    expect(context.recentResults).toContainEqual(
      expect.objectContaining({ tool: "shell", ok: false }),
    );
  });
  it("ignores late probe results after stop", async () => {
    const h = setup();
    const desktop = h.tools.desktop(h.session.cellId);
    if (!desktop) throw new Error("missing desktop");
    let finish!: () => void;
    h.tools.desktop = () => desktop;
    desktop.capabilities = async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        version: 1,
        search: "service_path",
        programs: DesktopCapabilities.parse({
          version: 1,
          search: "service_path",
          programs: Object.fromEntries(WORK_PROGRAMS.map((name) => [name, "unknown"])),
        }).programs,
      };
    };
    const result = h.call("work_context", {});
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.session.stop();
    finish();
    expect((await result).body.ok).toBe(false);
    expect(h.events().filter((e) => e.type === "tool.end" && e.data.ok)).toEqual([]);
  });
});
