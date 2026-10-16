import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_UPLOAD, type UserUploadStatus, userUploadPath } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import { userUploadRoutes } from "../../../daemon/src/agent/user-upload-routes.ts";
import { UserUploads } from "../../../daemon/src/agent/user-uploads.ts";
import { DesktopdTools } from "../../../daemon/src/desktopd/tools-client.ts";
import { createApi } from "../lib/api.ts";
import { uploadFile } from "./resumable-upload.ts";

const require = createRequire(new URL("../../../daemon/package.json", import.meta.url));
const { Hono } = require("hono") as { Hono: new () => Parameters<typeof userUploadRoutes>[0] };
const CELL = "01JXYZ0000000000000000CE11",
  OTHER = "01JXYZ00000000000000000002";
const homes: string[] = [],
  clients: DesktopdTools[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(
  intercept?: (
    url: string,
    init: RequestInit | undefined,
    response: Response,
  ) => Response | Promise<Response>,
) {
  const home = mkdtempSync(join(tmpdir(), "localdot-incoming-"));
  homes.push(home);
  const computer = mkdtempSync(join(tmpdir(), "localdot-computer-"));
  homes.push(computer);
  const desktop = new Hono();
  addToolRoutes(desktop, {
    home: computer,
    env: {},
    browser: {
      read: async () => {
        throw Error("unused");
      },
      navigate: async () => {
        throw Error("unused");
      },
    },
  });
  let loseDesktopReceipt = false;
  const tools = new DesktopdTools(
    { baseUrl: "http://desktop", token: "test" },
    async (url, init) => {
      const response = await desktop.fetch(new Request(url, init));
      if (loseDesktopReceipt && response.ok) {
        loseDesktopReceipt = false;
        throw Error("lost final computer receipt");
      }
      return response;
    },
  );
  clients.push(tools);
  const place = vi.fn(async (_cell, file, source) =>
    tools.putUserFile(file, source, new AbortController().signal),
  );
  let store = new UserUploads(home, place);
  const appFor = () => {
    const app = new Hono();
    userUploadRoutes(app, store, (id) => [CELL, OTHER].includes(id));
    return app;
  };
  let app = appFor();
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const reply = await app.fetch(new Request(url, init));
    return intercept ? intercept(String(url), init, reply) : reply;
  });
  const api = createApi("upload-test", { origin: "http://daemon", fetchImpl });
  return {
    home,
    computer,
    api,
    fetchImpl,
    place,
    get store() {
      return store;
    },
    restart: () => {
      store = new UserUploads(home, place);
      app = appFor();
    },
    loseReceipt: () => {
      loseDesktopReceipt = true;
    },
    request: (path: string, init?: RequestInit) => app.request(path, init),
  };
}
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const finish = async (f: ReturnType<typeof fixture>, id: string) => {
  await f.store.complete(CELL, id);
  await vi.waitFor(async () => expect((await f.store.status(CELL, id)).phase).toBe("complete"));
};

