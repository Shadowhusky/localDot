import { ToolResult } from "@localdot/protocol";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { DesktopdError } from "../../desktopd/client.ts";
import { PROXY_TOKEN, toolHarness } from "../testing/harness.ts";

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function setup() {
  const h = toolHarness();
  fixtures.push(h);
  return h;
}
it("redacts structured file observations just like the model-visible text", async () => {
  const h = setup();
  h.desktop.files.set("~/.agents/skills/test/SKILL.md", `Skill ${PROXY_TOKEN}`);
  const response = await h.call("files", { op: "read", path: "~/.agents/skills/test/SKILL.md" });
  const result = ToolResult.parse(response.body);
  expect(result.ok).toBe(true);
  expect(result.fileRead?.content).toBeDefined();
  expect(JSON.stringify(result)).not.toContain(PROXY_TOKEN);
});
it("distinguishes absent skill directories from unavailable computers", async () => {
  const h = setup();
  const desktop = h.tools.desktop(h.session.cellId);
  if (!desktop) throw new Error("Missing fixture desktop");
  h.tools.desktop = () => ({
    ...desktop,
    listDir: async () => {
      throw new DesktopdError(404, "missing", "/files/list");
    },
  });
  const missing = ToolResult.parse(
    (await h.call("files", { op: "list", path: "~/.agents/skills" })).body,
  );
  expect(missing).toMatchObject({ ok: false, fileError: "not_found" });
  h.tools.desktop = () => ({
    ...desktop,
    listDir: async () => {
      throw new DesktopdError(503, "unavailable", "/files/list");
    },
  });
  const unavailable = ToolResult.parse(
    (await h.call("files", { op: "list", path: "~/.agents/skills" })).body,
  );
  expect(unavailable.ok).toBe(false);
  expect(unavailable.fileError).toBeUndefined();
});
it("shows the model a picture it reads, as a JPEG no larger than it can use", async () => {
  const h = setup();
  const desktop = h.tools.desktop(h.session.cellId);
  if (!desktop) throw new Error("Missing fixture desktop");
  const png = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#3366ff" },
  })
    .png()
    .toBuffer();
  h.tools.desktop = () => ({
    ...desktop,
    readFile: async () => ({
      path: "~/Downloads/shot.png",
      content: "",
      bytes: png.length,
      truncated: true,
      binary: true,
    }),
    fetchFile: async () =>
      new ReadableStream({
        start(c) {
          c.enqueue(png);
          c.close();
        },
      }),
  });
  const result = ToolResult.parse(
    (await h.call("files", { op: "read", path: "~/Downloads/shot.png" })).body,
  );
  const picture = result.content.find((c) => c.type === "web_image");
  expect(picture).toMatchObject({ mediaType: "image/jpeg", url: "~/Downloads/shot.png" });
  const meta = await sharp(
    Buffer.from(picture?.type === "web_image" ? picture.data : "", "base64"),
  ).metadata();
  expect(meta.format).toBe("jpeg");
  expect([meta.width, meta.height]).toEqual([1568, 1045]);
});
it("leaves a binary file that is not a picture as a note", async () => {
  const h = setup();
  const desktop = h.tools.desktop(h.session.cellId);
  if (!desktop) throw new Error("Missing fixture desktop");
  h.tools.desktop = () => ({
    ...desktop,
    readFile: async () => ({
      path: "~/Downloads/data.bin",
      content: "",
      bytes: 10,
      truncated: false,
      binary: true,
    }),
  });
  const result = ToolResult.parse(
    (await h.call("files", { op: "read", path: "~/Downloads/data.bin" })).body,
  );
  expect(result.content.map((c) => c.type)).toEqual(["text"]);
});
