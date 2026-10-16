import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cleanupImages, planImages, readReferences } from "./cleanup-images.mjs";

const now = 2_000_000;
const id = (n) => `sha256:${n.toString(16).padStart(64, "0")}`;
const image = (n, tags, extra = {}) => ({
  Id: id(n),
  RepoTags: tags,
  Created: n,
  Size: 100,
  ...extra,
});
const rollbacks = [
  image(100, ["localdot/brain:before-a"]),
  image(101, ["localdot/brain:before-b"]),
];
const plan = (images, rest = {}) =>
  planImages({ images: [...rollbacks, ...images], containers: [], now, ...rest });

test("removes only old known runtime builds; keeps two rollback generations", () => {
  expect(plan([image(1, ["localdot/brain:old-candidate"])]).map((i) => i.id)).toEqual([id(1)]);
  expect(plan([])).toEqual([]);
});
test("preserves current images, recent builds, unrelated aliases, unknown tags and unowned dangling images", () => {
  expect(
    plan([
      image(1, ["localdot/brain:dev", "localdot/brain:old-candidate"]),
      image(2, ["localdot/brain:latest"]),
      image(3, ["other/app:before-a"]),
      image(4, ["localdot/brain:old-candidate", "other/app:test"]),
      image(5, ["localdot/brain:custom"]),
      image(6, []),
      image(7, ["localdot/brain:new-candidate"], { Created: now - 60 }),
    ]).filter((i) => ![id(100), id(101)].includes(i.id)),
  ).toEqual([]);
});
test("protects stopped containers, recorded image IDs, tags and registry digests", () => {
  const images = [1, 2, 3, 4].map((n) => image(n, [`localdot/brain:old${n}-candidate`]));
  images[3].RepoDigests = [`ghcr.io/shadowhusky/localdot-brain@${id(40)}`];
  expect(
    plan(images, {
      containers: [{ ImageID: id(1), State: "exited" }],
      references: [id(2), images[2].RepoTags[0], images[3].RepoDigests[0]],
    }),
  ).toEqual([]);
});
test("preserves every saved system category and untagged migration bases", () => {
  expect(
    plan([
      ...["system-state", "updated-system", "update-backup", "system-base"].map((r, n) =>
        image(n + 1, [`localdot/${r}:test`]),
      ),
      image(5, [], { Labels: { "localdot.image-role": "brain" } }),
      image(6, ["localdot/brain:old-candidate"], {
        Labels: { "localdot.system-base": id(5), "localdot.system-source": "source" },
      }),
    ]),
  ).toEqual([]);
});
test("keeps newest two release versions per architecture, even with identical build timestamps", () => {
  const images = [17, 18, 19, 20].flatMap((v) =>
    ["arm64", "amd64"].map((arch, n) =>
      image(
        v * 2 + n,
        [
          `localdot/brain:rc${v}-${arch}`,
          `ghcr.io/shadowhusky/localdot-brain:0.1.0-rc.${v}-${arch}`,
        ],
        { Created: 1 },
      ),
    ),
  );
  expect(plan(images).map((i) => i.id)).toEqual([id(34), id(35), id(36), id(37)]);
});
test("refuses malformed inventories", () => {
  expect(() => planImages({ images: [], containers: null })).toThrow();
  expect(() => plan([image(1, [], { Id: "oops" })])).toThrow();
});