describe("resumable, verified user files through the real daemon and desktop routes", () => {
  it("streams a 128 MiB binary dataset without whole-file reads and verifies the exact computer file", async () => {
    const f = fixture(),
      id = randomUUID(),
      block = new Uint8Array(1024 * 1024).fill(173);
    const file = new File(
      Array.from({ length: 128 }, () => block),
      "training data.zip",
    );
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(Error("whole-file reads forbidden"));
    let largestSlice = 0;
    const slice = file.slice.bind(file);
    vi.spyOn(file, "slice").mockImplementation((start, end) => {
      largestSlice = Math.max(largestSlice, (end ?? file.size) - (start ?? 0));
      return slice(start, end);
    });
    const progress = vi.fn();
    const path = await uploadFile(f.api, CELL, file, new AbortController().signal, {
      id,
      progress,
    });
    expect(path).toBe(`~/${userUploadPath(id, file.name)}`);
    expect(largestSlice).toBe(USER_UPLOAD.chunkBytes);
    const uploaded = readFileSync(join(f.computer, userUploadPath(id, file.name)));
    expect(uploaded.byteLength).toBe(file.size);
    expect(uploaded[0]).toBe(173);
    expect(uploaded.at(-1)).toBe(173);
    expect((await f.store.status(CELL, id)).sha256).toBe(digest(uploaded));
    expect(progress.mock.calls.some(([p]) => p.offset >= 100 * 1024 * 1024)).toBe(true);
    expect(f.place).toHaveBeenCalledOnce();
  }, 30_000);
  it("reconciles a committed chunk and completion whose HTTP replies were lost", async () => {
    let lostChunk = false,
      lostComplete = false;
    const f = fixture((_url, init, response) => {
      if (init?.method === "PATCH" && !lostChunk) {
        lostChunk = true;
        throw Error("network lost chunk acknowledgement");
      }
      if (_url.endsWith("/complete") && !lostComplete) {
        lostComplete = true;
        throw Error("network lost completion acknowledgement");
      }
      return response;
    });
    const file = new File(["dataset"], "data.bin"),
      id = randomUUID();
    const path = await uploadFile(f.api, CELL, file, new AbortController().signal, { id });
    expect(readFileSync(join(f.computer, path.slice(2)), "utf8")).toBe("dataset");
    expect(f.fetchImpl.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(f.place).toHaveBeenCalledOnce();
  });
  it("retains the acknowledged offset across daemon restart and refuses corruption, stale offsets, and another computer", async () => {
    const f = fixture(),
      id = randomUUID(),
      chunk = Buffer.from("data");
    await f.store.create(CELL, { id, name: "dataset.bin", bytes: 8 });
    await expect(f.store.append(CELL, id, 0, chunk, "0".repeat(64))).rejects.toMatchObject({
      status: 422,
    });
    expect((await f.store.status(CELL, id)).offset).toBe(0);
    await f.store.append(CELL, id, 0, chunk, digest(chunk));
    // The process died after writing bytes but before acknowledging them.
    writeFileSync(join(f.home, "user-uploads", `${id}.part`), "dataUNACKNOWLEDGED");
    f.restart();
    expect((await f.store.status(CELL, id)).offset).toBe(4);
    await expect(f.store.status(OTHER, id)).rejects.toMatchObject({ status: 404 });
    await expect(f.store.append(CELL, id, 0, chunk, digest(chunk))).rejects.toMatchObject({
      status: 409,
    });
    await f.store.append(CELL, id, 4, chunk, digest(chunk));
    await finish(f, id);
    expect(readFileSync(join(f.computer, userUploadPath(id, "dataset.bin")), "utf8")).toBe(
      "datadata",
    );
  });
  it("recovers a receipt lost after atomic computer publication without overwriting or duplicating the file", async () => {
    const f = fixture(),
      id = randomUUID(),
      input = { id, name: "sample.zip", bytes: 4 };
    await f.store.create(CELL, input);
    await f.store.append(CELL, id, 0, Buffer.from("data"), digest("data"));
    f.loseReceipt();
    await f.store.complete(CELL, id);
    await vi.waitFor(async () => expect((await f.store.status(CELL, id)).phase).toBe("paused"));
    expect(readFileSync(join(f.computer, userUploadPath(id, input.name)), "utf8")).toBe("data");
    f.restart();
    await finish(f, id);
    expect((await f.store.status(CELL, id)).path).toBe(`~/${userUploadPath(id, input.name)}`);
    await f.store.remove(CELL, id);
    expect(readFileSync(join(f.computer, userUploadPath(id, input.name)), "utf8")).toBe("data");
  });
  it("does not overwrite a file changed by the computer after a lost receipt", async () => {
    const f = fixture(),
      id = randomUUID();
    await f.store.create(CELL, { id, name: "sample.zip", bytes: 4 });
    await f.store.append(CELL, id, 0, Buffer.from("data"), digest("data"));
    f.loseReceipt();
    await f.store.complete(CELL, id);
    await vi.waitFor(async () => expect((await f.store.status(CELL, id)).phase).toBe("paused"));
    writeFileSync(join(f.computer, userUploadPath(id, "sample.zip")), "USER");
    await f.store.complete(CELL, id);
    await vi.waitFor(async () => expect((await f.store.status(CELL, id)).phase).toBe("paused"));
    expect(readFileSync(join(f.computer, userUploadPath(id, "sample.zip")), "utf8")).toBe("USER");
  });
  it("supports empty files and same-named files in separate upload folders", async () => {
    const f = fixture();
    const paths: string[] = [];
    for (let i = 0; i < 2; i++)
      paths.push(
        await uploadFile(f.api, CELL, new File([], "same.csv"), new AbortController().signal),
      );
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.map((p) => readFileSync(join(f.computer, p.slice(2))).byteLength)).toEqual([0, 0]);
  });
  it("bounds request chunks even when content-length is absent and refuses forged names and receipts", async () => {
    const f = fixture(),
      root = `/api/cells/${CELL}/uploads`,
      id = randomUUID();
    const bad = await f.request(root, {
      method: "POST",
      body: JSON.stringify({ id, name: "../escape.zip", bytes: 1 }),
    });
    expect(bad.status).toBe(400);
    await f.store.create(CELL, { id, name: "data.bin", bytes: USER_UPLOAD.chunkBytes + 1 });
    const tooBig = await f.request(`${root}/${id}`, {
      method: "PATCH",
      body: new Uint8Array(USER_UPLOAD.chunkBytes + 1),
      headers: { "upload-offset": "0", "upload-checksum": "0".repeat(64) },
    });
    expect(tooBig.status).toBe(413);
    const g = fixture(async (_url, _init, response) => {
      const value = (await response.json()) as UserUploadStatus;
      return Response.json({
        ...value,
        phase: "complete",
        offset: value.bytes,
        sha256: "0".repeat(64),
        path: "~/forged.txt",
      });
    });
    await expect(
      uploadFile(g.api, CELL, new File([], "data.bin"), new AbortController().signal),
    ).rejects.toThrow("Upload paused");
  }, 15_000);
});
