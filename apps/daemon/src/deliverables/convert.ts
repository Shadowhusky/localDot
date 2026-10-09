import { randomBytes } from "node:crypto";
import { fileExtension, fileKind, PREVIEW_LIMITS } from "@localdot/protocol";
import type { DesktopdTools } from "../desktopd/tools-client.ts";
import type { Converter } from "./previews.ts";

export interface ComputerAccess {
  tools: Pick<DesktopdTools, "putFile" | "shell" | "fetchFile">;
  signal: AbortSignal;
  check(): void;
  release(): void;
}
export const CONVERT_TIMEOUT_S = 45;
const RAW_PNG_MAX = 16 * 1024 * 1024;

// The fixed command for one conversion. Only a random hex folder and an allowlisted extension
// reach the shell; the file itself is always called in.<ext>.
export function conversionCommand(dir: string, ext: string, pdf: boolean): string {
  if (!/^\.cache\/localdot-preview\/[0-9a-f]{24}$/.test(dir) || !/^[a-z]{2,5}$/.test(ext))
    throw new Error("invalid conversion");
  const work = `"$HOME/${dir}"`;
  return pdf
    ? `cd ${work} && timeout ${CONVERT_TIMEOUT_S} pdftoppm -png -r 96 -f 1 -l 1 -scale-to ${PREVIEW_LIMITS.imagePx} -singlefile in.pdf in`
    : `cd ${work} && timeout ${CONVERT_TIMEOUT_S} soffice -env:UserInstallation=file://$HOME/${dir}/profile --headless --norestore --nolockcheck --convert-to png --outdir . in.${ext}`;
}

// Office documents and PDFs are rendered inside dot's computer, never on the Mac. The command is
// the daemon's own, admitted like a user upload: refused while the user holds control or Stop
// runs, and aborted by Stop.
export function computerConverter(deps: {
  computers(): readonly { id: string; state: string; paused?: boolean }[];
  access(cellId: string, signal: AbortSignal): ComputerAccess | "busy" | undefined;
}): Converter {
  return {
    async convert(name, bytes, signal) {
      const kind = fileKind(name);
      const ext = fileExtension(name);
      if ((kind !== "office" && kind !== "pdf") || bytes.byteLength > PREVIEW_LIMITS.convertBytes)
        return "failed";
      // Any ready computer will do: the conversion is stateless and leaves nothing behind.
      const cellId = deps.computers().find((c) => c.state === "ready" && !c.paused)?.id;
      if (!cellId) return "computer_off";
      let access: ComputerAccess | "busy" | undefined;
      try {
        access = deps.access(cellId, signal);
      } catch {
        return "busy";
      }
      if (access === "busy") return "busy";
      if (!access) return "computer_off";
      const dir = `.cache/localdot-preview/${randomBytes(12).toString("hex")}`;
      try {
        access.check();
        await access.tools.putFile(`${dir}/in.${ext}`, streamOf(bytes), 0o600, access.signal, true);
        access.check();
        const done = await access.tools.shell(
          {
            command: conversionCommand(dir, ext, kind === "pdf"),
            timeoutMs: (CONVERT_TIMEOUT_S + 15) * 1000,
            maxOutputBytes: 4096,
          },
          () => {},
          access.signal,
        );
        access.check();
        // soffice's exit code is unreliable; the page image either exists or it does not.
        if (done.timedOut) return "failed";
        const png = await readAll(
          await access.tools.fetchFile(`${dir}/in.png`, access.signal),
          RAW_PNG_MAX,
        );
        access.check();
        return png;
      } catch {
        return signal.aborted || access.signal.aborted ? "busy" : "failed";
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
    },
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
    if (size > max) throw new Error("conversion output too large");
    parts.push(part);
  }
  return Buffer.concat(parts, size);
}
