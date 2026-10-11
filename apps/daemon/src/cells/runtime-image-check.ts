import type { DockerClient } from "./docker.ts";
import { RuntimeImages, runtimeSource } from "./runtime-update-store.ts";
import { ComputerSystemState } from "./system-state.ts";
import type { CellRecord } from "./types.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const failure = () =>
  new Error(
    "Computer runtime does not match the installed release; finish update recovery before starting it.",
  );

/** Read-only: validates actual container image IDs against the locally inspected release pins.
 * Config.Image alone is only the originally requested name, not proof of the running image. */
export async function verifyDesktopRuntimeImages(
  docker: Pick<DockerClient, "request">,
  input: CellRecord,
  target: { desktop: string; gate: string },
  home?: string,
): Promise<void> {
  try {
    const record = runtimeSource(input),
      images = RuntimeImages.parse(target);
    for (const role of ["gate", "desktop"] as const) {
      const path = `/containers/${encodeURIComponent(record.docker[role])}/json`;
      const before = await docker.request<unknown>({ method: "GET", path });
      let expected = images[role];
      let snapshot: { image: string; baseImage: string } | undefined;
      if (
        role === "desktop" &&
        home &&
        object(before) &&
        object(before.Config) &&
        object(before.Config.Labels) &&
        typeof before.Config.Labels["localdot.snapshot"] === "string"
      ) {
        snapshot = await new ComputerSystemState(home, docker, images.desktop).read(
          before.Config.Labels["localdot.snapshot"],
        );
        expected = snapshot.image;
      }
      const valid = (raw: unknown, imageId?: unknown) =>
        object(raw) &&
        raw.Id === record.ownership?.[role] &&
        typeof raw.Image === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(raw.Image) &&
        (imageId === undefined || raw.Image === imageId) &&
        object(raw.Config) &&
        raw.Config.Image === expected &&
        object(raw.Config.Labels) &&
        raw.Config.Labels["localdot.cell"] === record.id &&
        raw.Config.Labels["localdot.role"] === role;
      if (!valid(before)) throw failure();
      const image = await docker.request<unknown>({
        method: "GET",
        path: `/images/${encodeURIComponent(images[role])}/json`,
      });
      if (
        !object(image) ||
        typeof image.Id !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(image.Id) ||
        image.Os !== "linux" ||
        image.Architecture !== "arm64" ||
        !Array.isArray(image.RepoDigests) ||
        !image.RepoDigests.includes(images[role]) ||
        !(snapshot ? snapshot.baseImage === image.Id : true) ||
        !valid(before, snapshot?.image ?? image.Id) ||
        !valid(await docker.request({ method: "GET", path }), snapshot?.image ?? image.Id)
      )
        throw failure();
    }
  } catch {
    throw failure();
  }
}
