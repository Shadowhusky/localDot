import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@localdot/protocol";
import { expect, it } from "vitest";
import { DockerClient } from "./docker.ts";
import { ComputerSystemState, requireUnmodifiedSystem } from "./system-state.ts";
import type { CellRecord } from "./types.ts";

it.skipIf(process.env.LOCALDOT_DOCKER_TESTS !== "1")(
  "preserves an installed executable, dependencies, settings, system state and home across recovery",
  async () => {
    const docker = new DockerClient();
    const home = mkdtempSync(join(tmpdir(), "localdot-system-test-"));
    const sourceId = ulid(),
      targetId = ulid();
    const image = "localdot/desktop:dev";
    const sourceHome = `localdot-test-system-${sourceId}`,
      targetHome = `localdot-test-system-${targetId}`;
    const containers: string[] = [];
    let snapshot: string | undefined;
    const run = async (container: string) => {
      await docker.request({ method: "POST", path: `/containers/${container}/start` });
      const result = await docker.request<{ StatusCode: number }>({
        method: "POST",
        path: `/containers/${container}/wait`,
        timeoutMs: 60000,
      });
      expect(result.StatusCode).toBe(0);
    };
    try {
      for (const [Name, owner] of [
        [sourceHome, sourceId],
        [targetHome, targetId],
      ])
        await docker.request({
          method: "POST",
          path: "/volumes/create",
          body: { Name, Labels: { "localdot.cell": owner, "localdot.role": "home" } },
        });
      const source = await docker.request<{ Id: string }>({
        method: "POST",
        path: "/containers/create",
        body: {
          Image: image,
          User: "0:0",
          Entrypoint: ["/bin/sh", "-ec"],
          Cmd: [
            "mkdir -p /opt/preserved-app /var/lib/preserved-app /config/preserved; printf 'dependency' >/opt/preserved-app/lib; printf '#!/bin/sh\ncat /opt/preserved-app/lib\n' >/usr/local/bin/preserved-app; chmod 755 /usr/local/bin/preserved-app; printf settings >/etc/preserved-app.conf; printf state >/var/lib/preserved-app/state; printf user-data >/config/preserved/data; chown -R 1000:1000 /config/preserved",
          ],
          Labels: { "localdot.cell": sourceId, "localdot.role": "desktop" },
          HostConfig: {
            NetworkMode: "none",
            Mounts: [{ Type: "volume", Source: sourceHome, Target: "/config" }],
          },
        },
      });
      containers.push(source.Id);
      await run(source.Id);
      const state = new ComputerSystemState(home, docker, image);
      const record = {
        id: sourceId,
        ownership: { desktop: source.Id },
        docker: { homeVolume: sourceHome },
      } as CellRecord;
      await expect(requireUnmodifiedSystem(docker, source.Id)).rejects.toThrow(
        "cannot preserve yet",
      );
      await state.capture(record);
      snapshot = (await state.read(sourceId)).image;
      await docker.request({
        method: "DELETE",
        path: `/containers/${source.Id}`,
        query: { v: "true" },
      });
      // A new daemon can restore after the old container is gone; capture retry remains idempotent.
      const restarted = new ComputerSystemState(home, docker, image);
      await restarted.capture(record);
      expect(await restarted.copyHome(sourceId, targetId, targetHome)).toBe(snapshot);
      const restored = await docker.request<{ Id: string }>({
        method: "POST",
        path: "/containers/create",
        body: {
          Image: snapshot,
          User: "0:0",
          Entrypoint: ["/bin/sh", "-ec"],
          Cmd: [
            'test "$(preserved-app)" = dependency; test "$(cat /etc/preserved-app.conf)" = settings; test "$(cat /var/lib/preserved-app/state)" = state; test "$(cat /config/preserved/data)" = user-data; test "$(stat -c %u /config/preserved/data)" = 1000',
          ],
          Labels: { "localdot.cell": targetId, "localdot.role": "desktop" },
          HostConfig: {
            NetworkMode: "none",
            Mounts: [{ Type: "volume", Source: targetHome, Target: "/config" }],
          },
        },
      });
      containers.push(restored.Id);
      await expect(requireUnmodifiedSystem(docker, restored.Id)).rejects.toThrow(
        "cannot preserve yet",
      );
      await run(restored.Id);
    } finally {
      for (const id of containers)
        await docker
          .request({
            method: "DELETE",
            path: `/containers/${id}`,
            query: { force: "true", v: "true" },
          })
          .catch(() => {});
      for (const id of [sourceHome, targetHome])
        await docker.request({ method: "DELETE", path: `/volumes/${id}` }).catch(() => {});
      if (snapshot)
        await docker.request({ method: "DELETE", path: `/images/${snapshot}` }).catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  },
);
