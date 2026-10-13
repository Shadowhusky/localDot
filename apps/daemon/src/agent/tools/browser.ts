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

// A successful control/read operation is not proof that an application is open. Classify
// browser-owned URLs, never page prose (which is untrusted and can describe any state).
function pageStatus(url: string): "blank" | "error" | "page" {
  if (/^about:blank(?:[?#]|$)/i.test(url) || /^chrome(?:-search)?:\/\/newtab\//i.test(url))
    return "blank";
  if (/^chrome-error:\/\//i.test(url)) return "error";
  return "page";
}

function pageStatusNote(url: string): string {
  switch (pageStatus(url)) {
    case "blank":
      return "Browser status: reachable; no site URL is open in this tab. This is a blank starting page, not a browser failure. Use browser_navigate with the intended app or preview URL; it selects the visible browser for that address. Switching screens or taking a screenshot does not open or test the app.\n\n";
    case "error":
      return "Browser status: reachable; Chromium is displaying an error page. The target app has not been verified. Inspect the error and the requested address before retrying; do not treat this as a completed interactive test.\n\n";
    case "page":
      return "";
  }
}

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
        pageStatusNote(page.url) +
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
  let download = false;
  let verificationNote = "";
  if (browser) {
    const navigation = await browser.client.navigate(browser.permit, browser.tabId, url.href, ctx);
    download = navigation.download === true;
    ctx.check();
    if (download) {
      // A download receipt is not a document navigation. Reading the previous page cannot
      // verify that receipt and must not turn it into a false navigation failure.
      result = { url: url.href, title: "", loaded: true };
    } else {
      const page = await browser.client
        .read(browser.permit, browser.tabId, { maxChars: 500 }, ctx)
        .catch((error: unknown) => {
          ctx.check();
          // A changing document can reject a read while navigation is settling. Connection,
          // ownership and protected-input failures must retain their real failure reason.
          if (!(error instanceof BrowserClientError) || error.code !== "refused") throw error;
          return undefined;
        });
      ctx.check();
      result = {
        url: page?.url ?? url.href,
        title: page?.title ?? "",
        loaded: !!page && pageStatus(page.url) === "page",
      };
      if (!page)
        verificationNote =
          "Navigation was acknowledged, but the page is still changing and could not be read. Read or observe the current page before deciding whether it loaded; do not repeat navigation just to check.";
    }
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
  if (!download && pageStatus(result.url) !== "page") result.loaded = false;
  if (!download && !result.loaded && !verificationNote)
    verificationNote =
      pageStatusNote(result.url) ||
      "Navigation has not finished loading. Inspect the current page before deciding whether the app is ready; do not repeat navigation just to check.";
  let image: Awaited<ReturnType<typeof frame>> | undefined;
  try {
    const o = await deps.gateway.observe(screenContext(ctx));
    ctx.check();
    image = await frame(deps, ctx, o.frameId);
    ctx.check();
  } catch (error) {
    ctx.check();
    if (!download) throw error;
    // The download already has a receipt. An unavailable/protected screenshot of the
    // previous page must not erase it and invite another navigation/download.
    verificationNote =
      "The download was acknowledged, but a fresh screenshot is unavailable. Check Activity > Downloads for its status; do not repeat navigation to start another copy.";
  }
  append(ctx, "tool.end", { ok: result.loaded });
  append(ctx, "step.end", { status: result.loaded ? "ok" : "failed" });
  return {
    ok: result.loaded,
    ...(!result.loaded
      ? {
          recovery: {
            kind: "stale" as const,
            surface: "browser" as const,
            retry: "after_observation" as const,
          },
        }
      : {}),
    ...(download
      ? {
          recovery: {
            kind: "download_pending" as const,
            surface: "browser" as const,
            retry: "never" as const,
          },
        }
      : {}),
    content: [
      ...(verificationNote ? [text(verificationNote.trim())] : []),
      text(
        untrusted(
          "navigation result",
          ctx.redact(
            download
              ? `Download started from ${url.href}. The current page remains open. Downloads wait in Activity > Downloads for the user to Review before they reach the computer.`
              : `${result.loaded ? "Opened" : "Page not verified"}: ${result.title} (${result.url})`,
          ),
        ),
      ),
      ...(image ? [image] : []),
    ],
  };
}
