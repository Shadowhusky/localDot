import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DockerError, type DockerRequest } from "./docker.ts";
import { ComputerSystemState, snapshotOf } from "./system-state.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const hex = (n: number) => n.toString(16).padStart(64, "0");

describe("snapshotOf", () => {
  it("prefers a recorded system base over inherited snapshot labels", () => {
    expect(snapshotOf({ "localdot.snapshot": "A" })).toBe("A");
    expect(snapshotOf({ "localdot.snapshot": "A", "localdot.system-base": hex(1) })).toBe(
      undefined,
    );
    expect(snapshotOf({ "localdot.snapshot": "" })).toBe(undefined);
    expect(snapshotOf(undefined)).toBe(undefined);
  });
});

describe("ComputerSystemState.readImage", () => {
  it("needs only the snapshot image, not its retired computer's home volume", async () => {
    const home = mkdtempSync(join(tmpdir(), "localdot-system-labels-"));
    homes.push(home);
    const cellId = ulid();
    const labels = { "localdot.snapshot": cellId, "localdot.snapshot-source": "source" };
    const docker = {
      request: async <T>(req: DockerRequest): Promise<T> => {
        if (req.path === `/images/${encodeURIComponent(`sha256:${hex(2)}`)}/json`)
          return { Id: `sha256:${hex(2)}`, Config: { Labels: labels } } as T;
        throw new DockerError(404, "absent", req.path);
      },
    };
    const state = new ComputerSystemState(home, docker, "copy");
    const snapshot = {
      cellId,
      container: "source",
      image: `sha256:${hex(2)}`,
      baseImage: `sha256:${hex(3)}`,
      homeVolume: "purged-home",
    };
    state.records.write(cellId, snapshot);
    await expect(state.readImage(cellId)).resolves.toEqual(snapshot);
    // Recovery copies the home, so a full read still requires it.
    await expect(state.read(cellId)).rejects.toThrow();
    labels["localdot.snapshot-source"] = "other";
    await expect(state.readImage(cellId)).rejects.toThrow();
  });
});
