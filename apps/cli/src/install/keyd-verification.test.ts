import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import {
  keydNativeRequirement,
  keydRequirement,
  systemKeydDesignatedCheck,
  systemKeydSignatureCheck,
  verifyKeydExecutable,
  verifyKeydNativeExecutable,
  verifyReleaseKeyd,
} from "./keyd-verification.ts";
import { KEYD_RELEASE_TEAM_ID } from "./release-trust.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";

let binary: Awaited<ReturnType<typeof buildTestKeyd>> | undefined;
beforeAll(async () => {
  binary = await buildTestKeyd();
}, 65_000);
afterAll(() => binary?.dispose());

const roots: string[] = [];
const TEAM = "TESTTEAM01";
const signal = () => new AbortController().signal;
const designated = async () => {};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-keyd-verify-")));
  roots.push(root);
  const path = join(root, "keyd"),
    body = Buffer.alloc(128);
  // Structural Mach-O fixture only. It is not executable code or an authentic signed binary.
  body.writeUInt32LE(0xfeedfacf, 0);
  body.writeUInt32LE(0x0100000c, 4);
  body.writeUInt32LE(2, 12);
  await writeFile(path, body, { mode: 0o700 });
  const sample = sampleManifest().keyd;
  const expected = ReleaseManifest.shape.keyd.parse({
    ...sample,
    sha256: hash(body),
    native: { ...sample.native, sha256: hash(body) },
  });
  return { root, path, body, expected };
}
it("binds bytes, arm64 executable shape, release team and exact Developer ID requirement", async () => {
  const f = await fixture(),
    signature = vi.fn(async () => {}),
    designatedCheck = vi.fn(async () => {});
  const result = await verifyKeydExecutable(
    f.path,
    f.expected,
    TEAM,
    signal(),
    signature,
    designatedCheck,
  );
  expect(result.sha256).toBe(f.expected.sha256);
  expect(result.identifier).toBe("dev.localdot.keyd");
  expect(signature).toHaveBeenCalledTimes(1);
  const requirement = keydRequirement(TEAM);
  expect(signature).toHaveBeenCalledWith(f.path, requirement, expect.any(AbortSignal));
  expect(designatedCheck).toHaveBeenCalledWith(f.path, requirement, expect.any(AbortSignal));
  expect(requirement).toContain("anchor apple generic");
  expect(requirement).toContain('identifier "dev.localdot.keyd"');
  expect(requirement).toContain("1.2.840.113635.100.6.2.6");
  expect(requirement).toContain("1.2.840.113635.100.6.1.13");
  expect(requirement).toContain('certificate leaf[subject.OU] = "TESTTEAM01"');
  // An earlier keyd, which could start a program its caller named, lacks the generation.
  expect(requirement).toContain('info [KeydGeneration] >= "2"');
});
it("binds keyd-native to its own pin and signing identifier", async () => {
  const f = await fixture(),
    signature = vi.fn(async () => {});
  const result = await verifyKeydNativeExecutable(f.path, f.expected, TEAM, signal(), signature);
  expect(result.identifier).toBe("dev.localdot.keyd.native");
  const requirement = keydNativeRequirement(TEAM);
  expect(signature).toHaveBeenCalledWith(f.path, requirement, expect.any(AbortSignal));
  expect(requirement).toContain('identifier "dev.localdot.keyd.native"');
  expect(requirement).toContain('certificate leaf[subject.OU] = "TESTTEAM01"');
  expect(requirement).not.toContain("KeydGeneration");
  // keyd's pin never vouches for keyd-native, nor the other way round.
  f.expected.native.sha256 = "a".repeat(64);
  await expect(
    verifyKeydNativeExecutable(f.path, f.expected, TEAM, signal(), signature),
  ).rejects.toThrow("release verification");
  await expect(
    verifyKeydExecutable(f.path, f.expected, TEAM, signal(), signature, designated),
  ).resolves.toBeTruthy();
  expect(signature).toHaveBeenCalledTimes(2);
});
it.each([null, "", "BAD", 'A" or always', "testteam01"])(
  "fails closed with unconfigured/invalid trusted team %s",
  async (team) => {
    const f = await fixture(),
      signature = vi.fn(async () => {});
    await expect(
      verifyKeydExecutable(f.path, f.expected, team, signal(), signature, signature),
    ).rejects.toThrow("no trusted release signing identity");
    expect(signature).not.toHaveBeenCalled();
  },
);
it.each(["team", "identifier", "hash", "package"])(
  "rejects mismatched release %s before signature invocation",
  async (field) => {
    const f = await fixture(),
      signature = vi.fn(async () => {});
    if (field === "team") f.expected.teamId = "OTHERTEAM1";
    if (field === "identifier") Object.assign(f.expected, { identifier: "another.app" });
    if (field === "hash") f.expected.sha256 = "a".repeat(64);
    if (field === "package") Object.assign(f.expected, { package: "unrelated" });
    await expect(
      verifyKeydExecutable(f.path, f.expected, TEAM, signal(), signature, signature),
    ).rejects.toThrow("release verification");
    expect(signature).not.toHaveBeenCalled();
  },
);
it.each([
  "symlink",
  "hardlink",
  "writable",
  "not-executable",
  "too-large",
  "too-small",
  "x64",
  "non-macho",
  "library",
])("refuses a %s candidate", async (kind) => {
  const f = await fixture(),
    signature = vi.fn(async () => {});
  if (kind === "symlink" || kind === "hardlink") {
    const original = join(f.root, "original");
    await rename(f.path, original);
    await (kind === "symlink" ? symlink : link)(original, f.path);
  } else if (kind === "writable") await chmod(f.path, 0o777);
  else if (kind === "not-executable") await chmod(f.path, 0o600);
  else if (kind === "too-large") await truncate(f.path, 64 * 1024 * 1024 + 1);
  else if (kind === "too-small") await truncate(f.path, 8);
  else {
    f.body.writeUInt32LE(
      kind === "x64" ? 0x01000007 : kind === "library" ? 6 : 0,
      kind === "x64" ? 4 : kind === "library" ? 12 : 0,
    );
    await writeFile(f.path, f.body);
    f.expected.sha256 = hash(f.body);
  }
  await expect(
    verifyKeydExecutable(f.path, f.expected, TEAM, signal(), signature, signature),
  ).rejects.toThrow();
  expect(signature).not.toHaveBeenCalled();
});
it.each(["bytes", "replacement", "permissions"])(
  "detects a %s change during signature checking",
  async (kind) => {
    const f = await fixture();
    await expect(
      verifyKeydExecutable(
        f.path,
        f.expected,
        TEAM,
        signal(),
        async () => {
          if (kind === "bytes") {
            f.body[32] = 1;
            await writeFile(f.path, f.body);
          }
          if (kind === "replacement") {
            await rename(f.path, join(f.root, "old"));
            await writeFile(f.path, f.body, { mode: 0o700 });
          }
          if (kind === "permissions") await chmod(f.path, 0o777);
        },
        designated,
      ),
    ).rejects.toThrow("release verification");
  },
);
it("propagates cancellation without exposing diagnostic content", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("caller cancellation");
  await expect(
    verifyKeydExecutable(
      f.path,
      f.expected,
      TEAM,
      controller.signal,
      async () => {
        controller.abort(reason);
      },
      designated,
    ),
  ).rejects.toBe(reason);
  await expect(
    verifyKeydExecutable(
      f.path,
      f.expected,
      TEAM,
      signal(),
      async () => {
        throw new Error("private diagnostic credential");
      },
      designated,
    ),
  ).rejects.toThrow(/^The staged keyd executable did not pass release verification\.$/);
});
it("has valid native requirement syntax and rejects the real locally built keyd's non-Developer-ID signature", async () => {
  for (const requirement of [keydRequirement(TEAM), keydNativeRequirement(TEAM)])
    await expect(
      promisify(execFile)("/usr/bin/csreq", ["-r", `=${requirement}`, "-t"], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      }),
    ).resolves.toBeTruthy();
  if (!binary) throw new Error("Missing test executable");
  const path = binary.path;
  const expected = ReleaseManifest.shape.keyd.parse({
    ...sampleManifest().keyd,
    sha256: hash(await readFile(path)),
  });
  // Positive invocation control: this local Go binary has an ad-hoc signature whose internal
  // integrity verifies. The production Developer ID requirement must still reject its identity.
  await expect(systemKeydSignatureCheck(path, "always", signal())).resolves.toBeUndefined();
  await expect(verifyKeydExecutable(path, expected, TEAM, signal())).rejects.toThrow(
    "release verification",
  );
  // The production entry point accepts no caller-supplied trust pin. A matching manifest team
  // still cannot turn this ad-hoc binary into an authenticated Developer ID release.
  await expect(
    verifyReleaseKeyd(path, { ...expected, teamId: KEYD_RELEASE_TEAM_ID }, signal()),
  ).rejects.toThrow("release verification");
});
it("names the requirement keyd itself is signed with, clause for clause", async () => {
  if (!binary) throw new Error("Missing test executable");
  const run = (file: string, args: string[]) =>
    promisify(execFile)(file, args, { timeout: 5_000, maxBuffer: 64 * 1024 });
  const own = (await run(binary.path, ["requirement"])).stdout.trim();
  const canonical = async (requirement: string) =>
    (await run("/usr/bin/csreq", ["-r", `=${requirement}`, "-t"])).stdout.trim();
  expect(await canonical(keydRequirement(KEYD_RELEASE_TEAM_ID))).toBe(await canonical(own));
});
it("refuses a keyd that meets the requirement but is not signed with it as its designated requirement", async () => {
  if (!binary) throw new Error("Missing test executable");
  const built = binary.path;
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-keyd-verify-")));
  roots.push(root);
  const path = join(root, "keyd");
  const earlier = keydRequirement(TEAM).replace(' and info [KeydGeneration] >= "2"', "");
  const signedWith = async (requirement: string | null) => {
    await copyFile(built, path);
    await chmod(path, 0o700);
    const requirements = requirement ? ["--requirements", `=designated => ${requirement}`] : [];
    await promisify(execFile)("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "dev.localdot.keyd",
      ...requirements,
      path,
    ]);
    const expected = ReleaseManifest.shape.keyd.parse({
      ...sampleManifest().keyd,
      sha256: hash(await readFile(path)),
    });
    return verifyKeydExecutable(path, expected, TEAM, signal(), async () => {});
  };
  // An implicit designated requirement, and the earlier keyd's, which every earlier keyd meets.
  await expect(signedWith(null)).rejects.toThrow("release verification");
  await expect(signedWith(earlier)).rejects.toThrow("release verification");
  await expect(signedWith(keydRequirement(TEAM))).resolves.toMatchObject({ path });
  await expect(
    systemKeydDesignatedCheck(path, keydRequirement("OTHERTEAM1"), signal()),
  ).rejects.toThrow("release verification");
});
