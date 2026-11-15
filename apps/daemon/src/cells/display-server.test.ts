import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayServer } from "./display-server.ts";
import { DockerError, type DockerRequest } from "./docker.ts";
import { SYSTEM_BASE } from "./system-migration.ts";
import { tar, untar } from "./tar.ts";

// localDot's build answers to -glamor; Ubuntu's doesn't.
const OURS = Buffer.from("Xvfb … -glamor  enable glamor render acceleration");
const OLDER_OURS = Buffer.from("an older Xvfb … -glamor");
const UBUNTUS = Buffer.from("Xvfb from Ubuntu, without the option");

// Docker with each container's and each image's /usr/bin/Xvfb, made and removed as Docker would.
function docker({
  desktop,
  base,
  images,
}: {
  desktop: Buffer | undefined;
  base?: string;
  images: Record<string, Buffer | undefined>;
}) {
  const files = new Map<string, Buffer | undefined>([["desktop", desktop]]);
  const made = new Map<string, string>();
  const removed: { id: string; query?: Record<string, string> }[] = [];
  const puts: { container: string; dir: string; file: Buffer | undefined; mode: number }[] = [];
  let next = 0;
  const request = vi.fn(async (req: DockerRequest): Promise<unknown> => {
    const [, kind, id = "", action] = decodeURIComponent(req.path).split("/");
    if (req.method === "POST" && req.path === "/containers/create") {
      const image = (req.body as { Image: string }).Image;
      if (!(image in images)) throw new DockerError(404, "No such image", req.path);
      const name = `made-${next++}`;
      made.set(name, image);
      files.set(name, images[image]);
      return { Id: name };
    }
    if (kind !== "containers") throw new Error(`unexpected ${req.method} ${req.path}`);
    if (req.method === "GET" && action === "json")
      return { Config: { Labels: base ? { [SYSTEM_BASE]: base } : {} } };
    if (req.method === "GET" && action === "archive") {
      expect(req.query?.path).toBe("/usr/bin/Xvfb");
      const file = files.get(id);
      if (!file) throw new DockerError(404, "Could not find the file", req.path);
      return tar([{ name: "Xvfb", data: file, mode: 0o755 }]);
    }
    if (req.method === "DELETE" && action === undefined) {
      removed.push({ id, query: req.query });
      files.delete(id);
      return undefined;
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  const putArchive = vi.fn(async (container: string, dir: string, archive: Buffer) => {
    const mode = Number.parseInt(archive.subarray(100, 107).toString(), 8);
    const file = untar(archive, "Xvfb");
    puts.push({ container, dir, file, mode });
    files.set(container, file);
  });
  const client = { request, putArchive } as unknown as ConstructorParameters<
    typeof DisplayServer
  >[0];
  return { client, request, putArchive, files, made, removed, puts };
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the desktop's display server", () => {
  it("is left alone while it is localDot's own, an older build included", async () => {
    const fake = docker({ desktop: OLDER_OURS, base: "base", images: { base: OURS } });
    await new DisplayServer(fake.client, "installed").keep("desktop");
    expect(fake.puts).toEqual([]);
    expect(fake.made.size).toBe(0);
  });

  it("is put back from the image the computer was made from after an install replaced it", async () => {
    const fake = docker({
      desktop: UBUNTUS,
      base: "base",
      images: { base: OLDER_OURS, installed: OURS },
    });
    await new DisplayServer(fake.client, "installed").keep("desktop");
    expect(fake.puts).toEqual([
      { container: "desktop", dir: "/usr/bin", file: OLDER_OURS, mode: 0o755 },
    ]);
    // The image was read through a container it made and never started, removed with its volumes.
    expect([...fake.made.values()]).toEqual(["base"]);
    expect(fake.removed).toEqual([{ id: "made-0", query: { force: "true", v: "true" } }]);
    expect(fake.request.mock.calls.some(([req]) => req.path.endsWith("/start"))).toBe(false);
  });

  it("comes from the installed image when the computer's own holds Ubuntu's too, or none", async () => {
    for (const base of [UBUNTUS, undefined]) {
      const fake = docker({ desktop: UBUNTUS, base: "base", images: { base, installed: OURS } });
      await new DisplayServer(fake.client, "installed").keep("desktop");
      expect(fake.puts.map((put) => put.file)).toEqual([OURS]);
    }
    const unlabelled = docker({ desktop: UBUNTUS, images: { installed: OURS } });
    await new DisplayServer(unlabelled.client, "installed").keep("desktop");
    expect(unlabelled.puts.map((put) => put.file)).toEqual([OURS]);
  });

  it("is put back when an app removed it", async () => {
    const fake = docker({ desktop: undefined, images: { installed: OURS } });
    await new DisplayServer(fake.client, "installed").keep("desktop");
    expect(fake.files.get("desktop")).toEqual(OURS);
  });

  it("is left as it is, without stopping the start, when no image holds localDot's or Docker fails", async () => {
    const none = docker({ desktop: UBUNTUS, base: "gone", images: { installed: UBUNTUS } });
    await expect(new DisplayServer(none.client, "installed").keep("desktop")).resolves.toBe(
      undefined,
    );
    expect(none.puts).toEqual([]);
    expect(none.removed.map((r) => r.id)).toEqual(["made-0"]);

    const broken = docker({ desktop: UBUNTUS, images: { installed: OURS } });
    broken.putArchive.mockRejectedValueOnce(new Error("Docker went away"));
    await expect(new DisplayServer(broken.client, "installed").keep("desktop")).resolves.toBe(
      undefined,
    );
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Docker went away"));
  });

  it("reads each image once", async () => {
    const fake = docker({ desktop: UBUNTUS, images: { installed: OURS } });
    const display = new DisplayServer(fake.client, "installed");
    await display.keep("desktop");
    fake.files.set("desktop", UBUNTUS);
    await display.keep("desktop");
    expect(fake.puts).toHaveLength(2);
    expect(fake.made.size).toBe(1);
  });
});
