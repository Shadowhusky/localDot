import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 30_000 }).trim();
if (process.argv.length !== 3) throw new Error("Usage: image-receipt.mjs output.json");
const architecture = process.env.EXPECTED_ARCH;
if (!["amd64", "arm64"].includes(architecture))
  throw new Error("An explicit native architecture is required");
const images = {};
for (const role of ["gate", "brain", "desktop", "browser"]) {
  const [image] = JSON.parse(run("docker", ["image", "inspect", `localdot/${role}:dev`]));
  if (
    image.Os !== "linux" ||
    image.Architecture !== architecture ||
    !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
    !Number.isSafeInteger(image.Size) ||
    image.Size <= 0
  )
    throw new Error("Unexpected built image");
  images[role] = { imageId: image.Id, installedBytes: image.Size };
}
await writeFile(
  process.argv[2],
  `${JSON.stringify(
    {
      v: 1,
      commit: run("git", ["rev-parse", "HEAD"]),
      architecture,
      images,
      // Local config IDs are not registry manifest digests; never feed them to release.json.
      published: false,
      realMachineInstallVerified: false,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
