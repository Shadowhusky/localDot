import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DesktopContainer,
  execAsDesktopUser,
  startDesktopContainer,
} from "../cells/testing/desktop-container.ts";
import { DOCKER_TESTS, removeAll } from "../cells/testing/docker-cli.ts";
import { DesktopdTools } from "../desktopd/tools-client.ts";
import { computerConverter } from "./convert.ts";
import { previewPng } from "./image-preview.ts";

const C = "localdot-test-convert";
const TEST_LABEL = "dev.localdot.test=1";
let desktop: DesktopContainer;
let tools: DesktopdTools;
describe.skipIf(!DOCKER_TESTS)("page images made inside the desktop", () => {
  beforeAll(() => {
    desktop = startDesktopContainer(C, 1, ["--label", TEST_LABEL]);
    tools = new DesktopdTools({ baseUrl: desktop.baseUrl, token: desktop.token });
    // Real documents, made the way the office-files skill makes them.
    const make = [
      "mkdir -p ~/fixtures && cd ~/fixtures",
      "printf 'Month,Net\\nNov,11800\\nDec,12000\\n' > totals.csv",
      "soffice -env:UserInstallation=file:///tmp/ld-fixture-profile --headless --convert-to ods totals.csv",
      "printf '# Brief\\n\\nTotals checked.\\n' > brief.md && pandoc brief.md -o brief.docx",
      "soffice -env:UserInstallation=file:///tmp/ld-fixture-profile --headless --convert-to pdf brief.docx",
    ].join(" && ");
    const made = execAsDesktopUser(C, "bash", "-lc", make);
    expect(made.status, made.out).toBe(0);
  });
  afterAll(async () => {
    await tools?.close();
    removeAll({ containers: [C] });
  });
  it.each(["totals.ods", "brief.docx", "brief.pdf"])(
    "renders %s to a bounded page image",
    async (name) => {
      const bytes = Buffer.from(
        await new Response(await tools.fetchFile(`fixtures/${name}`)).arrayBuffer(),
      );
      const abort = new AbortController();
      const converter = computerConverter({
        computers: () => [{ id: "01JXYZ0000000000000000CE11", state: "ready" }],
        access: () => ({ tools, signal: abort.signal, check: () => {}, release: () => {} }),
      });
      const page = await converter.convert(name, bytes, abort.signal);
      expect(Buffer.isBuffer(page)).toBe(true);
      const png = await previewPng(page as Buffer);
      const meta = await sharp(png).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024);
      expect(png.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      const left = execAsDesktopUser(C, "bash", "-lc", "ls ~/.cache/localdot-preview | wc -l");
      expect(left.out.trim()).toBe("0");
    },
  );
  it.each(["totals.ods", "brief.docx"])("makes every page of %s as a PDF", async (name) => {
    const bytes = Buffer.from(
      await new Response(await tools.fetchFile(`fixtures/${name}`)).arrayBuffer(),
    );
    const abort = new AbortController();
    const converter = computerConverter({
      computers: () => [{ id: "01JXYZ0000000000000000CE11", state: "ready" }],
      access: () => ({ tools, signal: abort.signal, check: () => {}, release: () => {} }),
    });
    const pdf = await converter.pages(name, bytes, abort.signal);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect((pdf as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const left = execAsDesktopUser(C, "bash", "-lc", "ls ~/.cache/localdot-preview | wc -l");
    expect(left.out.trim()).toBe("0");
  });
});
