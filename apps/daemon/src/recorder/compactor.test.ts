import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_RECORDING_DIR, RECORDING_DIR, RECORDING_VIDEO, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerRequest } from "../cells/docker.ts";
import { COMPACTION_DIR } from "./compaction.ts";
import {
  COMPACTION_HOME,
  COMPACTION_ROLE,
  type CompactorDeps,
  compactionFromEnv,
  DockerTrackEncoder,
  EXPIRY_MARGIN_MS,
  RecordingCompactor,
} from "./compactor.ts";
import { readManifest } from "./manifest.ts";
import { FakeEncoder, type FakeEncoderOptions } from "./testing/fake-encoder.ts";
import { burstTimes, TRACK_SYNTH, writeFinishedTrack } from "./testing/finished-track.ts";

const DAY = 86_400_000;
const roots: string[] = [];
const compactors: RecordingCompactor[] = [];
afterEach(async () => {
  for (const compactor of compactors.splice(0)) await compactor.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const halfTheGops = (index: number) => Math.floor(index / TRACK_SYNTH.keyEvery) % 2 === 0;

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "local dot's compactor-"));
  roots.push(dir);
  return dir;
}

async function task(
  root: string,
  frames: number,
  opts: { browser?: boolean; ageDays?: number } = {},
): Promise<string> {
  const id = ulid();
  const session = join(root, "sessions", id);
  const times = burstTimes(frames);
  for (const name of opts.browser ? [RECORDING_DIR, BROWSER_RECORDING_DIR] : [RECORDING_DIR])
    await writeFinishedTrack(join(session, name), times, (times.at(-1) as number) + 1);
  writeFileSync(
    join(session, "session.json"),
    JSON.stringify({ startedAt: new Date(Date.now() - (opts.ageDays ?? 0) * DAY).toISOString() }),
  );
  return id;
}

function compactor(root: string, deps: Partial<CompactorDeps> & { encoder: FakeEncoder }) {
  const compacted: string[] = [];
  const made = new RecordingCompactor({
    home: root,
    backfill: true,
    retention: { maxBytes: 20 * 1024 ** 3, maxAgeDays: 30 },
    busy: () => false,
    inUse: () => false,
    compacted: (id) => compacted.push(id),
    minBytes: 1,
    ...deps,
  });
  compactors.push(made);
  return { compactor: made, compacted };
}

const compactedAt = (root: string, id: string, name = RECORDING_DIR) => {
  const read = readManifest(join(root, "sessions", id, name));
  return read?.ok ? read.manifest.compacted !== undefined : false;
};
const encoder = (options: FakeEncoderOptions = {}) =>
  new FakeEncoder({ keep: halfTheGops, ...options });

describe("background compaction", () => {
  it("compacts every finished track one at a time, the largest first", async () => {
    const root = home();
    const small = await task(root, 60);
    const large = await task(root, 180, { browser: true });
    const medium = await task(root, 120);
    let running = 0;
    const fake = encoder({
      before: () => {
        running++;
        expect(running).toBe(1);
      },
      after: () => {
        running--;
      },
    });
    const { compactor: made, compacted } = compactor(root, { encoder: fake });
    await made.start();
    made.kick();
    await made.idle();
    expect(fake.encoded.map((video) => video.split("/sessions/")[1])).toEqual([
      `${large}/${RECORDING_DIR}/${RECORDING_VIDEO}`,
      `${large}/${BROWSER_RECORDING_DIR}/${RECORDING_VIDEO}`,
      `${medium}/${RECORDING_DIR}/${RECORDING_VIDEO}`,
      `${small}/${RECORDING_DIR}/${RECORDING_VIDEO}`,
    ]);
    expect(compacted).toEqual([large, large, medium, small]);
    for (const id of [small, medium, large]) expect(compactedAt(root, id)).toBe(true);
  });

  it("leaves tasks in use and recordings retention is about to expire", async () => {
    const root = home();
    const live = await task(root, 60);
    const expiring = await task(root, 60, { ageDays: 30 - EXPIRY_MARGIN_MS / DAY + 0.01 });
    const ok = await task(root, 60, { ageDays: 28 });
    const fake = encoder();
    const { compactor: made } = compactor(root, { encoder: fake, inUse: (id) => id === live });
    await made.start();
    made.kick();
    await made.idle();
    expect(fake.encoded).toHaveLength(1);
    expect(compactedAt(root, ok)).toBe(true);
    expect(compactedAt(root, live)).toBe(false);
    expect(compactedAt(root, expiring)).toBe(false);
  });

  it("waits while a task runs, and stops a compaction a task interrupts", async () => {
    const root = home();
    const id = await task(root, 60);
    let busy = true;
    const fake = encoder({
      before: async (signal) => {
        if (fake.encoded.length > 1) return;
        busy = true;
        await once(signal, "abort");
      },
    });
    const { compactor: made, compacted } = compactor(root, { encoder: fake, busy: () => busy });
    await made.start();
    made.kick();
    await made.idle();
    expect(fake.encoded).toHaveLength(0);
    busy = false;
    made.kick();
    await made.idle();
    expect(fake.encoded).toHaveLength(1);
    expect(compacted).toEqual([]);
    expect(compactedAt(root, id)).toBe(false);
    expect(existsSync(join(root, "sessions", id, RECORDING_DIR, COMPACTION_DIR))).toBe(false);
    busy = false;
    made.kick();
    await made.idle();
    expect(compacted).toEqual([id]);
    expect(compactedAt(root, id)).toBe(true);
  });

  it("stops encoding a task deleted meanwhile and leaves it deleted", async () => {
    const root = home();
    const id = await task(root, 60);
    const session = join(root, "sessions", id);
    const fake = encoder({
      before: async (signal) => {
        rmSync(session, { recursive: true });
        await once(signal, "abort");
      },
    });
    const { compactor: made, compacted } = compactor(root, { encoder: fake });
    await made.start();
    made.kick();
    await made.idle();
    expect(compacted).toEqual([]);
    expect(existsSync(session)).toBe(false);
  });

  it("without backfill compacts only the recordings that finish from now on", async () => {
    const root = home();
    const earlier = await task(root, 60);
    const fresh = await task(root, 60);
    const fake = encoder();
    const { compactor: made } = compactor(root, { encoder: fake, backfill: false });
    await made.start();
    made.kick();
    await made.idle();
    expect(fake.encoded).toHaveLength(0);
    made.finished(fresh);
    await made.idle();
    expect(compactedAt(root, fresh)).toBe(true);
    expect(compactedAt(root, earlier)).toBe(false);
  });

  it("does not try a track that failed again until the next start", async () => {
    const root = home();
    const id = await task(root, 60);
    const fake = encoder({
      before: () => {
        throw new Error("ffmpeg failed");
      },
    });
    const { compactor: made } = compactor(root, { encoder: fake });
    await made.start();
    made.kick();
    await made.idle();
    made.kick();
    await made.idle();
    expect(fake.encoded).toHaveLength(1);
    expect(compactedAt(root, id)).toBe(false);
  });

  it("is on by default and can be switched off, or kept to new recordings", () => {
    expect(compactionFromEnv({})).toEqual({ enabled: true, backfill: true });
    expect(compactionFromEnv({ LOCALDOT_RECORDING_COMPACTION: "0" }).enabled).toBe(false);
    expect(compactionFromEnv({ LOCALDOT_RECORDING_BACKFILL: "0" }).backfill).toBe(false);
  });
});

