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
it("ends a missing path's step with why it failed", async () => {
  const h = setup();
  const desktop = h.tools.desktop(h.session.cellId);
  if (!desktop) throw new Error("Missing fixture desktop");
  h.tools.desktop = () => ({
    ...desktop,
    listDir: async () => {
      throw new DesktopdError(404, "missing", "/files/list");
    },
  });
  await h.call("files", { op: "list", path: "~/Projects/old" });
  expect(h.events().find((e) => e.type === "step.end")?.data).toEqual({
    status: "failed",
    note: "The file or folder does not exist.",
  });
});
it("shows in its step what dot read, clipped and redacted", async () => {
  const h = setup();
  h.desktop.files.set("~/notes.md", `Groceries ${PROXY_TOKEN}\n${"x".repeat(9000)}`);
  await h.call("files", { op: "read", path: "~/notes.md" });
  const output = h.events().filter((e) => e.type === "tool.output");
  expect(output).toHaveLength(1);
  const chunk = (output[0]?.data as { chunk?: string } | undefined)?.chunk ?? "";
  expect(chunk).toContain("Groceries [redacted]\n");
  expect(chunk).not.toContain(PROXY_TOKEN);
  expect(chunk.length).toBeLessThanOrEqual(4100);
});
it("keeps the harness's own skill reads out of Activity", async () => {
  const h = setup();
  h.desktop.files.set("~/.skills/pdf-tools/SKILL.md", "# PDF tools");
  const read = await h.call(
    "files",
    { op: "read", path: "~/.skills/pdf-tools/SKILL.md" },
    "skill-1",
  );
  expect(read.body.ok).toBe(true);
  expect(
    h.events().filter((e) => e.type.startsWith("step.") || e.type.startsWith("tool.")),
  ).toEqual([]);
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
  const output = h.events().find((event) => event.type === "tool.output");
  if (output?.type !== "tool.output") throw new Error("Missing output event");
  expect(output.data.image?.alt).toBe("~/Downloads/shot.png");
  expect(output.data.chunk).not.toContain("it follows");
  if (!output.data.image) throw new Error("Missing saved image");
  expect(h.outputs.get(output.data.image.name)).toEqual(
    Buffer.from(picture?.type === "web_image" ? picture.data : "", "base64"),
  );
  // The event log stays small and keeps a durable reference, not base64 image data.
  expect(JSON.stringify(output).length).toBeLessThan(1000);
  h.tools.saveOutput = async () => {
    throw new Error("Disk full");
  };
  const withoutPreview = ToolResult.parse(
    (await h.call("files", { op: "read", path: "~/Downloads/shot.png" })).body,
  );
  expect(withoutPreview).toEqual(result);
  expect(JSON.stringify(result)).not.toContain("step-image-");
});
it("shows the model no picture but a PNG, JPEG, GIF or WebP, whatever the file is called", async () => {
  const h = setup();
  const desktop = h.tools.desktop(h.session.cellId);
  if (!desktop) throw new Error("Missing fixture desktop");
  const canvas = () =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: "#000" } });
  const tiff = await canvas().tiff().toBuffer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"/>');
  const fetched: string[] = [];
  const read = async (path: string, bytes: Buffer) => {
    h.tools.desktop = () => ({
      ...desktop,
      readFile: async () => ({
        path,
        content: "",
        bytes: bytes.length,
        truncated: true,
        binary: true,
      }),
      fetchFile: async (asked: string) => {
        fetched.push(asked);
        return new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        });
      },
    });
    return ToolResult.parse((await h.call("files", { op: "read", path })).body);
  };
  for (const path of ["~/scan.tiff", "~/photo.heic", "~/photo.heif", "~/photo.avif", "~/icon.bmp"])
    expect(
      (await read(path, tiff)).content.map((c) => c.type),
      path,
    ).toEqual(["text"]);
  expect(fetched).toEqual([]);
  for (const [path, bytes] of [
    ["~/scan.png", tiff],
    ["~/logo.png", svg],
    ["~/logo.webp", svg],
  ] as const)
    expect(
      (await read(path, bytes)).content.map((c) => c.type),
      path,
    ).toEqual(["text"]);
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
