import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InstalledReleaseRecord } from "../../../../packages/protocol/src/install-receipts.ts";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import type { AssembledRelease } from "./assemble-release.ts";
import type { ExtractedFile } from "./extract-release.ts";
import { verifyInstalledPayload } from "./installed-release.ts";
import { nativeDependencyPlan } from "./native-plan.ts";
import {
  installedReleaseVerifier,
  promotePreparedRelease,
  readInstalledLockHelper,
} from "./promote-release.ts";
import { createPromotionScratch } from "./promotion-scratch.ts";
import { releaseDirectoryName, releaseLayout } from "./release-layout.ts";
import { fixtureNames, nativeFixture } from "./testing/native-fixture.ts";

const hooks = vi.hoisted(() => ({
  failAnchor: false,
  failScratch: null as "before" | "after" | null,
}));
vi.mock("./private-record.ts", async (original) => {
  const real = await original<typeof import("./private-record.ts")>();
  return {
    ...real,
    privateRecordStore: (...args: Parameters<typeof real.privateRecordStore>) => {
      const store = real.privateRecordStore(...args);
      return {
        ...store,
        save: async (value: unknown) => {
          if (hooks.failAnchor && args[1] === "trusted.json")
            throw new Error("simulated interrupted anchor publication");
          if (value && args[1] === "promotion-scratch.json" && hooks.failScratch === "before")
            throw new Error("simulated interrupted scratch publication");
          await store.save(value);
          if (value && args[1] === "promotion-scratch.json" && hooks.failScratch === "after")
            throw new Error("simulated lost scratch publication acknowledgement");
        },
      };
    },
  };
});

