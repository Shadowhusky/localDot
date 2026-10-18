import {
  clipText,
  type ToolResult,
  WEB_FETCH_DEFAULT_CHARS,
  type WebFetchInput,
  type WebSearchInput,
  type WebSearchKind,
  webUrl,
} from "@localdot/protocol";
import { untrusted } from "../untrusted.ts";
import { WebError } from "../web/cell.ts";
import type { SearchHit } from "../web/engines.ts";
import { webFetch } from "../web/fetch.ts";
import { webSearch } from "../web/search.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { sourceLine } from "./research.ts";
import { saveStepImage } from "./step-image.ts";
import { opensInWebBrowser } from "./web-page.ts";

const UNAVAILABLE = "The web can't be reached from here right now. Use the web browser instead.";
const PICTURE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg)$/i;

const RESULTS: Record<WebSearchKind, string> = {
  web: "web search results",
  images: "image search results",
  news: "news search results",
};
const SEARCHED: Record<WebSearchKind, string> = {
  web: "Searched the web for",
  images: "Looked at images of",
  news: "Searched the news for",
};

function listed(kind: WebSearchKind, hits: readonly SearchHit[], shown: Set<number>): string {
  return hits
    .map((hit, i) => {
      const lines = [`${i + 1}. ${hit.title}`];
      if (kind === "images") {
        lines.push(`   Page: ${hit.url}`);
        if (hit.image) lines.push(`   Image: ${hit.image}`);
        if (shown.has(i + 1)) lines.push("   (picture shown below)");
      } else {
        lines.push(`   ${hit.url}`);
        const about = [hit.source ?? hit.site, hit.age].filter(Boolean).join(", ");
        lines.push(`   ${about}${hit.snippet ? ` · ${hit.snippet}` : ""}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

// Searches without the screen, through keyd like the web browser's own traffic; the results are
// untrusted, and a results page is never a research source.
export async function webSearchTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: WebSearchInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  if (!deps.web) return fail(UNAVAILABLE);
  const kind = input.kind ?? "web";
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "web_search",
    title: `${SEARCHED[kind]} “${clipText(input.query, 80)}”`,
  });
  const outcome = await webSearch(deps.web, input, ctx.signal);
  ctx.check();
  ctx.session.tainted = true;
  if (!outcome.hits.length) {
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "failed", note: "No search engine gave results." });
    return fail(
      ctx.redact(
        `No results. ${outcome.problems.join("; ")}. Try other words, or search in the web browser with browser_navigate.`,
      ),
    );
  }
  for (const picture of outcome.pictures) {
    const alt = outcome.hits[picture.n - 1]?.title || `Image result ${picture.n}`;
    const image = await saveStepImage(deps, ctx, picture.data, alt);
    append(ctx, "tool.output", {
      stream: "stdout",
      chunk: `${picture.n}. ${ctx.redact(alt)}${image ? "" : " — Image preview could not be saved."}\n`,
      ...(image ? { image } : {}),
    });
  }
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  const shown = new Set(outcome.pictures.map((picture) => picture.n));
  const pictures = outcome.pictures.length
    ? `\n\nThe pictures of results ${[...shown].join(", ")} follow, in that order.`
    : kind === "images"
      ? "\n\nNo picture could be fetched: look at one with web_fetch and its image link."
      : "";
  return {
    ok: true,
    content: [
      text(
        untrusted(
          `${RESULTS[kind]} for ${ctx.redact(input.query)}`,
          ctx.redact(listed(kind, outcome.hits, shown)),
        ) + pictures,
      ),
      ...outcome.pictures.map((picture) => ({
        type: "web_image" as const,
        url: ctx.redact(picture.url),
        mediaType: "image/jpeg" as const,
        data: picture.data.toString("base64"),
      })),
    ],
  };
}

// The pages that failed in each task. One that did not answer, or found no connection, gets one more
// try; any other failure is the same the next time, so a repeat is answered without reading again.
const failed = new WeakMap<object, Map<string, { times: number; said: string }>>();
const PASSING = /did not answer in time|could not be reached|no connection is free/;
// A read's step shows the start of the page dot was given.
const SHOWN_CHARS = 4000;

// Reads a public page as Markdown, or a picture, without the screen. It carries no sign-ins, so
// what it reads is public; in research mode a page read is a numbered source.
export async function webFetchTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: WebFetchInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const url = webUrl(input.url);
  if (!url || !opensInWebBrowser(url))
    return fail(
      "Only public http and https pages can be read this way. Open local addresses with browser_navigate.",
    );
  if (!deps.web) return fail(UNAVAILABLE);
  const page = url.href.replace(/#.*$/, "");
  const tried = failed.get(ctx.session)?.get(page);
  if (tried && (tried.times > 1 || !PASSING.test(tried.said)))
    return fail(
      `This page already failed in this task: ${tried.said} Use another source, or open it with browser_navigate.`,
    );
  const site = url.hostname.replace(/^www\./, "");
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "web_fetch",
    title: PICTURE.test(url.pathname) ? `Looked at a picture from ${site}` : `Read ${site}`,
  });
  append(ctx, "tool.output", { stream: "stdout", chunk: `${ctx.redact(page)}\n` });
  let got: Awaited<ReturnType<typeof webFetch>>;
  try {
    got = await webFetch(deps.web, url, input.max_chars ?? WEB_FETCH_DEFAULT_CHARS, ctx.signal);
  } catch (error) {
    ctx.check();
    if (!(error instanceof WebError)) throw error;
    // The user sees the first sentence; the rest is advice for dot.
    const said = /^.*?[.:](?=\s|$)/.exec(error.message)?.[0].replace(/:$/, ".") ?? error.message;
    const pages = failed.get(ctx.session) ?? new Map();
    failed.set(ctx.session, pages.set(page, { times: (tried?.times ?? 0) + 1, said }));
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "failed", note: clipText(said, 500) });
    return fail(ctx.redact(error.message));
  }
  ctx.check();
  ctx.session.tainted = true;
  if (got.kind === "image") {
    const image = await saveStepImage(deps, ctx, got.data, got.url);
    append(ctx, "tool.output", {
      stream: "stdout",
      chunk: image ? "" : "Image preview could not be saved.",
      ...(image ? { image } : {}),
    });
    append(ctx, "tool.end", { ok: true });
    append(ctx, "step.end", { status: "ok" });
    return {
      ok: true,
      content: [
        text(
          untrusted(
            `picture ${ctx.redact(got.url)}`,
            ctx.redact(`A picture from ${got.url}, shown at ${got.width}×${got.height}.`),
          ),
        ),
        {
          type: "web_image",
          url: ctx.redact(got.url),
          mediaType: "image/jpeg",
          data: got.data.toString("base64"),
        },
      ],
    };
  }
  const source = sourceLine(
    ctx.session.research,
    ctx.redact(got.url),
    ctx.redact(got.title || site),
  );
  if (source.refused) {
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "blocked", note: source.note });
    return fail(source.refused);
  }
  const read = ctx.redact(`${got.title ? `${got.title}\n` : ""}\n${got.text}`);
  append(ctx, "tool.output", {
    stream: "stdout",
    chunk: read.length > SHOWN_CHARS ? `${read.slice(0, SHOWN_CHARS)}\n…` : read,
  });
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  return {
    ok: true,
    content: [
      text(
        (source.line ?? "") +
          untrusted(
            `web page ${ctx.redact(got.url)}`,
            ctx.redact(`Title: ${got.title}\nURL: ${got.url}\n\n${got.text}`),
          ),
      ),
    ],
  };
}
