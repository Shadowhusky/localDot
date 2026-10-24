import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireTestPass } from "./require-test-pass.mjs";

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  }).trim();
// GitHub owner and repository names are case-insensitive; the repository is now named localDot.
if (
  process.argv.length !== 3 ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REPOSITORY?.toLowerCase() !== "shadowhusky/localdot" ||
  process.env.GITHUB_REF !== "refs/heads/main"
)
  throw new Error("Candidate publication requires the trusted repository's main workflow");
const directory = process.argv[2];
const environment = JSON.parse(
  run("gh", ["api", "repos/Shadowhusky/localdot/environments/release-candidate"]),
);
if (
  !environment.protection_rules?.some(
    (rule) => rule.type === "required_reviewers" && rule.reviewers?.length,
  )
)
  throw new Error("Configure a required reviewer for release-candidate before publishing");
requireTestPass(JSON.parse(await readFile(join(directory, "tests.json"), "utf8")));
const receipt = JSON.parse(await readFile(join(directory, "images.json"), "utf8"));
if (
  receipt.commit !== process.env.GITHUB_SHA ||
  receipt.commit !== run("git", ["rev-parse", "HEAD"]) ||
  !/^[a-f0-9]{40}$/.test(receipt.commit) ||
  !["amd64", "arm64"].includes(receipt.architecture)
)
  throw new Error("Candidate source or platform mismatch");
run("docker", ["login", "ghcr.io", "--username", process.env.GITHUB_ACTOR, "--password-stdin"], {
  input: process.env.GH_TOKEN,
});
try {
  const images = {};
  for (const role of ["gate", "brain", "desktop", "browser"]) {
    const local = `localdot/${role}:dev`;
    const [image] = JSON.parse(run("docker", ["image", "inspect", local]));
    if (image.Id !== receipt.images[role]?.imageId || image.Architecture !== receipt.architecture)
      throw new Error("Tested image changed before publication");
    const repository = `ghcr.io/shadowhusky/localdot-${role}`;
    const tag = `${repository}:candidate-${receipt.commit}-${receipt.architecture}`;
    run("docker", ["tag", local, tag]);
    run("docker", ["push", tag]);
    const [published] = JSON.parse(run("docker", ["image", "inspect", tag]));
    const reference = published.RepoDigests?.find((value) =>
      value.startsWith(`${repository}@sha256:`),
    );
    const digest = reference?.split("@")[1];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
      throw new Error("Missing published manifest digest");
    images[role] = { repository, digest, platforms: [`linux/${receipt.architecture}`] };
  }
  await writeFile(
    join(directory, "published.json"),
    `${JSON.stringify({ v: 1, commit: receipt.commit, images, accepted: false }, null, 2)}\n`,
    { flag: "wx" },
  );
} finally {
  run("docker", ["logout", "ghcr.io"]);
}
