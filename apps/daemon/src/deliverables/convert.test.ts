import type { ShellDone, ShellRequest } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { type ComputerAccess, computerConverter, conversionCommand } from "./convert.ts";

const CELL = "01JXYZ0000000000000000CE11";
const done = (extra: Partial<ShellDone> = {}): ShellDone => ({
  done: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  ms: 5,
  ...extra,
});
function fakeComputer(
  opts: { png?: Buffer; pdf?: Buffer; shell?: (req: ShellRequest) => Promise<ShellDone> } = {},
) {
  const files = new Map<string, Buffer>();
  const commands: string[] = [];
  const abort = new AbortController();
  const released = vi.fn();
  const access: ComputerAccess = {
    signal: abort.signal,
    check: () => abort.signal.throwIfAborted(),
    release: released,
    tools: {
      putFile: async (path, source, _mode, _signal, createOnly) => {
        if (createOnly && files.has(path)) throw new Error("exists");
        files.set(path, Buffer.from(await new Response(source).arrayBuffer()));
        return `~/${path}`;
      },
      shell: async (req) => {
        commands.push(req.command);
        if (opts.shell) return opts.shell(req);
        const dir = /\$HOME\/(\.cache\/localdot-preview\/[0-9a-f]{24})/.exec(req.command)?.[1];
        if (dir && !req.command.startsWith("rm ")) {
          if (opts.png) files.set(`${dir}/in.png`, opts.png);
          if (opts.pdf) files.set(`${dir}/in.pdf`, opts.pdf);
        }
        return done();
      },
      fetchFile: async (path) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error("not found");
        return new Response(bytes).body as ReadableStream<Uint8Array>;
      },
    },
  };
  return { access, files, commands, abort, released };
}
const converter = (
  access: ComputerAccess | "busy" | undefined,
  computers: { id: string; state: string; paused?: boolean }[] = [{ id: CELL, state: "ready" }],
) => computerConverter({ computers: () => computers, access: () => access });
const signal = () => new AbortController().signal;

describe("conversion inside dot's computer", () => {
  it("builds a fixed command from a random folder and an allowlisted extension only", () => {
    const dir = `.cache/localdot-preview/${"a".repeat(24)}`;
    expect(conversionCommand(dir, "ods", "picture")).toContain(
      `-env:UserInstallation=file://$HOME/${dir}/profile`,
    );
    expect(conversionCommand(dir, "pdf", "picture")).toMatch(
      /pdftoppm -png .* -scale-to 1024 -singlefile in\.pdf in$/,
    );
    expect(() => conversionCommand(".cache/localdot-preview/$(id)", "ods", "picture")).toThrow();
    expect(() => conversionCommand(dir, "ods;rm", "picture")).toThrow();
    expect(() => conversionCommand(dir, "pdf", "pages")).toThrow();
  });
  it("makes every page as a PDF in bounded time, file size and priority", () => {
    const dir = `.cache/localdot-preview/${"b".repeat(24)}`;
    expect(conversionCommand(dir, "pptx", "pages")).toBe(
      `cd "$HOME/${dir}" && ulimit -f 131072 && timeout -k 5 90 nice -n 10 soffice -env:UserInstallation=file://$HOME/${dir}/profile --headless --norestore --nolockcheck --convert-to pdf --outdir . in.pptx`,
    );
  });
  it("copies the bytes in, converts, fetches the page image and removes the folder", async () => {
    const c = fakeComputer({ png: Buffer.from("png") });
    const out = await converter(c.access).convert("report.ods", Buffer.from("ods"), signal());
    expect(out).toEqual(Buffer.from("png"));
    expect([...c.files.keys()].some((k) => /\/in\.ods$/.test(k))).toBe(true);
    expect(c.commands[0]).toMatch(/soffice .*--convert-to png --outdir \. in\.ods$/);
    expect(c.commands.at(-1)).toMatch(/^rm -rf "\$HOME\/\.cache\/localdot-preview\/[0-9a-f]{24}"$/);
    expect(c.released).toHaveBeenCalledOnce();
  });
  it("reports computer_off with no ready computer and busy while the user has control", async () => {
    expect(await converter(undefined, []).convert("a.ods", Buffer.from("x"), signal())).toBe(
      "computer_off",
    );
    expect(
      await converter(undefined, [{ id: CELL, state: "ready", paused: true }]).convert(
        "a.ods",
        Buffer.from("x"),
        signal(),
      ),
    ).toBe("computer_off");
    expect(await converter("busy").convert("a.ods", Buffer.from("x"), signal())).toBe("busy");
    const refusing = computerConverter({
      computers: () => [{ id: CELL, state: "ready" }],
      access: () => {
        throw new Error("file transfers are closed");
      },
    });
    expect(await refusing.convert("a.ods", Buffer.from("x"), signal())).toBe("busy");
  });
  it("stops at Stop: no page image, no cleanup on a frozen computer, the lease released", async () => {
    let c!: ReturnType<typeof fakeComputer>;
    c = fakeComputer({
      shell: async () => {
        c.abort.abort(new Error("stopped"));
        throw new Error("aborted");
      },
    });
    expect(await converter(c.access).convert("a.docx", Buffer.from("x"), signal())).toBe("busy");
    expect(c.commands.filter((x) => x.startsWith("rm "))).toEqual([]);
    expect(c.released).toHaveBeenCalledOnce();
  });
  it("fails a conversion that timed out or produced nothing", async () => {
    const timedOut = fakeComputer({ shell: async () => done({ timedOut: true, exitCode: null }) });
    expect(await converter(timedOut.access).convert("a.pptx", Buffer.from("x"), signal())).toBe(
      "failed",
    );
    const empty = fakeComputer();
    expect(await converter(empty.access).convert("a.pptx", Buffer.from("x"), signal())).toBe(
      "failed",
    );
  });
  it("hands back a deck's pages as a PDF, and nothing that is not one or is too large", async () => {
    const pdf = Buffer.from("%PDF-1.7 pages");
    const c = fakeComputer({ pdf });
    expect(await converter(c.access).pages("deck.pptx", Buffer.from("pptx"), signal())).toEqual(
      pdf,
    );
    expect(c.commands[0]).toMatch(/--convert-to pdf --outdir \. in\.pptx$/);
    expect(c.commands.at(-1)).toMatch(/^rm -rf /);
    expect(c.released).toHaveBeenCalledOnce();
    const fake = fakeComputer({ pdf: Buffer.from("<html>") });
    expect(await converter(fake.access).pages("a.docx", Buffer.from("x"), signal())).toBe("failed");
    const huge = fakeComputer({ pdf: Buffer.alloc(50 * 1024 * 1024 + 1, 0x25) });
    expect(await converter(huge.access).pages("a.docx", Buffer.from("x"), signal())).toBe(
      "too_large",
    );
    expect(huge.commands.at(-1)).toMatch(/^rm -rf /);
    const pdfIn = fakeComputer({ pdf });
    expect(await converter(pdfIn.access).pages("scan.pdf", Buffer.from("x"), signal())).toBe(
      "failed",
    );
    expect(pdfIn.commands).toEqual([]);
  });
  it("refuses kinds it does not convert and inputs over 25 MiB", async () => {
    const c = fakeComputer({ png: Buffer.from("png") });
    expect(await converter(c.access).convert("a.png", Buffer.from("x"), signal())).toBe("failed");
    expect(
      await converter(c.access).convert("a.ods", Buffer.alloc(25 * 1024 * 1024 + 1), signal()),
    ).toBe("failed");
    expect(c.commands).toEqual([]);
  });
});
