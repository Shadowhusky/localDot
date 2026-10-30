import { DEFAULT_COMPUTER_SIZE } from "@localdot/protocol";
import type { createApp } from "../../../daemon/src/app.ts";
import {
  browserLimits,
  ComputerSizes,
  desktopLimits,
  type Limits,
} from "../../../daemon/src/cells/computer-size.ts";
import type { DockerRequest } from "../../../daemon/src/cells/docker.ts";

const GIB = 1024 ** 3;

interface Box {
  labels: Record<string, string>;
  running: boolean;
  limits: Limits;
}

// Docker as the computer's size sees it on the fixture: Docker Desktop's 8 GB and 24 CPUs, this
// dot's desktop and web browser while its computer runs, and other dots' computers when a test
// starts some. The real ComputerSizes reads and changes it.
export function fakeDockerRoom(
  home: string,
  computers: () => readonly { id: string; running: boolean }[],
) {
  const room = { MemTotal: 8_211_816_448, NCPU: 24, OperatingSystem: "Docker Desktop" };
  const limits = new Map<string, Limits>();
  let others: Box[] = [];
  let used = 0.95 * GIB;
  let looks = 0;

  const boxes = (): Map<string, Box> => {
    const all = new Map<string, Box>();
    for (const { id, running } of computers()) {
      const desktop = `desktop-${id}`;
      const browser = `browser-${id}`;
      if (!limits.has(desktop)) limits.set(desktop, desktopLimits(DEFAULT_COMPUTER_SIZE));
      if (!limits.has(browser)) limits.set(browser, browserLimits(DEFAULT_COMPUTER_SIZE));
      all.set(desktop, {
        labels: { "localdot.role": "desktop", "localdot.cell": id },
        running,
        limits: limits.get(desktop) as Limits,
      });
      if (running)
        all.set(browser, {
          labels: { "localdot.role": "browser", "localdot.cell": `b${id}`, "localdot.parent": id },
          running,
          limits: limits.get(browser) as Limits,
        });
    }
    for (const [i, box] of others.entries()) all.set(`other-${i}`, box);
    return all;
  };

  const request = async <T>({ method, path, query, body }: DockerRequest): Promise<T> => {
    if (path === "/info") return room as T;
    const all = boxes();
    if (path === "/containers/json") {
      const filters = JSON.parse(query?.filters ?? "{}") as { label?: string[]; status?: string[] };
      const role = filters.label
        ?.find((label) => label.startsWith("localdot.role="))
        ?.split("=")[1];
      return [...all]
        .filter(
          ([, box]) =>
            (!filters.status || box.running) && (!role || box.labels["localdot.role"] === role),
        )
        .map(([Id, box]) => ({ Id, Labels: box.labels })) as T;
    }
    const [, , id = "", action] = path.split("/");
    const box = all.get(decodeURIComponent(id));
    if (!box) throw new Error(`fake Docker has no ${id}`);
    if (action === "json") return { State: { Running: box.running }, HostConfig: box.limits } as T;
    if (action === "stats") {
      looks += 1;
      return {
        memory_stats: { usage: used, stats: { inactive_file: 0 } },
        cpu_stats: {
          cpu_usage: { total_usage: looks * 0.42 * 5e9 },
          system_cpu_usage: looks * 24 * 5e9,
          online_cpus: 24,
        },
      } as T;
    }
    if (method === "POST" && action === "update") {
      Object.assign(box.limits, body);
      return { Warnings: [] } as T;
    }
    throw new Error(`fake Docker: no ${method} ${path}`);
  };

  const sizes = new ComputerSizes({
    home,
    docker: { request },
    computers: () => computers().map(({ id }) => id),
    platform: "darwin",
  });

  // POST /__qa/docker?memory=<GB>&cpus=<n>&app=<OperatingSystem>: what Docker has.
  // POST /__qa/docker/others?memory=<GB>&cpus=<n>: another dot's computer runs with that size;
  //   memory=0 stops them all.
  // POST /__qa/docker/used?memory=<GB>: what this dot's desktop uses now.
  // GET /__qa/docker: the limits each of this dot's desktops and web browsers has.
  const qa = (routes: ReturnType<typeof createApp>) => {
    routes.post("/__qa/docker", (c) => {
      const memory = Number(c.req.query("memory") ?? room.MemTotal / GIB);
      room.MemTotal = Math.round(memory * GIB);
      room.NCPU = Number(c.req.query("cpus") ?? room.NCPU);
      room.OperatingSystem = c.req.query("app") ?? room.OperatingSystem;
      return c.json({ ok: true });
    });
    routes.post("/__qa/docker/others", (c) => {
      const memory = Number(c.req.query("memory") ?? 4);
      const cpus = Number(c.req.query("cpus") ?? 4);
      others =
        memory > 0
          ? [
              ...others,
              {
                labels: { "localdot.role": "desktop", "localdot.cell": `other-${others.length}` },
                running: true,
                limits: desktopLimits({ memoryBytes: memory * GIB, cpus }),
              },
            ]
          : [];
      return c.json({ ok: true });
    });
    routes.post("/__qa/docker/used", (c) => {
      used = Number(c.req.query("memory") ?? 0.95) * GIB;
      return c.json({ ok: true });
    });
    routes.get("/__qa/docker", (c) => c.json(Object.fromEntries(limits)));
  };

  return { sizes, qa };
}
