import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DockerRequest } from "./docker.ts";
import { desktopSpec, streamOptions } from "./spec.ts";
import { ComputerSystemState } from "./system-state.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const name = (entry: string) => entry.slice(0, entry.indexOf("="));
// Docker's rule for a commit and for a container made from an image alike: the request's
// variables, then each of the base's that the request does not name.
const merged = (request: string[] | undefined, base: string[]) =>
  request?.length
    ? [...request, ...base.filter((entry) => !request.some((own) => name(own) === name(entry)))]
    : base;

it("commits a recovery snapshot with no stream password or desktopd token in its environment", async () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-system-state-"));
  homes.push(home);
  const record = {
    ...sampleRecord(),
    ownership: {
      desktop: "desktop-1",
      gate: "gate-1",
      internalNetwork: "n-1",
      egressNetwork: "n-2",
    },
  };
  const base = `sha256:${"a".repeat(64)}`;
  const snapshot = `sha256:${"b".repeat(64)}`;
  const spec = desktopSpec(record, base, streamOptions());
  const container = {
    Id: "desktop-1",
    Image: base,
    State: { Running: false, Paused: false },
    Config: { Env: [...spec.Env, "PATH=/usr/bin"], Labels: spec.Labels },
  };
  let image: { Env: string[]; Labels: Record<string, string> } | undefined;
  const docker = {
    request: async <T>(req: DockerRequest): Promise<T> => {
      if (req.method === "GET" && req.path === "/containers/desktop-1/json") return container as T;
      if (req.method === "POST" && req.path === "/commit") {
        const body = req.body as { Env?: string[]; Labels?: Record<string, string> };
        image = {
          Env: merged(body.Env, container.Config.Env),
          Labels: { ...container.Config.Labels, ...body.Labels },
        };
        return { Id: snapshot } as T;
      }
      if (req.path === `/images/${encodeURIComponent(snapshot)}/json`)
        return { Id: snapshot, Config: image } as T;
      if (req.path === `/volumes/${encodeURIComponent(record.docker.homeVolume)}`)
        return {
          Name: record.docker.homeVolume,
          Labels: { "localdot.cell": record.id, "localdot.role": "home" },
        } as T;
      throw new Error(`Unexpected request: ${req.method} ${req.path}`);
    },
  };
  await new ComputerSystemState(home, docker, "copy").capture(record);
  const env = image?.Env ?? [];
  expect(env).toEqual(
    expect.arrayContaining([
      "PASSWORD=",
      "LOCALDOT_DESKTOPD_TOKEN=",
      "PATH=/usr/bin",
      `LOCALDOT_CELL_ID=${record.id}`,
    ]),
  );
  for (const token of Object.values(record.tokens)) expect(env.join("\n")).not.toContain(token);
  // The computer made from the snapshot sets its own again when it is created.
  const restored = {
    ...sampleRecord(),
    tokens: { desktopd: "e".repeat(43), stream: "t".repeat(43) },
  };
  const started = merged(desktopSpec(restored, snapshot, streamOptions()).Env, env);
  expect(
    started.filter((entry) => ["PASSWORD", "LOCALDOT_DESKTOPD_TOKEN"].includes(name(entry))),
  ).toEqual([`LOCALDOT_DESKTOPD_TOKEN=${"e".repeat(43)}`, `PASSWORD=${"t".repeat(43)}`]);
});
