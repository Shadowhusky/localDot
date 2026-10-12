import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { imageRef } from "../../../../packages/protocol/src/release.ts";
import { ComputerFences } from "../../../daemon/src/agent/safety/fences.ts";
import { ComputerResetHolds } from "../../../daemon/src/cells/reset-holds.ts";
import { verifyDesktopRuntimeImages } from "../../../daemon/src/cells/runtime-image-check.ts";
import {
  prepareDesktopRuntime,
  type RuntimeUpdateHost,
} from "../../../daemon/src/cells/runtime-update.ts";
import { RuntimeUpdateStore } from "../../../daemon/src/cells/runtime-update-store.ts";
import { desktopEnv, streamOptions } from "../../../daemon/src/cells/spec.ts";
import { decodeRecord } from "../../../daemon/src/cells/store.ts";
import { SystemMigration } from "../../../daemon/src/cells/system-migration.ts";
import type { CellRecord, StoredCellRecord } from "../../../daemon/src/cells/types.ts";
import { containInstalledContainers, readContainerInventory } from "./container-containment.ts";
import { installImageClient } from "./image-client.ts";
import { assertNativeRetired } from "./native-retirement.ts";
import { prepareReleaseImages } from "./prepare-images.ts";
import { privateRecordStore } from "./private-record.ts";
import { readInstalledRelease } from "./promote-release.ts";
import { installRuntimeClient } from "./runtime-client.ts";
import { checkedServiceConfiguration, serviceJournalStore } from "./service-journal.ts";
import { withStoppedServiceLeases } from "./service-retirement.ts";
import { updateJournalStore } from "./update-journal.ts";

const failure = () => new Error("Installed computer runtime preparation is incomplete.");

/** Called under the verified-helper installation mutex after physical service/container shutdown,
 * before any selected-release bootstrap. Reuses exact home/networks/tokens; browser startup already
 * retires its prior executable graph and retains its profile before admitting a fresh browser. */