const roots: string[] = [];
it("verifies the offline lock helper even when app and native payloads are damaged", async () => {
  const f = await fixture();
  await promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature);
  await rm(join(f.destination, "app"), { recursive: true });
  await rm(join(f.destination, "node_modules"), { recursive: true });
  f.signature.mockClear();
  const result = await readInstalledLockHelper(
    f.state,
    f.candidate.identity,
    signal(),
    f.signature,
  );
  expect(result.keydPath).toBe(join(f.destination, "keyd/bin/keyd"));
  expect(f.signature).toHaveBeenCalledExactlyOnceWith(
    result.keydPath,
    expect.objectContaining({
      sha256: f.candidate.manifest.keyd.sha256,
      teamId: "87FD3FSZBG",
      identifier: "dev.localdot.keyd",
    }),
    expect.any(AbortSignal),
  );
  await expect(
    installedReleaseVerifier(f.state, f.signature)(f.destination, f.candidate.identity, signal()),
  ).rejects.toThrow();
});
it.each(["anchor", "receipt", "identity", "linked-bin", "signature"])(
  "refuses offline helper recovery after %s corruption",
  async (kind) => {
    const f = await fixture();
    await promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature);
    f.signature.mockClear();
    const anchor = join(
      f.state,
      "release-records",
      releaseDirectoryName(f.candidate.identity),
      "trusted.json",
    );
    if (kind === "anchor") await rm(anchor);
    if (kind === "receipt") await writeFile(join(f.destination, "assembly.json"), "{}");
    if (kind === "identity") {
      const wrong = { ...f.expected, identity: { ...f.expected.identity, version: "9.9.9" } };
      await writeFile(anchor, encode(wrong));
    }
    if (kind === "linked-bin") {
      const path = join(f.destination, "keyd/bin");
      await rename(path, `${path}.original`);
      await symlink(`${path}.original`, path);
    }
    if (kind === "signature") f.signature.mockRejectedValue(new Error("invalid signature"));
    await expect(
      readInstalledLockHelper(f.state, f.candidate.identity, signal(), f.signature),
    ).rejects.toThrow();
    if (kind !== "signature") expect(f.signature).not.toHaveBeenCalled();
  },
);
const signal = () => new AbortController().signal;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
// Synthetic package inventories exercise persistence/copying. Signature trust is an explicit seam;
// no fixture executable or native module is run and no published provenance is claimed.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-promotion-")));
  roots.push(root);
  const state = join(root, "state"),
    directory = join(root, "candidate"),
    app = join(directory, "app"),
    helper = join(directory, "keyd");
  for (const path of [state, directory, app, helper]) await mkdir(path, { mode: 0o700 });
  async function file(
    base: string,
    name: string,
    bytes: Buffer,
    mode = 0o600,
  ): Promise<ExtractedFile> {
    const path = join(base, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode });
    return { sha256: hash(bytes), bytes: bytes.length, mode };
  }
  const f = nativeFixture(),
    pkg = encode(f.pkg),
    lock = encode(f.lock),
    binary = Buffer.from("fixture helper never executed");
  const manifest = ReleaseManifest.parse({
    ...sampleManifest(),
    files: { "npm-shrinkwrap.json": hash(lock) },
    keyd: { ...sampleManifest().keyd, sha256: hash(binary), teamId: "87FD3FSZBG" },
  });
  const release = encode(manifest);
  const appFiles = {
    "package.json": await file(app, "package.json", pkg),
    "release.json": await file(app, "release.json", release),
    "npm-shrinkwrap.json": await file(app, "npm-shrinkwrap.json", lock),
  };
  const keydFiles = {
    "bin/keyd": await file(helper, "bin/keyd", binary, 0o700),
    "package.json": await file(
      helper,
      "package.json",
      encode({
        name: manifest.keyd.package,
        version: manifest.version,
        os: ["darwin"],
        cpu: ["arm64"],
      }),
    ),
    LICENSE: await file(helper, "LICENSE", Buffer.from("fixture license")),
    "THIRD-PARTY.md": await file(helper, "THIRD-PARTY.md", Buffer.from("fixture notices")),
  };
  const identity = {
    version: "1.0.0",
    packageSha256: "a".repeat(64),
    manifestSha256: hash(release),
  };
  const metadataDigests = { packageJson: hash(pkg), releaseJson: hash(release) };
  const assembly = encode({
    v: 1,
    phase: "assembled",
    identity,
    commit: manifest.commit,
    metadataDigests,
    appFiles,
    keydPackageSha256: "b".repeat(64),
    keydFiles,
  });
  await file(directory, "assembly.json", assembly);
  const plan = nativeDependencyPlan(pkg.toString(), lock.toString(), "1.0.0"),
    files: Record<string, ExtractedFile> = {};
  for (const name of fixtureNames)
    files[`${name}/package.json`] = await file(
      join(directory, "node_modules"),
      `${name}/package.json`,
      encode({ name, version: "1.0.0" }),
    );
  const nativeBytes = encode({
    v: 1,
    packages: plan.map(({ name, version, integrity }) => ({ name, version, integrity })),
    files,
    health: { sharp: "1.0.0", vips: "1.2.3" },
  });
  await file(directory, "native.json", nativeBytes);
  const candidate: AssembledRelease = {
    directory,
    app,
    keyd: join(helper, "bin/keyd"),
    identity,
    manifest,
    metadataDigests,
    assemblySha256: hash(assembly),
    dispose: async () => {
      await rm(directory, { recursive: true });
    },
  };
  const native = { receiptSha256: hash(nativeBytes) };
  const expected = InstalledReleaseRecord.parse({
    v: 1,
    identity,
    assemblySha256: candidate.assemblySha256,
    nativeSha256: native.receiptSha256,
  });
  const signature = vi.fn(async (path: string) => ({
    path,
    sha256: hash(binary),
    teamId: "87FD3FSZBG",
    identifier: "dev.localdot.keyd",
  }));
  await writeFile(join(state, "user-data"), "preserve");
  return {
    root,
    state,
    candidate,
    native,
    expected,
    signature,
    destination: join(state, "releases", releaseDirectoryName(identity)),
  };
}
afterEach(async () => {
  hooks.failAnchor = false;
  hooks.failScratch = null;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
it("promotes a verified copy, reopens through its private anchor, and selects separately", async () => {
  const f = await fixture();
  const result = await promotePreparedRelease(
    f.state,
    f.candidate,
    f.native,
    signal(),
    f.signature,
  );
  expect(result).toMatchObject({ directory: f.destination, recovered: false });
  const layout = releaseLayout(f.state, installedReleaseVerifier(f.state, f.signature));
  expect(await layout.current()).toBeNull();
  expect(await readdir(f.destination)).toEqual([
    "app",
    "assembly.json",
    "keyd",
    "native.json",
    "node_modules",
  ]);
  expect((await lstat(f.destination)).ino).not.toBe((await lstat(f.candidate.directory)).ino);
  await f.candidate.dispose();
  await layout.select(result.identity, signal());
  expect(await layout.current()).toEqual(result.identity);
  expect(await readFile(join(f.state, "user-data"), "utf8")).toBe("preserve");
});
it("recovers a durably recorded incomplete copy before promoting a fresh verified candidate", async () => {
  const f = await fixture();
  const releases = join(f.state, "releases");
  await mkdir(releases, { mode: 0o700 });
  const abandoned = await createPromotionScratch(releases, signal());
  await writeFile(join(abandoned.directory, "partial"), "incomplete");
  const foreign = join(releases, ".promote-unrecorded");
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(join(foreign, "keep"), "retained");
  const result = await promotePreparedRelease(
    f.state,
    f.candidate,
    f.native,
    signal(),
    f.signature,
  );
  expect(result.directory).toBe(f.destination);
  await expect(lstat(abandoned.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(foreign, "keep"), "utf8")).toBe("retained");
  expect(await readFile(join(releases, "promotion-scratch.json"), "utf8")).toBe("null\n");
  expect(await readFile(f.candidate.keyd, "utf8")).toContain("never executed");
});
it.each(["before", "after"] as const)(
  "copies no payload if scratch publication fails %s its durable acknowledgement",
  async (when) => {
    const f = await fixture();
    hooks.failScratch = when;
    await expect(
      promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature),
    ).rejects.toThrow("scratch publication");
    const releases = join(f.state, "releases");
    const copies = (await readdir(releases)).filter((name) => name.startsWith(".promote-"));
    expect(copies).toHaveLength(1);
    const abandoned = join(releases, copies[0] ?? "missing");
    expect(await readdir(abandoned)).toEqual([]);
    await expect(lstat(f.destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.candidate.keyd, "utf8")).toContain("never executed");
    hooks.failScratch = null;
    await promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature);
    if (when === "after") await expect(lstat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readdir(abandoned)).toEqual([]); // No durable claim: preserve it.
  },
);
it.each([
  "missing-native",
  "native-file",
  "native-receipt",
  "assembly-receipt",
  "app-file",
  "helper-file",
  "extra-root",
  "native-link",
  "native-mode",
])("refuses %s without creating a selected release", async (kind) => {
  const f = await fixture(),
    dir = f.candidate.directory;
  if (kind === "missing-native") await rm(join(dir, "native.json"));
  if (kind === "native-file")
    await writeFile(join(dir, "node_modules/sharp/package.json"), "changed");
  if (kind === "native-receipt") await writeFile(join(dir, "native.json"), "{}");
  if (kind === "assembly-receipt") await writeFile(join(dir, "assembly.json"), "{}");
  if (kind === "app-file") await writeFile(join(dir, "app/package.json"), "changed");
  if (kind === "helper-file") await writeFile(f.candidate.keyd, "changed");
  if (kind === "extra-root") await writeFile(join(dir, "foreign"), "changed");
  if (kind === "native-link") {
    await rm(join(dir, "node_modules/sharp/package.json"));
    await symlink(join(dir, "app/package.json"), join(dir, "node_modules/sharp/package.json"));
  }
  if (kind === "native-mode") await chmod(join(dir, "node_modules/sharp/package.json"), 0o644);
  await expect(
    promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature),
  ).rejects.toThrow();
  expect(await readdir(f.state)).toEqual(["user-data"]);
});
it("does not accept changed native bytes even when the local inventory is rewritten to match", async () => {
  const f = await fixture();
  await promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature);
  const path = join(f.destination, "node_modules/sharp/package.json"),
    bytes = Buffer.from("changed");
  await writeFile(path, bytes);
  const receipt = JSON.parse(await readFile(join(f.destination, "native.json"), "utf8"));
  receipt.files["sharp/package.json"] = { sha256: hash(bytes), bytes: bytes.length, mode: 0o600 };
  await writeFile(join(f.destination, "native.json"), encode(receipt));
  const layout = releaseLayout(f.state, installedReleaseVerifier(f.state, f.signature));
  await expect(layout.select(f.candidate.identity, signal())).rejects.toThrow();
  expect(await layout.current()).toBeNull();
});
it("keeps the renamed payload unselectable if trust publication is interrupted, then recovers by fresh verification", async () => {
  const f = await fixture();
  hooks.failAnchor = true;
  await expect(
    promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature),
  ).rejects.toThrow("interrupted");
  const before = await lstat(f.destination);
  const layout = releaseLayout(f.state, installedReleaseVerifier(f.state, f.signature));
  await expect(layout.select(f.candidate.identity, signal())).rejects.toThrow();
  expect(await layout.current()).toBeNull();
  hooks.failAnchor = false;
  const result = await promotePreparedRelease(
    f.state,
    f.candidate,
    f.native,
    signal(),
    f.signature,
  );
  expect(result.recovered).toBe(true);
  expect((await lstat(f.destination)).ino).toBe(before.ino);
  await layout.select(result.identity, signal());
  expect(await layout.current()).toEqual(result.identity);
});
it("does not repair an unknown existing destination or overwrite a conflicting anchor", async () => {
  const f = await fixture();
  await mkdir(f.destination, { recursive: true, mode: 0o700 });
  await writeFile(join(f.destination, "keep"), "unknown");
  await expect(
    promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature),
  ).rejects.toThrow();
  expect(await readFile(join(f.destination, "keep"), "utf8")).toBe("unknown");
  await rm(f.destination, { recursive: true });
  await promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature);
  const anchor = join(
    f.state,
    "release-records",
    releaseDirectoryName(f.candidate.identity),
    "trusted.json",
  );
  const conflict = { ...f.expected, nativeSha256: "0".repeat(64) };
  await writeFile(anchor, encode(conflict));
  await expect(
    promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(anchor, "utf8"))).toEqual(conflict);
});
it("cleans only the newly copied temporary tree on cancellation and preserves the candidate", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  f.signature.mockImplementation(async (path) => {
    if (path.includes(".promote-")) controller.abort(reason);
    return { path, sha256: "a".repeat(64), teamId: "87FD3FSZBG", identifier: "dev.localdot.keyd" };
  });
  await expect(
    promotePreparedRelease(f.state, f.candidate, f.native, controller.signal, f.signature),
  ).rejects.toBe(reason);
  expect(await readdir(join(f.state, "releases"))).toEqual(["promotion-scratch.json"]);
  expect(await readFile(join(f.state, "user-data"), "utf8")).toBe("preserve");
  expect(await readFile(f.candidate.keyd, "utf8")).toContain("never executed");
});
it("requires the signature gate and the installer-owned anchor on reopen", async () => {
  const f = await fixture();
  f.signature.mockRejectedValueOnce(new Error("invalid Apple signature"));
  await expect(
    verifyInstalledPayload(f.candidate.directory, f.expected, signal(), f.signature),
  ).rejects.toThrow("Apple signature");
  await promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature);
  await rm(join(f.state, "release-records"), { recursive: true });
  await expect(
    installedReleaseVerifier(f.state, f.signature)(f.destination, f.candidate.identity, signal()),
  ).rejects.toThrow();
  expect(await readdir(f.state)).toEqual(["releases", "user-data"]);
});

