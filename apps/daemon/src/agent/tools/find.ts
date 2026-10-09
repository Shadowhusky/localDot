import { clipText, type FindInput, type ToolResult } from "@localdot/protocol";
import { untrusted } from "../untrusted.ts";
import { append, fail, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { corners } from "./elements.ts";

const LIMIT = 20;

// find: the desktop's controls whose accessible names contain the text, in every window top
// first, with where to click them. Reading only; a click on one is an ordinary computer action.
export async function findTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: FindInput,
): Promise<ToolResult> {
  ctx.check();
  if (!ctx.permit?.consume(input, null)) return fail("Looking at the screen is not authorized.");
  if (ctx.screen?.selection.screen === "browser")
    return fail(
      "find looks through the desktop's apps. On the web browser screen, browser_read lists the page's controls with refs for browser_act.",
    );
  const desktop = deps.desktop(ctx.session.cellId);
  if (!desktop?.elements)
    return fail("Finding controls by name is not available on this computer.");
  append(ctx, "step.start", { kind: "gui" });
  append(ctx, "tool.start", {
    tool: "find",
    title: clipText(`Looking for ${JSON.stringify(input.text)}`, 200),
  });
  const found = await desktop.elements(
    { text: input.text, ...(input.role ? { role: input.role } : {}), limit: LIMIT },
    ctx.signal,
  );
  ctx.check();
  ctx.session.tainted = true;
  append(ctx, "tool.end", { ok: true });
  append(ctx, "step.end", { status: "ok" });
  const scale = deps.scaleOf(ctx.session.cellId) ?? 1;
  const lines = found.elements.flatMap((e) => {
    if (!e.bbox) return [];
    const box = {
      x: e.bbox.x / scale,
      y: e.bbox.y / scale,
      w: e.bbox.w / scale,
      h: e.bbox.h / scale,
    };
    const centre = `(${Math.round(box.x + box.w / 2)}, ${Math.round(box.y + box.h / 2)})`;
    const where = e.window ? ` in ${JSON.stringify(clipText(e.window, 80))}` : "";
    return [
      `- ${clipText(e.role ?? "element", 40)} ${JSON.stringify(clipText(e.name ?? "", 100))}${where} at ${centre} ${corners(box)}`,
    ];
  });
  if (!lines.length)
    return {
      ok: true,
      content: [
        text(
          `No control on the desktop has a name containing ${JSON.stringify(input.text)}${input.role ? ` with the role ${JSON.stringify(input.role)}` : ""}. Its window may be closed or covered, or the app may not name it; look at a screenshot instead.`,
        ),
      ],
    };
  return {
    ok: true,
    content: [
      text(
        untrusted(
          "the desktop's accessibility tree",
          ctx.redact(
            `Controls whose names contain ${JSON.stringify(input.text)}, top window first; "at" is the centre to click, the box is [left, top, right, bottom] in the computer tool's coordinates:\n${lines.join("\n")}${found.truncated ? "\n(more matched; narrow the text or give a role)" : ""}`,
          ),
        ),
      ),
    ],
  };
}
