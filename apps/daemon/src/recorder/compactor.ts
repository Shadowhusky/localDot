import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { recordingDirectory, type ScreenName, ULID_PATTERN } from "@localdot/protocol";
import { type DockerClient, DockerError } from "../cells/docker.ts";
import { helperOutput } from "../cells/system-migration.ts";
import { errorCode } from "../error-code.ts";
import { type RetentionPolicy, sessionStarted } from "../sessions/retention.ts";
import {
  compactionSource,
  compactTrack,
  decodeArgs,
  decodedFrames,
  ENCODED,
  encodeArgs,
  type TrackEncoder,
} from "./compaction.ts";

export const COMPACTION_ROLE = "recording-compaction";
// Dots on one computer share its Docker engine; each removes only its own helpers.
export const COMPACTION_HOME = "localdot.compaction-home";
// How often a running compaction checks whether a task has started, and how long it waits to look
// again when one has, or when Docker could not be reached.
const WATCH_MS = 2000;
export const BUSY_RETRY_MS = 60_000;
export const START_DELAY_MS = 2 * 60_000;
export const DOCKER_RETRY_MS = 10 * 60_000;
// A track this close to its age limit is left for retention.
export const EXPIRY_MARGIN_MS = 86_400_000;
const POLL_MS = 1000;
const MEMORY_BYTES = 2 * 1024 ** 3;

export interface CompactionPolicy {
  enabled: boolean;
  backfill: boolean;
}
export function compactionFromEnv(env: NodeJS.ProcessEnv = process.env): CompactionPolicy {
  return {
    enabled: env.LOCALDOT_RECORDING_COMPACTION !== "0",
    backfill: env.LOCALDOT_RECORDING_BACKFILL !== "0",
  };
}

export interface CompactorDeps {
  home: string;
  encoder: TrackEncoder & { cleanup?(): Promise<void> };
  // Tracks recorded before this run too, not only the ones that finish now.
  backfill: boolean;
  retention: RetentionPolicy;
  // A task or a change to the computer is under way: compaction waits, and stops if it started.
  busy(): boolean;
  // The task is live or one of its videos is being exported.
  inUse(sessionId: string): boolean;
  compacted(sessionId: string): void;
  now?(): number;
  minBytes?: number;
}

interface Track {
  id: string;
  screen: ScreenName;
  dir: string;
}

// Re-encodes finished recordings in the background, one track at a time, largest first, and only
// while no task runs on this computer.
export class RecordingCompactor {
  readonly #deps: CompactorDeps;
  readonly #fresh = new Set<string>();
  readonly #failed = new Set<string>();
  #running: Promise<void> | null = null;
  #again = false;
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(deps: CompactorDeps) {
    this.#deps = deps;
  }

