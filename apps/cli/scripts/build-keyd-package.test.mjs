import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildKeydPackage, buildKeydPackageReceipt } from "./build-keyd-package.mjs";

let root, binary, native;
const goBuild = (output, command, env = {}) =>
  promisify(execFile)("go", ["build", "-trimpath", "-o", output, `./cmd/${command}`], {
    cwd: fileURLToPath(new URL("../../../keyd", import.meta.url)),
    env: {
      ...process.env,
      GOENV: "off",
      GOPROXY: "off",
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
      GOCACHE: process.env.GOCACHE ?? join(root, "go-cache"),
      ...env,
    },
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "localdot-keyd-package-")));
  binary = join(root, "keyd");
  native = join(root, "keyd-native");
  await goBuild(binary, "keyd");
  await goBuild(native, "keyd-native");
}, 65000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("assembles cached licenses for the actual compiled module graph with mandatory signature gates", async () => {
  const output = join(root, "package"),
    verify = vi.fn(async () => {}),
    verifyNative = vi.fn(async () => {});
  // Only this test's signature gates are injected. The real Developer ID rehearsal is separate.
  const result = await buildKeydPackage(
    { output, binary, native, version: "1.2.3" },
    verify,
    verifyNative,
  );
  expect(verify).toHaveBeenCalledTimes(2);
  expect(verify.mock.calls[1][0]).toBe(join(output, "bin/keyd"));
  expect(verify.mock.calls[1][1]).toMatchObject({
    identifier: "dev.localdot.keyd",
    teamId: "87FD3FSZBG",
  });
  expect(verifyNative).toHaveBeenCalledTimes(2);
  expect(verifyNative.mock.calls[1][0]).toBe(join(output, "bin/keyd-native"));
  expect(verifyNative.mock.calls[1][1].native).toEqual({
    path: "bin/keyd-native",
    sha256: createHash("sha256")
      .update(await readFile(native))
      .digest("hex"),
    identifier: "dev.localdot.keyd.native",
  });
  expect((await readFile(join(output, "bin/keyd"))).equals(await readFile(binary))).toBe(true);
  expect((await readFile(join(output, "bin/keyd-native"))).equals(await readFile(native))).toBe(
    true,
  );
  expect(JSON.parse(await readFile(join(output, "package.json"), "utf8")).files).toContain(
    "bin/keyd-native",
  );
  expect(JSON.parse(await readFile(join(output, "package.json"), "utf8"))).toMatchObject({
    name: "@localdot/keyd-darwin-arm64",
    version: "1.2.3",
    os: ["darwin"],
    cpu: ["arm64"],
  });
  expect(result.notices.map((item) => item.module)).toEqual([
    "Go standard library",
    "github.com/elazarl/goproxy",
    "golang.org/x/net",
    "golang.org/x/text",
  ]);
  for (const notice of result.notices)
    expect((await readFile(join(output, notice.path), "utf8")).length).toBeGreaterThan(100);
  expect(result.notarized).toBe(false);
});
it("refuses an unsigned/ad-hoc executable through the default production verifier", async () => {
  const output = join(root, "unsigned");
  await expect(buildKeydPackage({ output, binary, native, version: "1.2.3" })).rejects.toThrow(
    "release verification",
  );
  expect(await readdir(root)).not.toContain("unsigned");
});
it("refuses a release without the native Security framework backend even with a signature seam", async () => {
  const withoutNative = join(root, "keyd-without-native");
  await goBuild(withoutNative, "keyd", { CGO_ENABLED: "0" });
  await expect(
    buildKeydPackage(
      { output: join(root, "no-native"), binary: withoutNative, native, version: "1.2.3" },
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    ),
  ).rejects.toThrow("release build");
  expect(await readdir(root)).not.toContain("no-native");
}, 65000);
it.each(["latest", "1.0.0/../other", "1.2", "1.2.3+metadata"])(
  "refuses invalid version %s before verification",
  async (version) => {
    const verify = vi.fn();
    await expect(
      buildKeydPackage({ output: join(root, "invalid"), binary, native, version }, verify),
    ).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
  },
);
it("refuses keyd-native signed as anything but itself, or swapped with keyd", async () => {
  const refuse = vi.fn(async () => {
    throw new Error("not keyd-native");
  });
  await expect(
    buildKeydPackage(
      { output: join(root, "bad-native"), binary, native, version: "1.2.3" },
      vi.fn(async () => {}),
      refuse,
    ),
  ).rejects.toThrow("not keyd-native");
  expect(await readdir(root)).not.toContain("bad-native");
  await expect(
    buildKeydPackage(
      { output: join(root, "swapped"), binary: native, native: binary, version: "1.2.3" },
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    ),
  ).rejects.toThrow("release build");
  expect(await readdir(root)).not.toContain("swapped");
}, 65000);
it("refuses a copied signature failure without returning a package receipt", async () => {
  const verify = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("copy signature mismatch"));
  await expect(
    buildKeydPackage(
      { output: join(root, "bad-copy"), binary, native, version: "1.2.3" },
      verify,
      vi.fn(async () => {}),
    ),
  ).rejects.toThrow("copy signature mismatch");
  expect(await readdir(join(root, "bad-copy"))).not.toContain("package.json");
});

it("writes an external receipt without claiming source provenance or publication", async () => {
  const output = join(root, "with-receipt"),
    receipt = join(root, "receipt.json");
  const built = await buildKeydPackageReceipt(
    { output, receipt, binary, native, version: "1.2.3" },
    (input) =>
      buildKeydPackage(
        input,
        vi.fn(async () => {}),
        vi.fn(async () => {}),
      ),
  );
  expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(built.result);
  expect(built.result).toMatchObject({
    version: "1.2.3",
    sourceCommitVerified: false,
    releaseProvenanceVerified: false,
    completeRelease: false,
    published: false,
  });
  expect(await readdir(output)).not.toContain("receipt.json");
});

it("refuses evidence inside the package before any build effects", async () => {
  const output = join(root, "nested-receipt"),
    build = vi.fn();
  await expect(
    buildKeydPackageReceipt(
      { output, receipt: join(output, "receipt.json"), binary, native, version: "1.2.3" },
      build,
    ),
  ).rejects.toThrow("release build");
  expect(build).not.toHaveBeenCalled();
});

it("preserves an existing receipt and writes no success receipt after a verification failure", async () => {
  const receipt = join(root, "existing-receipt.json");
  await writeFile(receipt, "previous evidence");
  await expect(
    buildKeydPackageReceipt(
      { output: join(root, "existing-receipt-build"), receipt, binary, native, version: "1.2.3" },
      async () => ({ output: "unused", version: "1.2.3" }),
    ),
  ).rejects.toThrow();
  expect(await readFile(receipt, "utf8")).toBe("previous evidence");
  const refused = join(root, "refused-receipt.json");
  await expect(
    buildKeydPackageReceipt(
      { output: join(root, "refused-build"), receipt: refused, binary, native, version: "1.2.3" },
      async () => {
        throw new Error("signature refused");
      },
    ),
  ).rejects.toThrow("signature refused");
  expect(await readdir(root)).not.toContain("refused-receipt.json");
});
