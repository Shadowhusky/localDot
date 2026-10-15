import { randomBytes } from "node:crypto";
import { fileExtension, fileKind, PREVIEW_LIMITS, VIEWER_LIMITS } from "@localdot/protocol";
import type { DesktopdTools } from "../desktopd/tools-client.ts";
import type { Converted, Converter } from "./previews.ts";

export interface ComputerAccess {
  tools: Pick<DesktopdTools, "putFile" | "shell" | "fetchFile">;
  signal: AbortSignal;
  check(): void;
  release(): void;
}
export const CONVERT_TIMEOUT_S = 45;
// Every page of a long deck or document takes longer than its first.
export const PAGES_TIMEOUT_S = 90;
const RAW_PNG_MAX = 16 * 1024 * 1024;
// In the 1024-byte blocks bash counts (512 in POSIX mode, still past the largest PDF served).
const FILE_BLOCKS = 131_072;
// The first page as a picture, or every page as a PDF.
export type Conversion = "picture" | "pages";
class TooLarge extends Error {}

// The fixed command for one conversion. Only a random hex folder and an allowlisted extension
// reach the shell; the file itself is always called in.<ext>.
export function conversionCommand(dir: string, ext: string, to: Conversion): string {
  if (
    !/^\.cache\/localdot-preview\/[0-9a-f]{24}$/.test(dir) ||
    !/^[a-z]{2,5}$/.test(ext) ||
    (to === "pages" && ext === "pdf")
  )
    throw new Error("invalid conversion");
  const work = `"$HOME/${dir}"`;
  if (ext === "pdf")
    return `cd ${work} && timeout ${CONVERT_TIMEOUT_S} pdftoppm -png -r 96 -f 1 -l 1 -scale-to ${PREVIEW_LIMITS.imagePx} -singlefile in.pdf in`;
  const office = `soffice -env:UserInstallation=file://$HOME/${dir}/profile --headless --norestore --nolockcheck`;
  // Pages are made at a lower priority, so a long deck never slows what dot is doing.
  return to === "picture"
    ? `cd ${work} && timeout ${CONVERT_TIMEOUT_S} ${office} --convert-to png --outdir . in.${ext}`
    : `cd ${work} && ulimit -f ${FILE_BLOCKS} && timeout -k 5 ${PAGES_TIMEOUT_S} nice -n 10 ${office} --convert-to pdf --outdir . in.${ext}`;
}

// Office documents and PDFs are rendered inside dot's computer, never on the Mac. The command is
// the daemon's own, admitted like a user upload: refused while the user holds control or Stop
// runs, and aborted by Stop.
export function computerConverter(deps: {
  computers(): readonly { id: string; state: string; paused?: boolean }[];
  access(cellId: string, signal: AbortSignal): ComputerAccess | "busy" | undefined;
}): Converter {
  const run = async (
    name: string,
    bytes: Buffer,
    signal: AbortSignal,
    to: Conversion,
  ): Promise<Converted> => {
    const kind = fileKind(name);
    const ext = fileExtension(name);
    if (
      (kind !== "office" && (kind !== "pdf" || to === "pages")) ||
      bytes.byteLength > PREVIEW_LIMITS.convertBytes
    )
      return "failed";
    // Any ready computer will do: the conversion is stateless and leaves nothing behind.
    let access: ComputerAccess | undefined;
    let busy = false;
    for (const computer of deps.computers()) {
      if (computer.state !== "ready" || computer.paused) continue;
      let found: ComputerAccess | "busy" | undefined;
      try {
        found = deps.access(computer.id, signal);
      } catch {
        found = "busy";
      }
      if (found === "busy") busy = true;
      else if (found) {
        access = found;
        break;
      }
    }
    if (!access) return busy ? "busy" : "computer_off";
    const dir = `.cache/localdot-preview/${randomBytes(12).toString("hex")}`;
    const timeout = to === "pages" ? PAGES_TIMEOUT_S : CONVERT_TIMEOUT_S;
    try {
      access.check();
      await access.tools.putFile(`${dir}/in.${ext}`, streamOf(bytes), 0o600, access.signal, true);
      access.check();
      const done = await access.tools.shell(
        {
          command: conversionCommand(dir, ext, to),
          timeoutMs: (timeout + 15) * 1000,
          maxOutputBytes: 4096,
        },
        () => {},
        access.signal,
      );
      access.check();
      // soffice's exit code is unreliable; the output either exists or it does not.
      if (done.timedOut) return "failed";
      const made = await readAll(
        await access.tools.fetchFile(`${dir}/in.${to === "pages" ? "pdf" : "png"}`, access.signal),
        to === "pages" ? VIEWER_LIMITS.pdfBytes : RAW_PNG_MAX,
      );
      access.check();
      if (to === "pages" && made.subarray(0, 5).toString("latin1") !== "%PDF-") return "failed";
      return made;
    } catch (error) {
      if (signal.aborted || access.signal.aborted) return "busy";
      return error instanceof TooLarge && to === "pages" ? "too_large" : "failed";
    } finally {
      // After Stop or a computer change the folder is left behind: it is harmless, and waiting on
      // a frozen computer would hold up Stop.
      if (!access.signal.aborted)
        await access.tools
          .shell(
            { command: `rm -rf "$HOME/${dir}"`, timeoutMs: 10_000, maxOutputBytes: 1024 },
            () => {},
            access.signal,
          )
          .catch(() => {});
      access.release();
    }
  };
  return {
    convert: (name, bytes, signal) => run(name, bytes, signal, "picture"),
    pages: (name, bytes, signal) => run(name, bytes, signal, "pages"),
  };
}
function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of stream) {
    size += part.byteLength;
    if (size > max) throw new TooLarge();
    parts.push(part);
  }
  return Buffer.concat(parts, size);
}
