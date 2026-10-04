import {
  type BrowserNavigateInput,
  type BrowserReadInput,
  type ToolResult,
  webUrl,
} from "@localdot/protocol";
import { DesktopdError } from "../../desktopd/client.ts";
import { untrusted } from "../untrusted.ts";
import { append, fail, frame, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
export async function browserReadTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserReadInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null)) return fail("Reading is not authorized.");
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop) return fail("The computer is not running.");
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", { tool: "browser_read", title: "Reading page" });
  const page = await desktop.browserRead(input.max_chars ?? 20000, ctx.signal);
  ctx.check();
  ctx.session.tainted = true;
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  return {
    ok: true,
    content: [
      text(
        untrusted(
          `web page ${ctx.redact(page.url)}`,
          ctx.redact(
            `Title: ${page.title}\nURL: ${page.url}\n\n${page.text}${page.truncated ? "\n(page text cut)" : ""}\n\nOutline:\n${page.outline}`,
          ),
        ),
      ),
    ],
  };
}
export async function browserNavigateTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserNavigateInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const session = ctx.session;
  const desktop = deps.desktop(session.cellId);
  const url = webUrl(input.url);
  if (!desktop) return fail("The computer is not running.");
  if (!url) return fail("Only http and https pages can be opened.");
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "browser_navigate",
    title: `Opening ${url.host}`.slice(0, 200),
  });
  let result: Awaited<ReturnType<typeof desktop.browserNavigate>> | undefined;
  try {
    result = await desktop.browserNavigate(url.href, ctx.signal);
    ctx.check();
  } catch (err) {
    ctx.check();
    if (!(err instanceof DesktopdError) || err.status !== 409) throw err;
    const launcher = deps.launcher(session.cellId);
    if (!launcher) throw new Error("The browser launcher is unavailable");
    ctx.check();
    await launcher.launch({ app: "chromium", args: ["about:blank"] }, ctx.signal);
    ctx.check();
    const deadline = Date.now() + 10000;
    while (!result) {
      ctx.check();
      if (Date.now() >= deadline) throw new Error("The browser did not open in time");
      await deps.sleep(500, ctx.signal);
      ctx.check();
      try {
        result = await desktop.browserNavigate(url.href, ctx.signal);
        ctx.check();
      } catch (again) {
        ctx.check();
        if (!(again instanceof DesktopdError) || again.status !== 409) throw again;
      }
    }
  }
  ctx.check();
  const o = await deps.gateway.observe({
    sessionId: session.id,
    cellId: session.cellId,
    step: ctx.step,
    signal: ctx.signal,
  });
  ctx.check();
  const image = await frame(deps, ctx, o.frameId);
  ctx.check();
  append(ctx, "tool.end", { ok: result.loaded });
  append(ctx, "step.end", { status: result.loaded ? "ok" : "failed" });
  return {
    ok: true,
    content: [
      text(
        untrusted(
          "navigation result",
          ctx.redact(
            `${result.loaded ? "Opened" : "Still loading"}: ${result.title} (${result.url})`,
          ),
        ),
      ),
      image,
    ],
  };
}