describe("the helper container", () => {
  function docker(states: { Running: boolean; ExitCode: number }[], stdout = "") {
    const calls: DockerRequest[] = [];
    const frame = Buffer.alloc(8);
    frame[0] = 1;
    frame.writeUInt32BE(Buffer.byteLength(stdout), 4);
    return {
      calls,
      request: async <T>(req: DockerRequest): Promise<T> => {
        calls.push(req);
        if (req.path === "/containers/create") return { Id: "helper" } as T;
        if (req.path === "/containers/json") return [{ Id: "left" }] as T;
        if (req.path.endsWith("/json")) return { State: states.shift() } as T;
        if (req.path.endsWith("/logs")) return Buffer.concat([frame, Buffer.from(stdout)]) as T;
        return undefined as T;
      },
    };
  }

  it("runs ffmpeg offline, read-only, at the lowest priority, with only the recording's files", async () => {
    const fake = docker([{ Running: false, ExitCode: 0 }]);
    await new DockerTrackEncoder(fake, "localdot/desktop:dev", "/home").encode(
      "/home/sessions/x/recording/video.mp4",
      "/home/sessions/x/recording/.compact",
      new AbortController().signal,
    );
    const create = fake.calls[0];
    const body = create?.body as Record<string, never> & {
      HostConfig: Record<string, unknown>;
      Entrypoint: string[];
      Labels: Record<string, string>;
    };
    expect(body.Image).toBe("localdot/desktop:dev");
    expect(body.Entrypoint).toEqual(["nice", "-n", "19", "ffmpeg"]);
    expect(body.NetworkDisabled).toBe(true);
    expect(body.Labels).toEqual({
      "localdot.role": COMPACTION_ROLE,
      [COMPACTION_HOME]: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(body.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NanoCpus: 1_000_000_000,
      CpuShares: 2,
      Mounts: [
        {
          Type: "bind",
          Source: "/home/sessions/x/recording/video.mp4",
          Target: "/in/video.mp4",
          ReadOnly: true,
        },
        {
          Type: "bind",
          Source: "/home/sessions/x/recording/.compact",
          Target: "/out",
          ReadOnly: false,
        },
      ],
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/containers/helper",
      query: { force: "true" },
    });
  });

  it("reports decoded frames, fails on a nonzero exit, and removes the helper when cancelled", async () => {
    const decoded = docker([{ Running: false, ExitCode: 0 }], "frame=12\nprogress=end\n");
    expect(
      await new DockerTrackEncoder(decoded, "image", "/home").decode(
        "/v.mp4",
        new AbortController().signal,
      ),
    ).toBe(12);

    const failed = docker([{ Running: false, ExitCode: 1 }]);
    await expect(
      new DockerTrackEncoder(failed, "image", "/home").decode(
        "/v.mp4",
        new AbortController().signal,
      ),
    ).rejects.toThrow("exited with 1");
    expect(failed.calls.at(-1)?.method).toBe("DELETE");

    const cancelled = docker(Array(100).fill({ Running: true, ExitCode: 0 }));
    const controller = new AbortController();
    const running = new DockerTrackEncoder(cancelled, "image", "/home").encode(
      "/v.mp4",
      "/out",
      controller.signal,
    );
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(cancelled.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/containers/helper" });

    const leftovers = docker([]);
    await new DockerTrackEncoder(leftovers, "image", "/home").cleanup();
    const filters = JSON.parse(leftovers.calls[0]?.query?.filters ?? "{}").label as string[];
    expect(filters).toContain(`localdot.role=${COMPACTION_ROLE}`);
    expect(filters.some((label) => label.startsWith(`${COMPACTION_HOME}=`))).toBe(true);
    const other = docker([]);
    await new DockerTrackEncoder(other, "image", "/other-home").cleanup();
    expect(other.calls[0]?.query?.filters).not.toBe(leftovers.calls[0]?.query?.filters);
    expect(leftovers.calls[1]).toMatchObject({ method: "DELETE", path: "/containers/left" });
  });
});
