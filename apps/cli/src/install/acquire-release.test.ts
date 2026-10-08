import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
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
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { KEYD_PACKAGE } from "../../../../packages/protocol/src/release.ts";
import { withAcquiredRelease } from "./acquire-release.ts";
import {
  type RegistryDownload,
  type RegistryPackage,
  type RegistryResource,
  registryResourceURL,
} from "./registry-download.ts";

const roots: string[] = [];
const pkg: RegistryPackage = { name: "localdot", version: "1.2.3" };
const body = Buffer.from("compressed archive fixture; deliberately not executable or extractable");
const digest = (algorithm: string, data = body) => createHash(algorithm).update(data).digest();
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-acquire-test-")));
  roots.push(root);
  await chmod(root, 0o700);
  await writeFile(join(root, "unrelated"), "preserve me");
  return root;
}
function metadata(p = pkg) {
  return {
    name: p.name,
    version: p.version,
    dist: {
      integrity: `sha512-${digest("sha512").toString("base64")}`,
      tarball: registryResourceURL({ ...p, kind: "archive" }).href,
      attestations: {
        url: "https://ignored.invalid/credentials",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
}
function transport(doc: unknown = metadata(), archive = body, attestations = "{}") {
  const requests: RegistryResource[] = [];
  const download: RegistryDownload = async function* (resource, abort) {
    abort.throwIfAborted();
    requests.push(resource);
    if (resource.kind === "metadata") yield Buffer.from(JSON.stringify(doc));
    else if (resource.kind === "attestation") yield Buffer.from(attestations);
    else {
      yield archive.subarray(0, 4);
      yield archive.subarray(4);
    }
  };
  return { download, requests };
}
async function clean(root: string) {
  expect(await readdir(root)).toEqual(["unrelated"]);
  expect(await readFile(join(root, "unrelated"), "utf8")).toBe("preserve me");
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps owned files until a cancelled consumer has drained", async () => {
  const root = await fixture(),
    t = transport(),
    controller = new AbortController();
  const reason = new Error("stop");
  let archive = "",
    finish = () => {},
    started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const drain = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const result = withAcquiredRelease(
    root,
    pkg,
    controller.signal,
    async (release) => {
      archive = release.archive;
      started();
      await drain;
    },
    t.download,
  ).catch((error) => {
    settled = true;
    return error;
  });
  await ready;
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(await readFile(archive)).toEqual(body);
  finish();
  expect(await result).toBe(reason);
  await clean(root);
});

it("aborts the whole acquisition and cooperative verifier at the total deadline", async () => {
  const root = await fixture(),
    t = transport();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let started = () => {},
    drained = false;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const result = withAcquiredRelease(
    root,
    pkg,
    signal(),
    async (_release, abort) => {
      started();
      await new Promise<void>((resolve) =>
        abort.addEventListener("abort", () => resolve(), { once: true }),
      );
      drained = true;
    },
    t.download,
  ).catch((error) => error);
  await ready;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await result).toBeInstanceOf(Error);
  expect(drained).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await clean(root);
});

it.each(["localdot", KEYD_PACKAGE] as const)(
  "acquires %s into private immutable files and cleans only its owned directory",
  async (name) => {
    const root = await fixture(),
      requested = { name, version: "1.2.3-rc.1" };
    const { download, requests } = transport(metadata(requested));
    const result = await withAcquiredRelease(
      root,
      requested,
      signal(),
      async (release) => {
        expect(Object.isFrozen(release)).toBe(true);
        expect(release).toMatchObject({
          ...requested,
          bytes: body.length,
          sha256: digest("sha256").toString("hex"),
          sha512: digest("sha512").toString("hex"),
          attestationJSON: "{}",
        });
        expect(await readFile(release.archive)).toEqual(body);
        expect((await lstat(release.archive)).mode & 0o7777).toBe(0o400);
        return "done";
      },
      download,
    );
    expect(result).toBe("done");
    expect(requests).toEqual(
      ["metadata", "archive", "attestation"].map((kind) => ({ ...requested, kind })),
    );
    await clean(root);
  },
);
it.each([
  "name",
  "version",
  "tarball",
  "integrity-type",
  "integrity-sha256",
  "integrity-noncanonical",
  "integrity-multiple",
  "missing-provenance",
  "wrong-predicate",
])("rejects malformed registry metadata (%s) before archive acquisition", async (kind) => {
  const root = await fixture(),
    doc = metadata();
  if (kind === "name") doc.name = KEYD_PACKAGE;
  if (kind === "version") doc.version = "1.2.4";
  if (kind === "tarball") doc.dist.tarball = "https://elsewhere.invalid/archive.tgz";
  if (kind === "integrity-type") Object.assign(doc.dist, { integrity: null });
  if (kind === "integrity-sha256")
    doc.dist.integrity = `sha256-${digest("sha256").toString("base64")}`;
  if (kind === "integrity-noncanonical") doc.dist.integrity = `sha512-${"A".repeat(85)}B==`;
  if (kind === "integrity-multiple") doc.dist.integrity += ` ${doc.dist.integrity}`;
  if (kind === "missing-provenance") Object.assign(doc.dist, { attestations: {} });
  if (kind === "wrong-predicate")
    doc.dist.attestations.provenance.predicateType = "https://other.invalid";
  const { download, requests } = transport(doc),
    work = vi.fn();
  await expect(withAcquiredRelease(root, pkg, signal(), work, download)).rejects.toThrow(
    "download failed",
  );
  expect(work).not.toHaveBeenCalled();
  expect(requests.map((item) => item.kind)).toEqual(["metadata"]);
  await clean(root);
});
it.each([
  "empty",
  "wrong-integrity",
  "archive-failure",
  "attestation-failure",
  "oversize",
  "callback-failure",
])("cleans partial acquisition on %s and does not expose unverified bytes", async (kind) => {
  const root = await fixture(),
    t = transport(
      metadata(),
      kind === "empty"
        ? Buffer.alloc(0)
        : kind === "wrong-integrity"
          ? Buffer.from("tampered")
          : body,
    );
  const download: RegistryDownload = async function* (resource, abort) {
    if (kind === "archive-failure" && resource.kind === "archive") {
      yield Buffer.from("partial");
      throw new Error("private URL details");
    }
    if (kind === "oversize" && resource.kind === "archive") {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 257; i++) yield chunk;
      return;
    }
    if (kind === "attestation-failure" && resource.kind === "attestation")
      throw new Error("private URL details");
    yield* t.download(resource, abort);
  };
  const work = vi.fn(async () => {
    throw new Error("callback details");
  });
  await expect(withAcquiredRelease(root, pkg, signal(), work, download)).rejects.toThrow(
    /^Release package download failed\.$/,
  );
  expect(work).toHaveBeenCalledTimes(kind === "callback-failure" ? 1 : 0);
  await clean(root);
});
it.each(["invalid-json", "invalid-utf8", "oversized-metadata", "oversized-attestation"])(
  "bounds and validates JSON transport (%s)",
  async (kind) => {
    const root = await fixture(),
      t = transport(),
      work = vi.fn();
    const download: RegistryDownload = async function* (resource, abort) {
      if (resource.kind === "metadata" && kind !== "oversized-attestation") {
        yield kind === "invalid-json"
          ? Buffer.from("{broken")
          : kind === "invalid-utf8"
            ? Buffer.from([0xc3, 0x28])
            : Buffer.alloc(2 * 1024 * 1024 + 1);
        return;
      }
      if (resource.kind === "attestation" && kind === "oversized-attestation") {
        yield Buffer.alloc(2 * 1024 * 1024 + 1);
        return;
      }
      yield* t.download(resource, abort);
    };
    await expect(withAcquiredRelease(root, pkg, signal(), work, download)).rejects.toThrow(
      "download failed",
    );
    expect(work).not.toHaveBeenCalled();
    await clean(root);
  },
);
it.each(["metadata", "archive", "attestation", "callback"])(
  "preserves cancellation at %s and drains the transport before cleanup",
  async (kind) => {
    const root = await fixture(),
      t = transport(),
      controller = new AbortController(),
      reason = new Error("caller cancelled");
    let drained = false;
    const download: RegistryDownload = async function* (resource, abort) {
      try {
        yield* t.download(resource, abort);
        if (kind === resource.kind) {
          controller.abort(reason);
          abort.throwIfAborted();
        }
      } finally {
        drained = true;
      }
    };
    const work = vi.fn(async () => {
      if (kind === "callback") controller.abort(reason);
    });
    await expect(withAcquiredRelease(root, pkg, controller.signal, work, download)).rejects.toBe(
      reason,
    );
    expect(drained).toBe(true);
    expect(work).toHaveBeenCalledTimes(kind === "callback" ? 1 : 0);
    await clean(root);
  },
);
it("keeps a single immutable request even if the caller mutates its object while downloading", async () => {
  const root = await fixture(),
    requested = { ...pkg },
    t = transport();
  const download: RegistryDownload = async function* (resource, abort) {
    if (resource.kind === "metadata") requested.version = "9.9.9";
    yield* t.download(resource, abort);
  };
  await withAcquiredRelease(
    root,
    requested,
    signal(),
    async (release) => expect(release.version).toBe("1.2.3"),
    download,
  );
  expect(t.requests.every((r) => r.version === "1.2.3")).toBe(true);
  await clean(root);
});
it.each(["permissions", "replacement", "bytes"])(
  "refuses archive %s changes during attestation retrieval",
  async (kind) => {
    const root = await fixture(),
      t = transport(),
      work = vi.fn();
    const download: RegistryDownload = async function* (resource, abort) {
      if (resource.kind === "attestation") {
        const directory = (await readdir(root)).find((name) => name.startsWith(".download-"));
        const archive = join(root, directory ?? "missing", "release.tgz");
        if (kind === "permissions") await chmod(archive, 0o600);
        else if (kind === "replacement") {
          await rename(archive, `${archive}.old`);
          await writeFile(archive, body, { mode: 0o400 });
        } else {
          await chmod(archive, 0o600);
          await writeFile(archive, Buffer.alloc(body.length));
          await chmod(archive, 0o400);
        }
      }
      yield* t.download(resource, abort);
    };
    await expect(withAcquiredRelease(root, pkg, signal(), work, download)).rejects.toThrow(
      "download failed",
    );
    expect(work).not.toHaveBeenCalled();
    await clean(root);
  },
);
it("refuses public/symlinked/noncanonical installation parents before any request", async () => {
  const root = await fixture(),
    t = transport(),
    work = vi.fn();
  await chmod(root, 0o755);
  await expect(withAcquiredRelease(root, pkg, signal(), work, t.download)).rejects.toThrow();
  await chmod(root, 0o700);
  const link = `${root}-link`;
  roots.push(link);
  await symlink(root, link);
  for (const candidate of [link, `${root}/.`, `${root}/../${root.split("/").at(-1)}`])
    await expect(withAcquiredRelease(candidate, pkg, signal(), work, t.download)).rejects.toThrow();
  expect(t.requests).toEqual([]);
  expect(work).not.toHaveBeenCalled();
  await clean(root);
});
