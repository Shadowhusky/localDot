import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopdTools } from "../../../../apps/daemon/src/desktopd/tools-client.ts";
import { createDesktopdApp } from "./app.ts";
import { prepareDesktopBrowser } from "./browser-profile.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const token = "d".repeat(43);
const generation = "a".repeat(32);
function app(prepareBrowser?: Parameters<typeof createDesktopdApp>[0]["prepareBrowser"]) {
  return createDesktopdApp({
    token,
    scale: 1,
    display: ":1",
    readXsettings: async () => null,
    readScreen: async () => null,
    prepareBrowser,
  });
}
const post = (task: unknown, bearer = token) => ({
  method: "POST",
  headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  body: JSON.stringify(task),
});

it("authenticates and strictly binds profile preparation to one task", async () => {
  const prepare = vi.fn(async (taskId: string) => ({ taskId, generation }));
  const a = app(prepare),
    taskId = ulid();
  expect((await a.request("/browser/task", post({ taskId }, "wrong"))).status).toBe(401);
  for (const value of [
    { taskId, path: "/config" },
    { taskId, recover: true },
    { taskId: "../other" },
  ])
    expect((await a.request("/browser/task", post(value))).status).toBe(400);
  expect(prepare).not.toHaveBeenCalled();
  expect(await (await a.request("/browser/task", post({ taskId }))).json()).toEqual({
    taskId,
    generation,
  });
  expect(prepare).toHaveBeenCalledTimes(1);
});
it("cannot acknowledge absent, failed or mismatched preparation", async () => {
  const taskId = ulid();
  for (const prepare of [
    undefined,
    async () => {
      throw new Error("private path");
    },
    async () => ({ taskId: ulid(), generation }),
  ]) {
    const response = await app(prepare).request("/browser/task", post({ taskId }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private path");
  }
});
it("host client verifies the matching generation receipt through the actual route", async () => {
  const taskId = ulid(),
    prepare = vi.fn(async (id: string) => ({ taskId: id, generation }));
  const a = app(prepare);
  const tools = new DesktopdTools(
    { baseUrl: "http://127.0.0.1:7700", token },
    async (input, init) => a.request(String(input), init),
  );
  try {
    await tools.prepareBrowser(taskId);
    expect(prepare).toHaveBeenCalledWith(taskId, expect.any(AbortSignal));
  } finally {
    await tools.close();
  }
});
it("host client rejects a substituted task response", async () => {
  const tools = new DesktopdTools({ baseUrl: "http://127.0.0.1:7700", token }, async () =>
    Response.json({ taskId: ulid(), generation }),
  );
  try {
    await expect(tools.prepareBrowser(ulid())).rejects.toThrow("browser task changed");
  } finally {
    await tools.close();
  }
});
function helper(source: string) {
  const home = mkdtempSync("/tmp/profile-helper-");
  homes.push(home);
  const path = join(home, "helper.py");
  writeFileSync(path, source);
  return { home, path };
}
it("helper receipt is returned only after the helper process exits", async () => {
  const fixture = helper(
    'import json,sys\nx=json.load(sys.stdin)\nprint(json.dumps({"taskId": x["taskId"], "generation": "a"*32}))\n',
  );
  const taskId = ulid();
  expect(await prepareDesktopBrowser(taskId, undefined, fixture.path)).toEqual({
    taskId,
    generation,
  });
});
it("aborting a started rotation retains ownership until its helper closes", async () => {
  const fixture = helper(
    'import json,sys,time,pathlib\nx=json.load(sys.stdin)\npathlib.Path(__file__+".started").write_text("ready")\ntime.sleep(0.15)\npathlib.Path(__file__+".closed").write_text("done")\nprint(json.dumps({"taskId": x["taskId"], "generation": "a"*32}))\n',
  );
  const controller = new AbortController();
  const work = prepareDesktopBrowser(ulid(), controller.signal, fixture.path);
  const observed = work.catch((e: unknown) => e);
  await vi.waitFor(() => expect(readFileSync(`${fixture.path}.started`, "utf8")).toBe("ready"));
  controller.abort(new Error("cancelled"));
  expect(await observed).toBeInstanceOf(Error);
  expect(readFileSync(`${fixture.path}.closed`, "utf8")).toBe("done");
});
it.each([
  "import sys; sys.exit(1)",
  'print("not JSON")',
  'print("x" * 2048)',
  'import json; print(json.dumps({"taskId": "01J000000000000000000000000", "generation":"a"*32}))',
])("refuses a failed or invalid helper: %s", async (source) => {
  const fixture = helper(source);
  await expect(prepareDesktopBrowser(ulid(), undefined, fixture.path)).rejects.toThrow();
});