it("preserves replacement temporary directories and reports cleanup failure alongside the original error", async () => {
  const f = await fixture();
  let replacement = "";
  f.signature.mockImplementation(async (path) => {
    if (path.includes(".promote-")) {
      replacement = dirname(dirname(dirname(path)));
      await rename(replacement, join(f.state, "releases", "retained-original"));
      await mkdir(replacement, { mode: 0o700 });
      await writeFile(join(replacement, "keep"), "foreign replacement");
    }
    return { path, sha256: "a".repeat(64), teamId: "87FD3FSZBG", identifier: "dev.localdot.keyd" };
  });
  await expect(
    promotePreparedRelease(f.state, f.candidate, f.native, signal(), f.signature),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(await readFile(join(replacement, "keep"), "utf8")).toBe("foreign replacement");
  expect(
    await readFile(join(f.state, "releases/retained-original/keyd/bin/keyd"), "utf8"),
  ).toContain("never executed");
});

it.each(["helper-version", "helper-scripts", "native-packages"])(
  "cross-checks %s even in a hash-matching receipt",
  async (kind) => {
    const f = await fixture(),
      directory = f.candidate.directory;
    if (kind === "native-packages") {
      const receipt = JSON.parse(await readFile(join(directory, "native.json"), "utf8"));
      receipt.packages[0].version = "9.0.0";
      const bytes = encode(receipt);
      await writeFile(join(directory, "native.json"), bytes);
      f.expected.nativeSha256 = hash(bytes);
    } else {
      const path = join(directory, "keyd/package.json"),
        pkg = JSON.parse(await readFile(path, "utf8"));
      if (kind === "helper-version") pkg.version = "9.0.0";
      else pkg.scripts = { install: "forbidden" };
      const bytes = encode(pkg);
      await writeFile(path, bytes);
      const receipt = JSON.parse(await readFile(join(directory, "assembly.json"), "utf8"));
      receipt.keydFiles["package.json"] = { sha256: hash(bytes), bytes: bytes.length, mode: 0o600 };
      const body = encode(receipt);
      await writeFile(join(directory, "assembly.json"), body);
      f.expected.assemblySha256 = hash(body);
    }
    await expect(
      verifyInstalledPayload(directory, f.expected, signal(), f.signature),
    ).rejects.toThrow();
    expect(f.signature).not.toHaveBeenCalled();
  },
);
