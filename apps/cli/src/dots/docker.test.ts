import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "../../../../packages/protocol/src/ids.ts";
import { DockerError, type DockerRequest } from "../../../daemon/src/cells/docker.ts";
import { CellStore } from "../../../daemon/src/cells/store.ts";
import { BLANK_CREDENTIALS, ComputerSystemState } from "../../../daemon/src/cells/system-state.ts";
import { sampleRecord } from "../../../daemon/src/cells/testing/sample-record.ts";
import { readComputerImport } from "../../../daemon/src/dots/computer-import.ts";
import {
  accountsVolume,
  copySignins,
  DotDockerError,
  removeDotDocker,
  stageComputer,
} from "./docker.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dd-")));
  dirs.push(dir);
  return dir;
};
const DESKTOP = "d".repeat(64);
const HELPER = "f".repeat(64);
const COMMITTED = `sha256:${"c".repeat(64)}`;
const BASE = `sha256:${"b".repeat(64)}`;

// Docker as a record of requests, answering as an engine with one stopped computer.
function docker(options: { running?: boolean; volumes?: string[]; users?: number } = {}) {
  const requests: DockerRequest[] = [];
  const volumes = new Set(options.volumes ?? []);
  return {
    requests,
    request: async <T>(request: DockerRequest): Promise<T> => {
      requests.push(request);
      const { method, path } = request;
      const reply = (value: unknown) => value as T;
      if (method === "GET" && path === `/containers/${DESKTOP}/json`)
        return reply({
          Id: DESKTOP,
          Image: BASE,
          State: { Running: !!options.running, Paused: false },
          Config: { Labels: { "localdot.cell": cellId, "localdot.role": "desktop" } },
        });
      if (method === "POST" && path === "/commit") return reply({ Id: COMMITTED });
      if (method === "GET" && path.startsWith("/images/"))
        return reply({
          Id: COMMITTED,
          Config: {
            Labels: { "localdot.snapshot": request.path, "localdot.snapshot-source": DESKTOP },
          },
        });
      if (method === "POST" && path === "/volumes/create") {
        volumes.add((request.body as { Name: string }).Name);
        return reply({});
      }
      if (method === "GET" && path.startsWith("/volumes/")) {
        const name = decodeURIComponent(path.slice("/volumes/".length));
        if (!volumes.has(name)) throw new DockerError(404, "no such volume", path);
        return reply({ Name: name });
      }
      if (method === "GET" && path === "/volumes")
        return reply({ Volumes: [{ Name: "localdot-home-x" }] });
      if (method === "POST" && path === "/containers/create") return reply({ Id: HELPER });
      if (method === "POST" && path.endsWith("/wait")) return reply({ StatusCode: 0 });
      if (method === "GET" && path === "/containers/json")
        return reply(
          Array.from(
            { length: request.query?.filters?.includes("label") ? 1 : (options.users ?? 0) },
            () => ({ Id: "a".repeat(64) }),
          ),
        );
      if (method === "GET" && path === "/networks") return reply([{ Id: "n".repeat(64) }]);
      return reply({});
    },
  };
}
let cellId = "";

function sourceWithComputer() {
  const home = folder();
  cellId = ulid();
  new CellStore(home).save({
    ...sampleRecord(cellId),
    ownership: {
      desktop: DESKTOP,
      gate: "g".repeat(64),
      internalNetwork: "i".repeat(64),
      egressNetwork: "e".repeat(64),
    },
  });
  return home;
}

