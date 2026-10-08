import {
  type BrowserNavigateInput,
  type BrowserNavigateResult,
  type BrowserReadInput,
  type ToolResult,
  webUrl,
} from "@localdot/protocol";
import { DesktopdError } from "../../desktopd/client.ts";
import { untrusted } from "../untrusted.ts";
import {
  append,
  fail,
  frame,
  screenContext,
  type ToolCallContext,
  type ToolDeps,
  text,
} from "./deps.ts";

function selectedBrowser(ctx: ToolCallContext) {
  screenContext(ctx);
  if (ctx.screen?.selection.screen !== "browser") return undefined;
  const screens = ctx.session.screens;
  if (!screens) throw new Error("The browser is unavailable.");
  return screens.browserAccess(ctx.screen);
}
export async function browserReadTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserReadInput,
): Promise<ToolResult> {
  ctx.check();
  const browser = selectedBrowser(ctx);
  if (!ctx.permit?.consume(input, null)) return fail("Reading is not authorized.");
  const desktop = browser ? undefined : deps.desktop(ctx.session.cellId);
  const load = browser
    ? () =>
        browser.client.read(
          browser.permit,
          browser.tabId,
          { maxChars: input.max_chars ?? 20000 },
          ctx,
        )
    : desktop
      ? () => desktop.browserRead(input.max_chars ?? 20000, ctx.signal)
      : undefined;
  if (!load) return fail("The computer is not running.");
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", { tool: "browser_read", title: "Reading page" });
  const page = await load();
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
  const browser = selectedBrowser(ctx);
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const session = ctx.session;
  const desktop = browser ? undefined : deps.desktop(session.cellId);
  const url = webUrl(input.url);
  if (!browser && !desktop) return fail("The computer is not running.");
  if (!url) return fail("Only http and https pages can be opened.");
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "browser_navigate",
    title: `Opening ${url.host}`.slice(0, 200),
  });
  let result: BrowserNavigateResult | undefined;
  if (browser) {
    await browser.client.navigate(browser.permit, browser.tabId, url.href, ctx);
    ctx.check();
    const page = await browser.client.read(browser.permit, browser.tabId, { maxChars: 500 }, ctx);
    ctx.check();
    result = { url: page.url, title: page.title, loaded: true };
  } else if (desktop) {
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
  }
  ctx.check();
  if (!result) throw new Error("The browser did not open in time");
  const o = await deps.gateway.observe(screenContext(ctx));
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