export async function prepareInstalledRuntimes(
  input: ServiceConfiguration,
  verifiedKeydPath: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const config = checkedServiceConfiguration(structuredClone(input));
    const service = await serviceJournalStore(config.settings).read();
    if (!service) {
      // First-install lifecycle persists intent before bootstrap. Existing computers are never
      // migrated without the service journal and its stopped process-lease authority.
      const inventory = await readContainerInventory(config.settings.home);
      if (inventory.invalid || inventory.records.length || inventory.updates?.length)
        throw failure();
      await assertNativeRetired(config.settings.home, signal);
      signal.throwIfAborted();
      return;
    }
    if (
      service.configuration.settings.ownerId !== config.settings.ownerId ||
      service.configuration.settings.dockerSocket !== config.settings.dockerSocket
    )
      throw failure();
    await withStoppedServiceLeases(
      service.configuration,
      verifiedKeydPath,
      signal,
      async (recheck) => {
        // A durable stopped receipt is historical; freshly contain browser, brain and desktop
        // executors before preparing any computer, including ordinary `up` after a prior stop.
        await containInstalledContainers(service.configuration, signal);
        await recheck();
        const home = config.settings.home;
        const retirement = () => {
          const holds = new ComputerResetHolds(home),
            bindings = holds.records();
          const fences = new ComputerFences(home).records();
          return { bindings, fences };
        };
        const denied = retirement(),
          retired = new Set([
            ...denied.bindings.map((r) => r.oldCellId),
            ...denied.fences.map((r) => r.cellId),
          ]);
        const journal = new RuntimeUpdateStore(home);
        const inventory = await readContainerInventory(home);
        if (inventory.invalid) throw failure();
        const records = new Map(inventory.records.map((r) => [r.id, structuredClone(r)]));
        let journals = inventory.updates ?? [];
        if (journals.some((j) => !records.has(j.source.id) && !retired.has(j.source.id)))
          throw failure();
        const release = await readInstalledRelease(config.settings.state, config.release, signal);
        const target = {
          gate: imageRef(release.manifest.images.gate),
          desktop: imageRef(release.manifest.images.desktop),
        };
        const client = installImageClient(config.settings.dockerSocket);
        const inspectOnly = {
          ...client,
          pull: async (): Promise<never> => {
            throw failure();
          },
        };
        const images = await prepareReleaseImages(release.manifest, inspectOnly, signal);
        const docker = installRuntimeClient(config.settings.dockerSocket, signal);
        const update = await updateJournalStore(config.settings.state).read();
        const allowed = [release];
        for (const pending of journals.filter((j) => !retired.has(j.source.id))) {
          if (equal(pending.images, target)) continue;
          let authorized = false;
          for (const identity of [update?.previous, update?.candidate]) {
            if (!identity) continue;
            let other = allowed.find((r) => equal(r.record.identity, identity));
            if (!other) {
              other = await readInstalledRelease(config.settings.state, identity, signal);
              allowed.push(other);
            }
            const pins = {
              gate: imageRef(other.manifest.images.gate),
              desktop: imageRef(other.manifest.images.desktop),
            };
            if (equal(pending.images, pins)) {
              const checked = await prepareReleaseImages(other.manifest, inspectOnly, signal);
              if (checked.engineId !== images.engineId) throw failure();
              authorized = true;
              break;
            }
          }
          if (!authorized) throw failure();
        }
        async function stable(active?: string) {
          signal.throwIfAborted();
          await recheck();
          if (!equal(retirement(), denied)) throw failure();
          const current = await readContainerInventory(home);
          if (
            current.invalid ||
            !equal(current.records, [...records.values()]) ||
            !equal(
              (current.updates ?? []).filter((j) => j.source.id !== active),
              journals.filter((j) => j.source.id !== active),
            )
          )
            throw failure();
          const engine = await client.engine(signal);
          if (
            engine.id !== images.engineId ||
            engine.operatingSystem !== "linux" ||
            engine.architecture !== "arm64"
          )
            throw failure();
          if (!equal(await updateJournalStore(config.settings.state).read(), update))
            throw failure();
          signal.throwIfAborted();
        }
        const stream = streamOptions();
        // A desktop keeps the stream mode it was created with, so a changed mode needs a new one.
        async function streamMatches(record: CellRecord): Promise<boolean> {
          const raw = await docker.request<{ Config?: { Env?: unknown } }>({
            method: "GET",
            path: `/containers/${encodeURIComponent(record.docker.desktop)}/json`,
          });
          const mode = (entry: unknown) =>
            typeof entry === "string" && entry.startsWith("SELKIES_VIDEO_FULLCOLOR=");
          const env = raw?.Config?.Env;
          return (
            Array.isArray(env) && equal(env.filter(mode), desktopEnv(record, stream).filter(mode))
          );
        }
        const host: RuntimeUpdateHost = {
          docker,
          async migrateSystem(record, target) {
            const image = await docker.request<{ Id: string }>({
              method: "GET",
              path: `/images/${encodeURIComponent(target)}/json`,
            });
            return new SystemMigration(docker, home).prepare(record, image.Id);
          },
          journal,
          signal,
          readCell: (id) => {
            const record = records.get(id);
            return record?.kind === "desktop" ? structuredClone(record) : undefined;
          },
          async saveCell(next) {
            await stable(next.id);
            const before = records.get(next.id);
            if (before?.kind !== "desktop") throw failure();
            const store = privateRecordStore(join(home, "cells", next.id), "cell.json", {
              parse(raw: unknown): StoredCellRecord {
                const checked = decodeRecord(raw, next.id, { from: 4760, to: 4789 });
                if (!checked) throw failure();
                return checked;
              },
            });
            if (!equal(await store.read(), before)) throw failure();
            await store.save(next);
            if (!equal(await store.read(), next)) throw failure();
            records.set(next.id, structuredClone(next));
          },
          assertQuiescent: (id) => stable(id),
        };
        function remember(id: string) {
          const current = journal.read(id);
          if (!current) throw failure();
          journals = [...journals.filter((j) => j.source.id !== id), current].sort((a, b) =>
            a.source.id.localeCompare(b.source.id),
          );
        }
        await stable();
        for (const initial of records.values()) {
          if (initial.kind !== "desktop" || retired.has(initial.id)) continue;
          const id = initial.id,
            pending = journal.read(id);
          if (pending) {
            // Complete interrupted preparation while stopped, then migrate again for rollback.
            await prepareDesktopRuntime(host, {
              cellId: id,
              images: pending.images,
              fullcolor: pending.fullcolor,
            });
            remember(id);
          }
          const current = host.readCell(id);
          if (!current) throw failure();
          let matching = false;
          try {
            await verifyDesktopRuntimeImages(docker, current, target, home);
            matching = await streamMatches(current);
          } catch {
            signal.throwIfAborted();
          }
          if (!matching) {
            await prepareDesktopRuntime(host, {
              cellId: id,
              images: target,
              fullcolor: stream.fullcolor,
            });
            remember(id);
          }
          await stable();
          await verifyDesktopRuntimeImages(docker, host.readCell(id) as CellRecord, target, home);
        }
        await stable();
      },
    );
  } catch {
    throw failure();
  }
}
