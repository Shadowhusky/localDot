import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { type BrowserUploadInput, type ToolResult, UploadApproval } from "@localdot/protocol";
import {
  BrowserUploadFiles,
  BrowserUploadOffer,
  BrowserUploadReceipt,
} from "../../../../../packages/protocol/src/browser-uploads.ts";
import { DesktopUploadFile } from "../../../../../packages/protocol/src/desktop-uploads.ts";
import { UPLOAD_BYTES } from "../../../../../packages/protocol/src/quarantine.ts";
import type { BrowserScope } from "../../browser/client.ts";
import { authorizePrepared, freezeExecutionInput } from "../safety/authorize.ts";
import { actionDigest } from "../safety/risk.ts";
import { untrusted } from "../untrusted.ts";
import { append, fail, screenContext, type ToolCallContext, type ToolDeps, text } from "./deps.ts";

type DesktopSource = NonNullable<ReturnType<NonNullable<ToolDeps["uploads"]>["desktop"]>>;

// Sequential, bounded streams preserve file boundaries in the agreed byte counts.
// Destroy aborts the active HTTP read immediately, then waits for its physical drain.
export function desktopUploadStream(
  desktop: DesktopSource,
  files: readonly DesktopUploadFile[],
  scope: BrowserScope,
): Readable {
  const abort = new AbortController();
  const signal = AbortSignal.any([scope.signal, abort.signal]);
  let active: Readable | undefined;
  const check = () => {
    signal.throwIfAborted();
    scope.check();
  };
  const iterator = (async function* () {
    for (const file of files) {
      check();
      const source = desktop.readUpload(file, signal);
      active = source;
      const closed = finished(source, { cleanup: true }).catch(() => {});
      try {
        for await (const chunk of source) {
          check();
          if (!(chunk instanceof Uint8Array)) throw new Error("Invalid upload source.");
          yield chunk;
        }
        check();
      } finally {
        source.destroy();
        await closed;
        active = undefined;
      }
    }
    check();
  })();
  const output = new Readable({
    highWaterMark: 65536,
    read() {
      void iterator.next().then(
        (next) => {
          if (!output.destroyed) output.push(next.done ? null : next.value);
        },
        (error: unknown) =>
          output.destroy(error instanceof Error ? error : new Error("Upload source failed.")),
      );
    },
    destroy(error, done) {
      abort.abort();
      active?.destroy();
      void iterator.return(undefined).then(
        () => done(error),
        (failure: unknown) =>
          done(error ?? (failure instanceof Error ? failure : new Error("Upload cleanup failed."))),
      );
    },
  });
  return addAbortSignal(signal, output);
}

export async function browserUploadTool(
  deps: ToolDeps,
  ctx: ToolCallContext,
  input: BrowserUploadInput,
): Promise<ToolResult> {
  screenContext(ctx);
  if (ctx.screen?.selection.screen !== "browser" || !ctx.session.screens)
    return fail("Switch to the web browser and open the page's file picker before uploading.");
  const browser = ctx.session.screens.browserAccess(ctx.screen);
  const desktop = deps.uploads?.desktop(ctx.session.cellId);
  if (!desktop || !deps.uploads || !browser.client.uploadChooser || !browser.client.upload)
    return fail("File uploads are unavailable for this computer.");
  const inspectChooser = browser.client.uploadChooser.bind(browser.client);
  const send = browser.client.upload.bind(browser.client);
  const rawOffer = await inspectChooser(browser.permit, browser.tabId, ctx);
  ctx.check();
  if (!rawOffer) return fail("Open a file picker on the current browser page first.");
  const offer = freezeExecutionInput(BrowserUploadOffer.parse(rawOffer));
  if (offer.mode === "single" && input.files.length !== 1)
    return fail("This file picker accepts one file.");
  const files: DesktopUploadFile[] = [];
  let total = 0;
  for (const path of input.files) {
    ctx.check();
    const file = DesktopUploadFile.parse(await desktop.inspectUpload(path, ctx.signal));
    ctx.check();
    total += file.bytes;
    if (total > UPLOAD_BYTES) return fail("Uploads are limited to 100 MiB in total.");
    if (files.some((previous) => previous.path === file.path))
      return fail("Select each desktop file only once.");
    files.push(file);
  }
  const approved = freezeExecutionInput({ files });
  const target = freezeExecutionInput({
    permit: browser.permit,
    tabId: browser.tabId,
    chooser: offer,
    screenRevision: ctx.screen.selection.revision,
  });
  const destination = { origin: offer.origin, embedded: offer.embedded };
  const preview = UploadApproval.parse({
    destination,
    files: approved.files.map(({ identity: _identity, ...file }) => file),
  });
  const revalidate = async (): Promise<boolean> => {
    ctx.check();
    const current = await inspectChooser(browser.permit, browser.tabId, ctx);
    ctx.check();
    if (!current || actionDigest(BrowserUploadOffer.parse(current)) !== actionDigest(offer))
      return false;
    for (const file of approved.files) {
      const next = DesktopUploadFile.parse(await desktop.inspectUpload(file.path, ctx.signal));
      ctx.check();
      if (actionDigest(next) !== actionDigest(file)) return false;
    }
    return true;
  };
  append(ctx, "step.start", { kind: "browser" });
  append(ctx, "tool.start", {
    tool: "browser_upload",
    title: `Upload ${files.length} file${files.length === 1 ? "" : "s"}`,
  });
  const permit = await authorizePrepared(ctx, {
    tool: "browser_upload",
    input: approved,
    target,
    facts: { operation: "files_upload" },
    upload: preview,
    revalidate,
  });
  ctx.check();
  if (!permit || !(await revalidate())) {
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "blocked" });
    return fail(
      "This upload was not authorized or its files or receiving page changed. Do not retry automatically.",
    );
  }
  const transfer = deps.uploads.transfers.acquire(ctx.session.cellId, [ctx.signal], () =>
    ctx.check(),
  );
  let source: Readable | undefined;
  try {
    transfer.check();
    if (!permit.consume(approved, target)) return fail("This upload approval is no longer valid.");
    const payload = BrowserUploadFiles.parse(
      approved.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    );
    source = desktopUploadStream(desktop, approved.files, transfer);
    const receipt = BrowserUploadReceipt.parse(
      await send(
        {
          permit: browser.permit,
          tabId: browser.tabId,
          chooserId: offer.id,
          destination,
          files: payload,
        },
        source,
        transfer,
      ),
    );
    transfer.check();
    if (
      receipt.chooserId !== offer.id ||
      actionDigest(receipt.destination) !== actionDigest(destination) ||
      actionDigest(receipt.files) !== actionDigest(payload)
    )
      throw new Error("Upload receipt changed.");
    append(ctx, "tool.end", { ok: true });
    append(ctx, "step.end", { status: "ok" });
    return {
      ok: true,
      content: [
        text(
          untrusted(
            "upload result",
            ctx.redact(
              `Assigned ${files.length} file${files.length === 1 ? "" : "s"} to the file picker on ${offer.origin}. The page may still require a Submit action.`,
            ),
          ),
        ),
      ],
    };
  } catch {
    ctx.check();
    append(ctx, "tool.end", { ok: false });
    append(ctx, "step.end", { status: "failed" });
    return fail(
      "The upload has no verified completion receipt. Do not retry automatically; inspect the page or ask the user.",
    );
  } finally {
    if (source) {
      const closed = finished(source, { cleanup: true }).catch(() => {});
      source.destroy();
      await closed;
    }
    transfer.release();
  }
}
