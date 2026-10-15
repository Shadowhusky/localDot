import { clipPatch, type ResearchInput, type ToolResult, webUrl } from "@localdot/protocol";
import { isSearchPage, publicUrl, type ResearchLog, siteOf } from "../research.ts";
import { buildReport, maskKeys, reportName } from "../research-report.ts";
import type { AgentSession } from "../session.ts";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

const PDF_TEXT_BYTES = 200_000;
const PDF_PAGES = 40;
// The model reads at most this much of a PDF's text at once, as browser_read reads a page.
const PDF_MODEL_CHARS = 30_000;
const OFF = "Research mode is off for this task. Read pages with browser_read instead.";

// The gathering tools: once the budget is reached they take nothing new, and say why.
const GATHERING = new Set([
  "browser_read",
  "browser_navigate",
  "web_search",
  "web_fetch",
  "shell",
  "research",
]);

// Single quotes for the shell, closed and reopened around each quote in the text.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Downloads the PDF in the computer, through its usual network rules, and prints its title, page
// count and text as whole UTF-8 characters, within a fixed size.
export function pdfCommand(url: string): string {
  return [
    'mkdir -p "$HOME/.cache" && d=$(mktemp -d "$HOME/.cache/localdot-pdf.XXXXXX") && cd "$d" || exit 1',
    `if curl -fsSL --proto '=http,https' --max-time 60 --max-filesize 52428800 -o in.pdf ${shellQuote(url)} 2>err; then`,
    '  if [ "$(head -c 5 in.pdf)" = "%PDF-" ]; then',
    "    pdfinfo -enc UTF-8 in.pdf 2>/dev/null | sed -n 's/^Title:[[:space:]]*/@title /p;s/^Pages:[[:space:]]*/@pages /p' | head -c 600 | iconv -c -f UTF-8 -t UTF-8",
    "    echo @text",
    `    timeout 60 pdftotext -layout -l ${PDF_PAGES} -enc UTF-8 in.pdf - 2>/dev/null | head -c ${PDF_TEXT_BYTES} | iconv -c -f UTF-8 -t UTF-8`,
    '  else echo "@error The link is not a PDF."; fi',
    'else echo "@error $(head -c 300 err | iconv -c -f UTF-8 -t UTF-8)"; fi',
    'cd / && rm -rf "$d"',
  ].join("\n");
}

// Makes <name>.pdf next to <name>.md in ~/Reports: pandoc to a Word file, then LibreOffice to PDF,
// in a private folder that is removed afterwards. Only a checked file name reaches the shell.
export function reportPdfCommand(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) throw new Error("invalid report name");
  return [
    '(cd "$HOME/Reports" && mkdir -p "$HOME/.cache" && d=$(mktemp -d "$HOME/.cache/localdot-report.XXXXXX") || exit 1',
    `timeout 60 pandoc -f markdown -t docx -o "$d/r.docx" '${name}.md' && timeout -k 5 90 nice -n 10 soffice -env:UserInstallation=file://$d/profile --headless --norestore --nolockcheck --convert-to pdf --outdir "$d" "$d/r.docx"`,
    `if [ -s "$d/r.pdf" ]; then mv -f "$d/r.pdf" '${name}.pdf'; s=$?; else s=1; fi`,
    'rm -rf "$d"; exit $s) >/dev/null 2>&1',
  ].join("\n");
}

// Before a call runs: what a research task refuses once its budget is reached. A source already in
// the list can still be opened, to check what the report says about it.
export function researchRefusal(
  session: Pick<AgentSession, "research">,
  name: string,
  input: unknown,
): string | undefined {
  const research = session.research;
  if (!research?.stopped) return undefined;
  if (name === "web_search") return research.stopNote();
  const fields = input as { url?: unknown; op?: unknown };
  const url = typeof fields.url === "string" ? fields.url : undefined;
  const opens =
    name === "browser_navigate" ||
    name === "web_fetch" ||
    (name === "research" && (fields.op === "pdf" || fields.op === "source"));
  if (!opens || !url || research.find(url)) return undefined;
  return research.stopNote();
}

// After a gathering call: the budget's word to dot once it is reached. Writing the report is what
// that word asks for, so it is never told again.
export function withResearchNote(
  session: Pick<AgentSession, "research">,
  name: string,
  input: unknown,
  result: ToolResult,
): ToolResult {
  const research = session.research;
  const writing = name === "research" && (input as { op?: unknown }).op === "report";
  if (!research || !GATHERING.has(name) || writing || result.final || !research.stopped)
    return result;
  return { ...result, content: [...result.content, text(research.stopNote())] };
}

// The number a page dot read has in the source list, as dot hears it with the page.
export function sourceLine(
  research: ResearchLog | undefined,
  url: string,
  title: string,
): { line?: string; refused?: string; note?: string } {
  if (!research || isSearchPage(url) || !publicUrl(url)) return {};
  const known = research.add(url, title);
  if (!known) return { refused: research.stopNote(), note: research.stopShown() };
  return { line: `Source [${known.source.n}] (${research.status()}).\n` };
}

export async function researchTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: ResearchInput,
): Promise<ToolResult> {
  ctx.check();
  const research = ctx.session.research;
  if (!research) return fail(OFF);
  switch (input.op) {
    case "source":
      return sourceOp(ctx, research, input);
    case "pdf":
      return pdfOp(deps, ctx, research, input);
    case "report":
      return reportOp(deps, ctx, research, input);
  }
}

