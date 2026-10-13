import type { BrowserAction, PageElement, ToolResult } from "@localdot/protocol";
import { authorizePrepared } from "../safety/authorize.ts";
import { actionDigest } from "../safety/risk.ts";
import { append, fail, screenContext, type ToolCallContext, type ToolDeps, text } from "./deps.ts";
import { findSecretField, typeSecret } from "./secret-field.ts";

// A device-pairing code is already known to the CLI that started authorization.
// It still travels through private input, bound to a current field and HTTPS origin.
// Passwords and user-held OTPs remain exclusively on the ask_user path. Browserd
// verifies the actual field metadata again; a model's label is never sufficient.
export async function browserDeviceCodeTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserAction,
  element: PageElement | undefined,
  url: string | undefined,
): Promise<ToolResult> {
  if (ctx.screen?.selection.screen !== "browser" || !deps.gateway.find)
    return fail("Open the CLI verification page in the visible web browser first.");
  if (!element?.secret || !url || !input.ref || input.coordinate || input.submit !== undefined)
    return fail(
      "device_code needs a current protected field ref; coordinates and submit are not accepted. Read the page again and select the first code box.",
    );
  let origin: string;
  try {
    const page = new URL(url);
    if (page.protocol !== "https:" || page.origin !== input.origin) throw new Error("origin");
    origin = page.origin;
  } catch {
    return fail("Use the exact HTTPS origin of the verification page supplied by the CLI.");
  }
  if (!input.text || !/^[a-z0-9]{4,12}$/iu.test(input.text.replace(/[ -]/gu, "")))
    return fail(
      "Supply the device-pairing code from the CLI, with 4–12 letters or digits. Never use this action for a password, authenticator, SMS or email code.",
    );
  const node = Number(input.ref.slice(1));
  const lookup = { node, role: element.role, name: element.name, url };
  const current = await deps.gateway.find(screenContext(ctx), lookup);
  ctx.check();
  if (!current?.secret || current.editable === false || current.url !== url)
    return fail("That code field is no longer on the page as it was read. Read the page again.");
  const scale = ctx.nativeScreen?.scale ?? 1;
  const field = await findSecretField(deps, ctx, [
    current.point.x / scale,
    current.point.y / scale,
  ]);
  ctx.check();
  if (typeof field === "string") return fail(field);
  if (field.found.target?.url !== url || field.found.target?.name !== current.name)
    return fail("The code field changed. Read the page again.");
  const target = { origin, node, field: field.found, screen: field.screen };
  const revalidate = async () => {
    const next = await deps.gateway.find?.(screenContext(ctx), lookup);
    ctx.check();
    return actionDigest(next ?? null) === actionDigest(current);
  };
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", { tool: "browser_act", title: "Enter CLI device code" });
  let ok = false;
  try {
    // Linking a CLI to an account retains the normal account-settings authorization
    // and purpose checks. No blanket exception is made for credential fields.
    const permit = await authorizePrepared(ctx, {
      tool: "browser_act",
      input,
      target,
      facts: { operation: "device_code", target: { ...current, fresh: true } },
      revalidate,
    });
    ctx.check();
    if (!permit || !(await revalidate()) || !permit.consume(input, target))
      return fail("Device pairing was not authorized or the page changed. Do not retry unchanged.");
    const result = await typeSecret(deps, ctx, field, input.text, undefined, {
      purpose: "device_code",
      node,
    });
    ctx.check();
    ok = result.filled;
    if (!ok)
      return fail("The code field changed before entry. Read the page again; no code was entered.");
    return {
      ok: true,
      content: [
        text(
          "Device code entered privately. Read the resulting page, complete the requested app authorization, then verify CLI authentication before proceeding. Code entry alone does not mean sign-in succeeded.",
        ),
      ],
    };
  } finally {
    append(ctx, "tool.end", { ok });
    append(ctx, "step.end", { status: ok ? "ok" : "blocked" });
  }
}
