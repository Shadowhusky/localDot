import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaceError, placeDownload } from "./place-download.ts";

const home = () => realpathSync(mkdtempSync(join(tmpdir(), "local dot's release-")));
const payload = Buffer.from("#!/bin/sh\necho owned\n");

describe("placeDownload (Review Focus 2)", () => {
  it("writes a new, non-executable file into ~/Downloads", () => {
    const h = home();
    expect(placeDownload(h, "payload.sh", payload)).toBe("~/Downloads/payload.sh");
    const st = statSync(join(h, "Downloads", "payload.sh"));
    expect(st.mode & 0o777).toBe(0o644);
    expect(readFileSync(join(h, "Downloads", "payload.sh"))).toEqual(payload);
  });

  it("never writes through a link the agent planted, nor over an existing file", () => {
    const h = home();
    mkdirSync(join(h, "Downloads"));
    writeFileSync(join(h, ".bashrc"), "# mine\n");
    chmodSync(join(h, ".bashrc"), 0o755);
    symlinkSync(join(h, ".bashrc"), join(h, "Downloads", "report.pdf"));
    symlinkSync(join(h, "nowhere"), join(h, "Downloads", "report (1).pdf"));
    writeFileSync(join(h, "Downloads", "report (2).pdf"), "older");
    expect(placeDownload(h, "report.pdf", payload)).toBe("~/Downloads/report (3).pdf");
    expect(readFileSync(join(h, ".bashrc"), "utf8")).toBe("# mine\n");
    expect(existsSync(join(h, "nowhere"))).toBe(false);
    expect(readFileSync(join(h, "Downloads", "report (2).pdf"), "utf8")).toBe("older");
    expect(statSync(join(h, "Downloads", "report (3).pdf")).mode & 0o111).toBe(0);
  });

  it("refuses a ~/Downloads that is a link, and names that are not one plain component", () => {
    const h = home();
    mkdirSync(join(h, ".config"));
    symlinkSync(join(h, ".config"), join(h, "Downloads"));
    expect(() => placeDownload(h, "autostart.desktop", payload)).toThrow(PlaceError);
    expect(lstatSync(join(h, "Downloads")).isSymbolicLink()).toBe(true);
    const h2 = home();
    for (const bad of ["../.bashrc", "a/b", ".hidden", "..", "", "x\u{0}y", "x\ny"])
      expect(() => placeDownload(h2, bad, payload), JSON.stringify(bad)).toThrow(PlaceError);
  });

  it("refuses a Downloads folder swapped for a link, and writes nothing into its target", () => {
    const h = home();
    mkdirSync(join(h, "Downloads"));
    mkdirSync(join(h, "bin"));
    // A first file proves the folder; then the agent swaps the folder for a link to ~/bin.
    placeDownload(h, "a.txt", Buffer.from("a"));
    renameSync(join(h, "Downloads"), join(h, "Downloads.old"));
    symlinkSync(join(h, "bin"), join(h, "Downloads"));
    expect(() => placeDownload(h, "tool", payload)).toThrow(PlaceError);
    expect(existsSync(join(h, "bin", "tool"))).toBe(false);
  });
});