function sourceOp(ctx: ToolCallContext, research: ResearchLog, input: ResearchInput): ToolResult {
  if (!input.url) return fail("source needs the url of the page or file.");
  const url = ctx.redact(input.url);
  const added = research.add(url, ctx.redact(input.title ?? ""));
  if (!added)
    return fail(
      publicUrl(url) ? research.stopNote() : "A source needs a public http or https url.",
    );
  const quoted = research.quote(
    added.source,
    (input.passages ?? []).map((passage) => maskKeys(ctx.redact(passage))),
  );
  const { n, passages } = added.source;
  return {
    ok: true,
    content: [
      text(
        `Source [${n}]: ${added.added ? "added" : "already listed"}${quoted ? `, ${quoted} passage${quoted === 1 ? "" : "s"} recorded (${passages.length} in all)` : ""}. Cite it as [${n}]. ${research.status()}.`,
      ),
    ],
  };
}

async function pdfOp(
  deps: ToolDeps,
  ctx: ToolCallContext,
  research: ResearchLog,
  input: ResearchInput,
): Promise<ToolResult> {
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  const url = input.url ? webUrl(input.url) : undefined;
  if (!url) return fail("pdf needs the http or https url of the PDF.");
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop) return fail("The computer is not running.");
  const host = siteOf(url.href);
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "research",
    title: `Reading a PDF from ${host}`.slice(0, 200),
  });
  let output = "";
  const done = await desktop.shell(
    { command: pdfCommand(url.href), timeoutMs: 150_000, maxOutputBytes: 256 * 1024 },
    (chunk) => {
      ctx.check();
      output += chunk.chunk;
    },
    ctx.signal,
  );
  ctx.check();
  ctx.session.tainted = true;
  const marker = output.indexOf("@text\n");
  if (done.timedOut || marker === -1) {
    const why = /@error (.*)/.exec(output)?.[1]?.trim() || "The PDF could not be read.";
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "failed", note: ctx.redact(why).slice(0, 500) });
    return fail(ctx.redact(why));
  }
  const head = output.slice(0, marker);
  const body = output.slice(marker + 6);
  const title = /^@title (.+)$/m.exec(head)?.[1]?.trim() ?? "";
  const pages = /^@pages (\d+)$/m.exec(head)?.[1];
  const listed = sourceLine(research, url.href, ctx.redact(title) || `PDF from ${host}`);
  if (listed.refused) {
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "blocked", note: listed.note });
    return fail(listed.refused);
  }
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  const cut = body.length > PDF_MODEL_CHARS;
  const shown = `Title: ${title || "(none)"}\nURL: ${url.href}${pages ? `\nPages: ${pages}${Number(pages) > PDF_PAGES ? ` (text of the first ${PDF_PAGES})` : ""}` : ""}\n\n${cut ? body.slice(0, PDF_MODEL_CHARS) : body}${cut ? "\n(text cut)" : ""}`;
  return {
    ok: true,
    content: [
      text(`${listed.line ?? ""}${untrusted(`PDF ${ctx.redact(url.href)}`, ctx.redact(shown))}`),
    ],
  };
}

async function reportOp(
  deps: ToolDeps,
  ctx: ToolCallContext,
  research: ResearchLog,
  input: ResearchInput,
): Promise<ToolResult> {
  if (!ctx.permit?.consume(input, null))
    return fail("Execution approval is unavailable or already used. Do not retry automatically.");
  if (!input.title || !input.summary || !input.body)
    return fail("report needs a title, a summary and a body.");
  const built = buildReport(
    {
      title: input.title,
      summary: input.summary,
      body: input.body,
      sources: research.sources,
      date: new Date(),
    },
    ctx.redact,
  );
  if (research.sources.length && !built.cited.length)
    return fail(
      "The report cites no sources. Put the numbers sources were given, such as [2], after each claim they support, then write the report again.",
    );
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop) return fail("The computer is not running.");
  const name = reportName(input.file ?? input.title);
  append(ctx, "step.start", { kind: "file" });
  append(ctx, "tool.start", { tool: "research", title: "Writing the report" });
  const written = await desktop.writeFile(`Reports/${name}.md`, built.markdown, ctx.signal);
  ctx.check();
  append(ctx, "file.change", {
    path: written.path,
    op: written.op,
    patch: clipPatch(ctx.redact(written.patch)),
  });
  research.cite(built.cited);
  let pdf: string | undefined;
  try {
    const made = await desktop.shell(
      { command: reportPdfCommand(name), timeoutMs: 170_000, maxOutputBytes: 4096 },
      () => {},
      ctx.signal,
    );
    ctx.check();
    if (made.exitCode === 0 && !made.timedOut) pdf = written.path.replace(/\.md$/, ".pdf");
  } catch {
    ctx.check();
  }
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  const notes = [
    built.unknown.length
      ? `No source has the number${built.unknown.length === 1 ? "" : "s"} ${built.unknown.map((n) => `[${n}]`).join(", ")}, so ${built.unknown.length === 1 ? "that citation was" : "those citations were"} left out.`
      : "",
    research.sources.length > built.cited.length
      ? `${research.sources.length - built.cited.length} source(s) you read are not cited; they are listed under "Also read".`
      : "",
    pdf ? "" : "The PDF could not be made: hand over the Markdown file alone.",
  ].filter(Boolean);
  return {
    ok: true,
    content: [
      text(
        ctx.redact(
          `Report written: ${written.path}${pdf ? ` and ${pdf}` : ""}. It cites ${built.cited.length} of ${research.sources.length} sources, renumbered in the order the text cites them. ${notes.join(" ")} Check it, then call done with ${pdf ? "both files" : "the file"} and a short answer.`.replace(
            /\s+/g,
            " ",
          ),
        ),
      ),
    ],
  };
}
