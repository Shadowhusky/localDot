import {
  type BrowserNavigateInput,
  type BrowserNavigateResult,
  type BrowserReadInput,
  type PageElement,
  type ToolResult,
  webUrl,
} from "@localdot/protocol";
import { BrowserClientError } from "../../browser/client.ts";
import { DesktopdError } from "../../desktopd/client.ts";
import { hostOf } from "../safety/purpose.ts";
import { untrusted } from "../untrusted.ts";
import {
  append,
  fail,
  frame,
  screenContext,
  type ToolCallContext,
  type ToolDeps,
  taintScreen,
  text,
} from "./deps.ts";
import { ELEMENTS_HEADER, elementLine, pageElement } from "./elements.ts";
import { sourceLine } from "./research.ts";

function selectedBrowser(ctx: ToolCallContext) {
  screenContext(ctx);
  if (ctx.screen?.selection.screen !== "browser") return undefined;
  const screens = ctx.session.screens;
  if (!screens) throw new Error("The browser is unavailable.");
  return screens.browserAccess(ctx.screen);
}

// Where a page read belongs: the selected screen's cell and, on the web browser, its tab.
export function pageScreen(ctx: ToolCallContext): { cellId: string; tabId?: string } {
  const browser = selectedBrowser(ctx);
  return {
    cellId: ctx.nativeScreen?.cellId ?? ctx.session.cellId,
    ...(browser ? { tabId: browser.tabId } : {}),
  };
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
  const elements = page.elements ?? (desktop ? await desktopElements(deps, ctx, page.url) : []);
  ctx.check();
  ctx.session.tainted = true;
  taintScreen(ctx, hostOf(page.url), page.text);
  ctx.session.pageRefs = {
    cellId: ctx.nativeScreen?.cellId ?? ctx.session.cellId,
    ...(browser ? { tabId: browser.tabId } : {}),
    url: page.url,
    elements: new Map(elements.map((e) => [e.ref, e])),
  };
  // In research mode a page read is a numbered source, unless the budget is reached.
  const source = sourceLine(ctx.session.research, ctx.redact(page.url), ctx.redact(page.title));
  if (source.refused) {
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "blocked" });
    return fail(source.refused);
  }
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  const listed = elements.length
    ? `\n\n${ELEMENTS_HEADER}\n${elements.map(elementLine).join("\n")}`
    : "";
  return {
    ok: true,
    content: [
      text(
        (source.line ?? "") +
          untrusted(
            `web page ${ctx.redact(page.url)}`,
            ctx.redact(
              `Title: ${page.title}\nURL: ${page.url}\n\n${page.text}${page.truncated ? "\n(page text cut)" : ""}\n\nOutline:\n${page.outline}${listed}`,
            ),
          ),
      ),
    ],
  };
}

// The desktop Chromium page's elements, when they belong to the page just read; none from an
// older desktop.
async function desktopElements(
  deps: ToolDeps,
  ctx: ToolCallContext,
  url: string,
): Promise<PageElement[]> {
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop?.elements) return [];
  const found = await desktop
    .elements({ page: true, limit: 150 }, ctx.signal)
    .catch(() => undefined);
  ctx.check();
  if (!found || found.url !== url) return [];
  const scale = ctx.nativeScreen?.scale ?? deps.scaleOf(ctx.session.cellId) ?? 1;
  return found.elements.flatMap((wire) => pageElement(wire, scale) ?? []);
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
  // Another page's nodes may reuse the old ones' numbers.
  session.pageRefs = undefined;
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "browser_navigate",
    title: `Opening ${url.host}`.slice(0, 200),
  });
  let result: BrowserNavigateResult | undefined;
  if (browser) {
    await browser.client.navigate(browser.permit, browser.tabId, url.href, ctx);
    ctx.check();
    // The page opened; one that keeps changing as it settles may not be readable yet.
    const page = await browser.client
      .read(browser.permit, browser.tabId, { maxChars: 500 }, ctx)
      .catch((error: unknown) => {
        ctx.check();
        if (!(error instanceof BrowserClientError)) throw error;
        return undefined;
      });
    ctx.check();
    result = { url: page?.url ?? url.href, title: page?.title ?? "", loaded: true };
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