  // Removes helpers a stopped daemon left, and leaves the first run until startup has settled.
  async start(): Promise<void> {
    try {
      await this.#deps.encoder.cleanup?.();
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 0))
        console.error("leftover recording compaction helpers could not be removed");
    }
    this.#later(START_DELAY_MS);
  }

  // A task's recording has finished.
  finished(sessionId: string): void {
    this.#fresh.add(sessionId);
    this.kick();
  }

  kick(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = null;
      if (this.#again) this.kick();
    });
  }

  // Resolves once no compaction runs or is about to.
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#abort?.abort();
    await this.idle();
  }

  #later(ms: number): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.kick(), ms);
    this.#timer.unref?.();
  }

  async #drain(): Promise<void> {
    this.#again = false;
    const changed = new Set<string>();
    while (!this.#closed) {
      if (this.#deps.busy()) return this.#later(BUSY_RETRY_MS);
      const track = this.#next(changed);
      if (!track) return;
      const abort = new AbortController();
      this.#abort = abort;
      const watch = setInterval(() => {
        if (
          this.#closed ||
          this.#deps.busy() ||
          this.#deps.inUse(track.id) ||
          !existsSync(track.dir)
        )
          abort.abort();
      }, WATCH_MS);
      watch.unref?.();
      const name = `recording ${track.id} (${track.screen})`;
      try {
        const result = await compactTrack(
          track.dir,
          this.#deps.encoder,
          abort.signal,
          this.#deps.minBytes,
        );
        if (result.outcome === "changed") changed.add(track.dir);
        else this.#deps.compacted(track.id);
        if (result.outcome === "compacted")
          console.error(
            `${name} was compacted from ${mib(result.sourceBytes)} to ${mib(result.bytes)}`,
          );
        if (result.outcome === "kept") console.error(`${name} keeps its video: ${result.reason}`);
      } catch (error) {
        if (abort.signal.aborted) return this.#later(BUSY_RETRY_MS);
        if (
          error instanceof DockerError &&
          (error.status === 0 || error.status >= 500 || error.timedOut)
        )
          return this.#later(DOCKER_RETRY_MS);
        this.#failed.add(track.dir);
        console.error(`${name} could not be compacted (${errorCode(error)})`);
      } finally {
        clearInterval(watch);
        this.#abort = null;
      }
    }
  }

  #next(skip: ReadonlySet<string>): Track | null {
    const root = join(this.#deps.home, "sessions");
    const now = this.#deps.now?.() ?? Date.now();
    const oldest = now - (this.#deps.retention.maxAgeDays * 86_400_000 - EXPIRY_MARGIN_MS);
    let ids: string[];
    try {
      ids = this.#deps.backfill ? readdirSync(root) : [...this.#fresh];
    } catch {
      return null;
    }
    let best: Track | null = null;
    let bestBytes = 0;
    for (const id of ids) {
      if (!ULID_PATTERN.test(id) || this.#deps.inUse(id)) continue;
      try {
        if (sessionStarted(join(root, id)) < oldest) continue;
      } catch {
        continue;
      }
      for (const screen of ["desktop", "browser"] as const) {
        const dir = join(root, id, recordingDirectory(screen));
        if (this.#failed.has(dir) || skip.has(dir)) continue;
        const size = compactionSource(dir, this.#deps.minBytes)?.size ?? 0;
        if (size > bestBytes) {
          best = { id, screen, dir };
          bestBytes = size;
        }
      }
    }
    return best;
  }
}

function mib(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export class HelperFailed extends Error {
  readonly code: string;
  constructor(exitCode: number) {
    super(`the compaction helper exited with ${exitCode}`);
    this.name = "HelperFailed";
    this.code = `helper exit ${exitCode}`;
  }
}

type Mount = { Type: "bind"; Source: string; Target: string; ReadOnly: boolean };
const bind = (source: string, target: string, readOnly: boolean): Mount => ({
  Type: "bind",
  Source: source,
  Target: target,
  ReadOnly: readOnly,
});

// ffmpeg from the desktop image, in a container with no network, one CPU at the lowest weight and
// priority, a read-only system, and only the recording's own files.
export class DockerTrackEncoder implements TrackEncoder {
  readonly #labels: Record<string, string>;
  constructor(
    private readonly docker: Pick<DockerClient, "request">,
    private readonly image: string,
    home: string,
  ) {
    this.#labels = {
      "localdot.role": COMPACTION_ROLE,
      [COMPACTION_HOME]: createHash("sha256").update(home).digest("hex").slice(0, 16),
    };
  }

  async encode(video: string, outDir: string, signal: AbortSignal): Promise<void> {
    await this.#run(
      [bind(video, "/in/video.mp4", true), bind(outDir, "/out", false)],
      encodeArgs("/in/video.mp4", `/out/${ENCODED}`),
      signal,
    );
  }

  async decode(video: string, signal: AbortSignal): Promise<number> {
    const output = await this.#run(
      [bind(video, "/in/video.mp4", true)],
      decodeArgs("/in/video.mp4"),
      signal,
    );
    return decodedFrames(output.toString("utf8"));
  }

  // Helpers a stopped daemon left behind.
  async cleanup(): Promise<void> {
    const left = await this.docker.request<{ Id: string }[]>({
      method: "GET",
      path: "/containers/json",
      query: {
        all: "true",
        filters: JSON.stringify({
          label: Object.entries(this.#labels).map(([key, value]) => `${key}=${value}`),
        }),
      },
    });
    for (const container of left) await this.#remove(container.Id);
  }

  async #remove(id: string): Promise<void> {
    await this.docker
      .request({
        method: "DELETE",
        path: `/containers/${encodeURIComponent(id)}`,
        query: { force: "true", v: "true" },
      })
      .catch((error: unknown) => {
        if (!(error instanceof DockerError && error.status === 404))
          console.error("a recording compaction helper could not be removed");
      });
  }

  async #run(mounts: Mount[], args: string[], signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const made = await this.docker.request<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      body: {
        Image: this.image,
        ...(uid !== undefined && gid !== undefined ? { User: `${uid}:${gid}` } : {}),
        Entrypoint: ["nice", "-n", "19", "ffmpeg"],
        Cmd: args,
        NetworkDisabled: true,
        Labels: this.#labels,
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Memory: MEMORY_BYTES,
          MemorySwap: MEMORY_BYTES,
          NanoCpus: 1_000_000_000,
          CpuShares: 2,
          PidsLimit: 64,
          Mounts: mounts,
        },
      },
    });
    const route = `/containers/${encodeURIComponent(made.Id)}`;
    try {
      await this.docker.request({ method: "POST", path: `${route}/start` });
      let state: { Running: boolean; ExitCode: number };
      do {
        await sleep(POLL_MS, undefined, { signal });
        state = (
          await this.docker.request<{ State: typeof state }>({
            method: "GET",
            path: `${route}/json`,
          })
        ).State;
      } while (state.Running);
      if (state.ExitCode !== 0) throw new HelperFailed(state.ExitCode);
      return helperOutput(
        await this.docker.request<Buffer>({
          method: "GET",
          path: `${route}/logs`,
          query: { stdout: "true", stderr: "true" },
          response: "buffer",
        }),
      );
    } finally {
      await this.#remove(made.Id);
    }
  }
}
