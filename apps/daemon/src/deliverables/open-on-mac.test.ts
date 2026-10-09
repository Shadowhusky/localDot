import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type MacOpener, macName, openOnMac, taskFolder } from "./open-on-mac.ts";
import { cleanFixtures, deliverablesFixture, PORT } from "./testing/fixture.ts";

afterEach(cleanFixtures);
const LOOPBACK = {
  incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 5, remoteFamily: "IPv4" } },
};
const ORIGIN = { origin: `http://127.0.0.1:${PORT}` };
function post(
  f: ReturnType<typeof deliverablesFixture>,
  path: string,
  headers: Record<string, string>,
  env: unknown = LOOPBACK,
  host = `127.0.0.1:${PORT}`,
) {
  return f.app.request(
    `http://${host}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", host, ...headers },
      body: JSON.stringify({ version: 1 }),
    },
    env,
  );
}

describe("open on Mac", () => {
  it("refuses a request that came through a front, before touching anything", async () => {
    const f = deliverablesFixture();
    const id = f.task();
    f.result(id, { "report.pdf": "%PDF" });
    const path = `/api/agent/sessions/${id}/files/report.pdf/open`;
    const front = "mac.tailnet.example";
    const cases: [Record<string, string>, unknown, string | undefined][] = [
      [{ origin: `https://${front}` }, LOOPBACK, front],
      [{ ...ORIGIN, "x-forwarded-for": "100.64.0.2" }, LOOPBACK, undefined],
      [{ ...ORIGIN, forwarded: "for=100.64.0.2" }, LOOPBACK, undefined],
      [{ ...ORIGIN, "tailscale-user-login": "someone@example.com" }, LOOPBACK, undefined],
      [{ ...ORIGIN, "sec-fetch-site": "cross-site" }, LOOPBACK, undefined],
      [{}, LOOPBACK, undefined],
      [ORIGIN, { incoming: { socket: { remoteAddress: "100.64.0.2" } } }, undefined],
      [ORIGIN, {}, undefined],
    ];
    for (const [headers, env, host] of cases)
      expect((await post(f, path, headers, env, host)).status, JSON.stringify(headers)).toBe(403);
    expect(readdirSync(f.downloads)).toEqual([]);
    expect(f.launched).toEqual([]);
  });
  it("copies to Downloads/localDot/<task>, marks it downloaded and opens it, from loopback", async () => {
    const f = deliverablesFixture();
    const id = f.task("Monthly report: Q3/Q4");
    f.result(id, { "report.pdf": "%PDF-1" });
    const res = await post(f, `/api/agent/sessions/${id}/files/report.pdf/open`, ORIGIN);
    expect(res.status).toBe(200);
    const folder = `Monthly report Q3 Q4 (${id.slice(-6).toLowerCase()})`;
    const dest = join(realpathSync(f.downloads), "localDot", folder, "report.pdf");
    expect(await res.json()).toEqual({
      path: `~/Downloads/localDot/${folder}/report.pdf`,
      reused: false,
    });
    expect(readFileSync(dest, "utf8")).toBe("%PDF-1");
    expect(f.quarantined).toEqual([dest]);
    expect(f.launched).toEqual([dest]);
    const again = await post(f, `/api/agent/sessions/${id}/files/report.pdf/open`, ORIGIN);
    expect(await again.json()).toMatchObject({ reused: true });
    expect(f.launched).toEqual([dest, dest]);
  });
  it("removes a copy it could not mark as downloaded, so the next Open marks a fresh one", async () => {
    const f = deliverablesFixture();
    const source = join(f.home, "report.pdf");
    writeFileSync(source, "%PDF-1");
    const quarantined: string[] = [];
    const launched: string[] = [];
    let refuse = true;
    const opener: MacOpener = {
      downloads: f.downloads,
      platform: "darwin",
      quarantine: async (p) => {
        if (refuse) throw new Error("xattr failed");
        quarantined.push(p);
      },
      launch: async (p) => void launched.push(p),
    };
    const file = { name: "report.pdf", label: 1, newest: true };
    const task = { title: "T", sessionId: ulid() };
    await expect(openOnMac(opener, source, file, task)).rejects.toThrow("xattr failed");
    expect(launched).toEqual([]);
    refuse = false;
    const opened = await openOnMac(opener, source, file, task);
    expect(opened.reused).toBe(false);
    expect(quarantined).toEqual([opened.path]);
    expect(launched).toEqual([opened.path]);
  });
  it("never replaces a file already in Downloads and refuses kinds that could run", async () => {
    const f = deliverablesFixture();
    const id = f.task("T");
    f.result(id, { "notes.txt": "dot's version", "run.command": "echo hi" });
    const dir = join(realpathSync(f.downloads), "localDot", `T (${id.slice(-6).toLowerCase()})`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "the user's edits");
    expect((await post(f, `/api/agent/sessions/${id}/files/notes.txt/open`, ORIGIN)).status).toBe(
      200,
    );
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("the user's edits");
    expect(readFileSync(join(dir, "notes (2).txt"), "utf8")).toBe("dot's version");
    expect((await post(f, `/api/agent/sessions/${id}/files/run.command/open`, ORIGIN)).status).toBe(
      415,
    );
    expect(f.launched).toEqual([join(dir, "notes (2).txt")]);
  });
  it("names an older version after its label and refuses a linked localDot folder", async () => {
    const f = deliverablesFixture();
    const id = f.task("T");
    f.result(id, { "a.csv": "1\n" });
    f.result(id, { "a.csv": "2\n" });
    expect(
      await (await post(f, `/api/agent/sessions/${id}/files/a.csv/open`, ORIGIN)).json(),
    ).toMatchObject({
      path: expect.stringMatching(/\/a \(v1\)\.csv$/),
    });
    const g = deliverablesFixture();
    const other = g.task("T");
    g.result(other, { "a.pdf": "%PDF" });
    symlinkSync(g.home, join(g.downloads, "localDot"));
    expect((await post(g, `/api/agent/sessions/${other}/files/a.pdf/open`, ORIGIN)).status).toBe(
      409,
    );
    expect(g.launched).toEqual([]);
  });
  it("makes folder and file names safe in any script", () => {
    expect(taskFolder("報告: 第3季/第4季", "01JXYZ00000000000000ABC123")).toBe(
      "報告 第3季 第4季 (abc123)",
    );
    expect(taskFolder("../../etc", "01JXYZ00000000000000ABC123")).toBe("etc (abc123)");
    expect(taskFolder(null, "01JXYZ00000000000000ABC123")).toBe("Task (abc123)");
    expect(macName("report.xlsx", 2, false, 1)).toBe("report (v2).xlsx");
    expect(macName("report.xlsx", 3, true, 2)).toBe("report (2).xlsx");
  });
});
