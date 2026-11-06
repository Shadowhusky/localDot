import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerError, type DockerRequest } from "./cells/docker.ts";
import { browserInUseCheck } from "./doctor-browser.ts";

const BASE = "ghcr.io/o/localdot-browser@sha256:aaaa";
const BASE_ID = `sha256:${"b".repeat(64)}`;
const CHROME_ID = `sha256:${"c".repeat(64)}`;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(record?: unknown) {
  const folder = mkdtempSync(join(tmpdir(), "doctor-browser-"));
  homes.push(folder);
  if (record) writeFileSync(join(folder, "browser-engine.json"), JSON.stringify(record));
  return folder;
}

function frame(text: string) {
  const body = Buffer.from(`${text}\n`);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function docker(version: string, images: Record<string, unknown> = {}) {
  return {
    request: async <T = undefined>({ path }: DockerRequest): Promise<T> => {
      if (path === "/containers/create") return { Id: "1".repeat(64) } as T;
      if (path.endsWith("/wait")) return { StatusCode: 0 } as T;
      if (path.endsWith("/logs")) return frame(version) as T;
      if (path.startsWith("/images/")) {
        const image = images[decodeURIComponent(path.split("/")[2] ?? "")];
        if (!image) throw new DockerError(404, "no image", path);
        return image as T;
      }
      return undefined as T;
    },
  };
}

const CHROME = {
  image: CHROME_ID,
  base: BASE,
  baseId: BASE_ID,
  version: "157.0.8103.38",
  installedAt: "2026-11-05T00:00:00.000Z",
};
const base = { Id: BASE_ID, Os: "linux", Architecture: "arm64", RootFS: { Layers: ["sha256:l"] } };
const chrome = {
  Id: CHROME_ID,
  Os: "linux",
  Architecture: "arm64",
  RootFS: { Layers: ["sha256:l", "sha256:chrome"] },
  Config: {
    Labels: { "localdot.chrome-base": BASE, "localdot.chrome-version": "157.0.8103.38" },
  },
};

describe("the doctor's report of which browser is in use", () => {
  it("names Chromium for someone who hasn't chosen, and where Chrome is", async () => {
    const check = await browserInUseCheck(docker("Chromium 154.0.8037.57"), home(), BASE);
    expect(check).toMatchObject({ name: "browser-in-use", ok: true });
    expect(check.detail).toContain("Chromium 154.0.8037.57");
    expect(check.detail).toContain("Settings → Accounts");
  });

  it("names Chrome's version, where it came from and when its terms were accepted", async () => {
    const check = await browserInUseCheck(
      docker("", { [BASE]: base, [CHROME_ID]: chrome }),
      home({
        v: 1,
        choice: "chrome",
        acceptedAt: "2026-11-04T00:00:00.000Z",
        chrome: CHROME,
        handOver: "done",
      }),
      BASE,
    );
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("Google Chrome 157.0.8103.38");
    expect(check.detail).toContain("from Google");
    expect(check.detail).toContain("2026-11-04");
  });

  it("says Chrome will be installed again when its image no longer matches", async () => {
    const check = await browserInUseCheck(
      docker("", { [BASE]: base }),
      home({ v: 1, choice: "chrome", chrome: CHROME, handOver: "done" }),
      BASE,
    );
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/installs it again/u);
  });

  it("gives the reason Chromium is in use when Chrome was chosen", async () => {
    const check = await browserInUseCheck(
      docker("Chromium 154.0.8037.57"),
      home({
        v: 1,
        choice: "chrome",
        problem: { text: "Google's signing key didn't match.", at: "2026-11-04T00:00:00.000Z" },
      }),
      BASE,
    );
    expect(check.detail).toBe("Chromium 154.0.8037.57. Google's signing key didn't match.");
  });

  it("recognises an image built with Chrome in it", async () => {
    const check = await browserInUseCheck(docker("Google Chrome 156.0.8078.79 "), home(), BASE);
    expect(check.detail).toBe("Google Chrome 156.0.8078.79, built into this browser image.");
  });

  it("never fails the doctor when Docker can't say", async () => {
    const check = await browserInUseCheck(
      {
        request: async () => {
          throw new DockerError(0, "unreachable", "/containers/create");
        },
      },
      home(),
      BASE,
    );
    expect(check.ok).toBe(true);
  });
});