function fixture(extra = {}) {
  let images = [
    ...rollbacks,
    image(1, ["localdot/brain:old-candidate", "localdot/brain:before-old"]),
  ];
  const mutations = [];
  const api = async (method, path) => {
    if (method === "GET" && path.startsWith("/images/json")) return structuredClone(images);
    if (method === "GET" && path.startsWith("/containers/json")) return extra.containers?.() ?? [];
    if (method === "GET") return { Id: extra.retag ? id(999) : id(1) };
    mutations.push(path);
    if (extra.conflict) throw Object.assign(new Error("conflict"), { status: 409 });
    const ref = decodeURIComponent(path.split("/")[2].split("?")[0]);
    if (ref.startsWith("sha256:")) images = images.filter((i) => i.Id !== ref);
    else images = images.map((i) => ({ ...i, RepoTags: i.RepoTags.filter((t) => t !== ref) }));
    return [];
  };
  return { api, metadata: async () => ({ fingerprint: "same", references: [] }), now, mutations };
}
test("preview has no Docker mutations", async () => {
  const f = fixture();
  expect((await cleanupImages(f)).plan).toHaveLength(1);
  expect(f.mutations).toEqual([]);
});
test("deletes only reviewed aliases and exact image without force or ancestor pruning", async () => {
  const f = fixture();
  expect((await cleanupImages({ ...f, apply: true })).removed).toEqual([id(1)]);
  expect(f.mutations).toHaveLength(2);
  expect(f.mutations.every((p) => p.endsWith("?force=false&noprune=true"))).toBe(true);
});
test("never follows a retagged alias", async () => {
  const f = fixture({ retag: true });
  await expect(cleanupImages({ ...f, apply: true })).rejects.toThrow("tag changed");
  expect(f.mutations).toEqual([]);
});
test("aborts when recovery metadata changes", async () => {
  const f = fixture();
  let reads = 0;
  await expect(
    cleanupImages({
      ...f,
      apply: true,
      metadata: async () => ({ references: [], fingerprint: String(reads++) }),
    }),
  ).rejects.toThrow("metadata changed");
  expect(f.mutations).toEqual([]);
});
test("protects a newly created container and handles Docker conflicts", async () => {
  let reads = 0;
  const f = fixture({ containers: () => (++reads > 1 ? [{ ImageID: id(1) }] : []) });
  expect((await cleanupImages({ ...f, apply: true })).removed).toEqual([]);
  expect(f.mutations).toEqual([]);
  const conflict = fixture({ conflict: true });
  expect((await cleanupImages({ ...conflict, apply: true })).removed).toEqual([]);
});

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "localdot-image-cleanup-"));
  dirs.push(root);
  await mkdir(join(root, "safety"));
  await mkdir(join(root, "cells"));
  return root;
}
test("extracts image references without exposing credentials and fails on broken records", async () => {
  const root = await home();
  await writeFile(
    join(root, "safety", "snapshot.json"),
    JSON.stringify({ image: id(1), token: "private-value" }),
  );
  expect((await readReferences(root)).references).toEqual([id(1)]);
  await writeFile(join(root, "safety", "snapshot.json"), "{");
  await expect(readReferences(root)).rejects.toThrow();
});
test("refuses installed-release metadata without the installer lock", async () => {
  const root = await home();
  await mkdir(join(root, "install"));
  await expect(readReferences(root)).rejects.toThrow("installed-release manager");
});

test("protects a foreign repository digest even if tags look disposable", () => {
  expect(
    plan([
      image(1, ["localdot/brain:old-candidate"], { RepoDigests: [`other/repository@${id(40)}`] }),
    ]),
  ).toEqual([]);
  expect(() => plan([], { containers: [{}] })).toThrow("Incomplete container");
});
test("metadata errors never disclose raw private contents", async () => {
  const root = await home();
  await writeFile(join(root, "safety", "broken.json"), "private-secret-not-json");
  await expect(readReferences(root)).rejects.toThrow(
    /^Invalid localDot metadata; cleanup refused$/,
  );
});

test("a newer release alias protects the same image under an older alias", () => {
  const images = [
    image(1, ["localdot/brain:rc1-arm64", "localdot/brain:rc20-arm64"]),
    image(2, ["localdot/brain:rc18-arm64"]),
    image(3, ["localdot/brain:rc19-arm64"]),
  ];
  expect(plan(images).map((i) => i.id)).toEqual([id(2)]);
});
test("a labelled untagged build is eligible only outside retention", () => {
  expect(
    plan([image(1, [], { Labels: { "localdot.image-role": "brain" } })]).map((i) => i.id),
  ).toEqual([id(1)]);
});