describe("copying a dot's computer", () => {
  it("saves the stopped computer with blank credentials and its home folder for the new dot", async () => {
    const source = sourceWithComputer();
    const destination = folder();
    const engine = docker();
    expect(
      await stageComputer(engine, { source, destination, desktopImage: "localdot/desktop:dev" }),
    ).toBe(true);
    const commit = engine.requests.find((request) => request.path === "/commit");
    const snapshot = readComputerImport(destination);
    expect(snapshot).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(commit?.query).toMatchObject({ container: DESKTOP, repo: "localdot/system-state" });
    expect(commit?.body).toEqual({
      Env: BLANK_CREDENTIALS,
      Labels: { "localdot.snapshot": snapshot, "localdot.snapshot-source": DESKTOP },
    });
    const helper = engine.requests.find((request) => request.path === "/containers/create");
    expect(helper?.body).toMatchObject({
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        Mounts: [
          { Source: `localdot-home-${cellId}`, Target: "/source", ReadOnly: true },
          { Source: `localdot-home-${snapshot}`, Target: "/destination" },
        ],
      },
    });
    const saved = new ComputerSystemState(destination, engine, "localdot/desktop:dev").records.read(
      snapshot ?? "",
    );
    expect(saved).toEqual({
      cellId: snapshot,
      container: DESKTOP,
      image: COMMITTED,
      baseImage: BASE,
      homeVolume: `localdot-home-${snapshot}`,
    });
  });

  it("refuses a running computer before saving anything", async () => {
    const engine = docker({ running: true });
    await expect(
      stageComputer(engine, {
        source: sourceWithComputer(),
        destination: folder(),
        desktopImage: "localdot/desktop:dev",
      }),
    ).rejects.toThrow(DotDockerError);
    expect(engine.requests.some((request) => request.path === "/commit")).toBe(false);
  });

  it("does nothing for a dot that has no computer", async () => {
    const engine = docker();
    expect(
      await stageComputer(engine, { source: folder(), destination: folder(), desktopImage: "x" }),
    ).toBe(false);
    expect(engine.requests).toEqual([]);
  });
});

describe("copying browser sign-ins", () => {
  it("copies the shared browser profile into the new dot's own, which it then owns", async () => {
    const source = folder();
    const destination = folder();
    const engine = docker({ volumes: [accountsVolume(source)] });
    expect(await copySignins(engine, { source, destination, image: "localdot/browser:dev" })).toBe(
      true,
    );
    const identity = JSON.parse(readFileSync(join(destination, "accounts-profile.json"), "utf8"));
    expect(identity).toMatchObject({ v: 1, migration: "done" });
    const created = engine.requests.find((request) => request.path === "/volumes/create");
    expect(created?.body).toEqual({
      Name: accountsVolume(destination),
      Labels: { "localdot.role": "accounts-profile", "localdot.accounts-owner": identity.owner },
    });
    const helper = engine.requests.find((request) => request.path === "/containers/create");
    expect(helper?.body).toMatchObject({
      User: "1000:1000",
      HostConfig: {
        Mounts: [
          { Source: accountsVolume(source), ReadOnly: true },
          { Source: accountsVolume(destination) },
        ],
      },
    });
  });

  it("refuses while the source's browser is open, and skips a dot with no sign-ins", async () => {
    const source = folder();
    await expect(
      copySignins(docker({ volumes: [accountsVolume(source)], users: 1 }), {
        source,
        destination: folder(),
        image: "x",
      }),
    ).rejects.toThrow("browser is open");
    expect(await copySignins(docker(), { source, destination: folder(), image: "x" })).toBe(false);
  });
});

describe("removing a dot's Docker objects", () => {
  it("removes its cells' containers, networks and volumes, its brains and its sign-ins", async () => {
    const home = sourceWithComputer();
    const engine = docker();
    await removeDotDocker(engine, home);
    const asked = engine.requests.map(
      (request) => `${request.method} ${request.path} ${JSON.stringify(request.query ?? {})}`,
    );
    expect(asked).toContain(
      `GET /containers/json ${JSON.stringify({ all: "true", filters: JSON.stringify({ label: [`localdot.cell=${cellId}`] }) })}`,
    );
    expect(asked).toContain(
      `GET /containers/json ${JSON.stringify({ all: "true", filters: JSON.stringify({ label: [`localdot.home=${home}`] }) })}`,
    );
    expect(asked).toContain(`DELETE /containers/${"a".repeat(64)} {"force":"true","v":"true"}`);
    expect(asked).toContain(`DELETE /networks/${"n".repeat(64)} {}`);
    expect(asked).toContain("DELETE /volumes/localdot-home-x {}");
    expect(asked).toContain(`DELETE /volumes/${accountsVolume(home)} {}`);
    expect(existsSync(join(home, "computer-import.json"))).toBe(false);
  });
});
