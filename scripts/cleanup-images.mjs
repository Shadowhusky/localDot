import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rmdir } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86400;
const roles = "desktop|browser|brain|gate";
const runtime = new RegExp(`^(?:localdot/|ghcr\\.io/shadowhusky/localdot-)(${roles}):(.+)$`);
const saved = /^localdot\/(system-state|system-base|updated-system|update-backup):/;
const release = /^(?:rc(\d+)|(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?)-(arm64|amd64)$/;
const temporary = /^(before-|rollback-)|-(candidate|test|fix|debug|spike|diag)$/;
const tagsOf = (image) => [...new Set(image.RepoTags ?? [])].filter((t) => t !== "<none>:<none>");

/** Conservative mark-and-sweep: saved systems are NOT disposable runtime builds. */
export function planImages({ images, containers, references = [], now = Date.now() / 1000 }) {
  if (!Array.isArray(images) || !Array.isArray(containers)) throw new Error("Incomplete inventory");
  if (containers.some((c) => !c || !/^sha256:[a-f0-9]{64}$/.test(c.ImageID)))
    throw new Error("Incomplete container image inventory");
  const protectedIds = new Set(containers.map((c) => c.ImageID));
  const refs = new Set(references);
  const groups = new Map();
  const candidates = [];
  for (const image of images) {
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || !Number.isFinite(image.Created))
      throw new Error("Invalid image inventory");
    const tags = tagsOf(image);
    const labels = image.Labels ?? {};
    if (
      refs.has(image.Id) ||
      [...tags, ...(image.RepoDigests ?? [])].some((r) => refs.has(r)) ||
      tags.some((t) => saved.test(t)) ||
      (image.RepoDigests ?? []).some(
        (d) =>
          !/^(localdot\/(desktop|browser|brain|gate)|ghcr\.io\/shadowhusky\/localdot-(desktop|browser|brain|gate))@sha256:[a-f0-9]{64}$/.test(
            d,
          ),
      ) ||
      labels["localdot.snapshot"] ||
      labels["localdot.system-source"] ||
      labels["localdot.cell"] ||
      tags.some((t) => /:(dev|latest|stable)$/.test(t)) ||
      image.Created > now - DAY
    )
      protectedIds.add(image.Id);
    // Keep migration bases even when they have lost every tag.
    if (labels["localdot.system-base"]) protectedIds.add(labels["localdot.system-base"]);
    const kinds = tags.map((tag) => {
      const match = runtime.exec(tag);
      if (!match) return null;
      const version = release.exec(match[2]);
      if (version) return `${match[1]}:release:${version[6]}`;
      if (temporary.test(match[2])) return `${match[1]}:development`;
      return null;
    });
    // All aliases must be ours; an unrelated alias protects the entire image.
    const labelled =
      !tags.length && /^(desktop|browser|brain|gate)$/.test(labels["localdot.image-role"] ?? "");
    if (!(tags.length && kinds.every(Boolean)) && !labelled) continue;
    candidates.push(image);
    for (const group of new Set(
      labelled ? [`${labels["localdot.image-role"]}:development`] : kinds,
    )) {
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(image);
    }
  }
  // Two recent release images per role/architecture and two development rollback images.
  // Count image identities, not aliases; a multiply tagged image is only one rollback.
  for (const [key, group] of groups) {
    if (key.includes(":release:")) {
      const versionsOf = (image) =>
        tagsOf(image).flatMap((t) => {
          const tag = runtime.exec(t);
          const v = tag && release.exec(tag[2]);
          if (!v || `${tag[1]}:release:${v[6]}` !== key) return [];
          return [
            [
              Number(v[2] ?? 0),
              Number(v[3] ?? 1),
              Number(v[4] ?? 0),
              v[1] || v[5] ? 0 : 1,
              Number(v[1] ?? v[5] ?? 0),
            ],
          ];
        });
      const compare = (a, b) => {
        for (let n = 0; n < a.length; n++) if (a[n] !== b[n]) return b[n] - a[n];
        return 0;
      };
      const versions = [
        ...new Map(group.flatMap((i) => versionsOf(i).map((v) => [v.join("."), v]))).values(),
      ]
        .sort(compare)
        .slice(0, 2);
      for (const image of group)
        if (versionsOf(image).some((iv) => versions.some((v) => compare(v, iv) === 0)))
          protectedIds.add(image.Id);
    } else
      for (const image of group
        .sort((a, b) => b.Created - a.Created || a.Id.localeCompare(b.Id))
        .slice(0, 2))
        protectedIds.add(image.Id);
  }
  return candidates
    .filter((i) => !protectedIds.has(i.Id))
    .map((i) => ({
      id: i.Id,
      tags: tagsOf(i),
      size: i.Size,
    }));
}

/** Never log private records. Any unreadable/malformed record aborts the cleanup. */
export async function readReferences(home) {
  const refs = new Set();
  const hash = createHash("sha256");
  const visit = (value) => {
    if (typeof value === "string") {
      if (
        /^sha256:[a-f0-9]{64}$/.test(value) ||
        /^(localdot\/|ghcr\.io\/shadowhusky\/localdot-)/.test(value)
      )
        refs.add(value);
      for (const digest of value.matchAll(/sha256:[a-f0-9]{64}/g)) refs.add(digest[0]);
    } else if (value && typeof value === "object")
      for (const child of Object.values(value)) visit(child);
  };
  async function walk(path, depth = 0) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || depth > 12) throw new Error("Unsafe metadata path");
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), depth + 1);
    } else if (path.endsWith(".json")) {
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid metadata file");
      const content = await readFile(path);
      hash.update(path).update(content);
      try {
        const value = JSON.parse(content.toString("utf8"));
        if (!value || typeof value !== "object") throw new Error("Invalid record");
        visit(value);
      } catch {
        throw new Error("Invalid localDot metadata; cleanup refused");
      }
    }
  }
  // Installed payloads are intentionally excluded: installed releases require the installer lock.
  // This maintenance command supports source/dev installs only for now.
  if (
    await lstat(join(home, "install")).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    })
  )
    throw new Error("Use the installed-release manager for this installation; cleanup refused");
  for (const entry of (await readdir(home)).sort())
    if (entry.endsWith(".json")) await walk(join(home, entry));
  for (const role of ["DESKTOP", "BROWSER", "BRAIN", "GATE"])
    if (process.env[`LOCALDOT_${role}_IMAGE`]) refs.add(process.env[`LOCALDOT_${role}_IMAGE`]);
  await walk(join(home, "safety"));
  // Cell records have tokens: only the fingerprint and image references leave this function.
  for (const entry of (await readdir(join(home, "cells"))).sort()) {
    const path = join(home, "cells", entry, "cell.json");
    await walk(path);
  }
  return { references: [...refs], fingerprint: hash.digest("hex") };
}

// Every dot of this user shares the Docker engine, so an image one dot still needs is never
// another dot's to delete: references come from every registered home.
export async function registeredHomes(home, env = process.env) {
  const file = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "localdot", "dots.json");
  let registry;
  try {
    registry = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [home];
    throw new Error("The list of dots can't be read; cleanup refused");
  }
  const homes =
    registry?.v === 1 && Array.isArray(registry.dots)
      ? registry.dots.map((dot) => dot?.home)
      : null;
  if (!homes?.length || !homes.every((path) => typeof path === "string" && path.startsWith("/")))
    throw new Error("The list of dots isn't valid; cleanup refused");
  return [...new Set([home, ...homes.map((path) => resolve(path))])];
}

export async function readAllReferences(homes) {
  const references = new Set();
  const hash = createHash("sha256");
  for (const home of homes) {
    const found = await readReferences(home);
    for (const reference of found.references) references.add(reference);
    hash.update(home).update(found.fingerprint);
  }
  return { references: [...references], fingerprint: hash.digest("hex") };
}

export function dockerApi(socketPath) {
  return (method, path) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method, path: `/v1.47${path}`, agent: false }, (res) => {
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) req.destroy(new Error("Inventory too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`Docker ${method} failed (${res.statusCode})`);
            error.status = res.statusCode;
            reject(error);
          } else {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
            } catch {
              reject(new Error("Invalid Docker response"));
            }
          }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("Docker request timed out")), 30000);
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end();
    });
}

export async function cleanupImages({ api, metadata, apply = false, now, report = () => {} }) {
  const inventory = async () => ({
    images: await api("GET", "/images/json?all=true"),
    containers: await api("GET", "/containers/json?all=true"),
    ...(await metadata()),
    now,
  });
  const initial = await inventory();
  const plan = planImages(initial);
  report({
    phase: "preview",
    images: plan,
    count: plan.length,
    note: "Image sizes share layers; they are not reclaimed-byte estimates.",
  });
  if (!apply) return { plan, removed: [] };
  const removed = [];
  for (const item of plan) {
    // Never expand a plan midway through execution. Stop on metadata changes or failed reads.
    const fresh = await inventory();
    if (fresh.fingerprint !== initial.fingerprint)
      throw new Error("Computer metadata changed; rerun preview");
    const eligible = planImages(fresh).find((i) => i.id === item.id);
    if (
      !eligible ||
      JSON.stringify([...eligible.tags].sort()) !== JSON.stringify([...item.tags].sort())
    )
      continue;
    // Untag only reviewed localDot aliases after checking their identity again. Never force a
    // deletion; Docker's last-reference/container protection remains active. Run between builds.
    try {
      for (const tag of item.tags.slice(0, -1)) {
        const checked = await inventory();
        if (checked.fingerprint !== initial.fingerprint)
          throw new Error("Computer metadata changed; cleanup stopped");
        if (!planImages(checked).some((i) => i.id === item.id))
          throw new Error("Image became protected; cleanup stopped");
        const current = await api("GET", `/images/${encodeURIComponent(tag)}/json`);
        if (current.Id !== item.id) throw new Error("Image tag changed; cleanup stopped");
        await api("DELETE", `/images/${encodeURIComponent(tag)}?force=false&noprune=true`);
      }
      const final = await inventory();
      if (
        final.fingerprint !== initial.fingerprint ||
        !planImages(final).some((i) => i.id === item.id)
      )
        throw new Error("Image references changed; cleanup stopped");
      await api("DELETE", `/images/${encodeURIComponent(item.id)}?force=false&noprune=true`);
      removed.push(item.id);
      report({ phase: "removed", id: item.id, tags: item.tags });
    } catch (error) {
      if (error.status !== 409) throw error;
      report({
        phase: "retained",
        id: item.id,
        reason: "Docker protects a container, another alias, or a dependent image.",
      });
    }
  }
  return { plan, removed };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--apply"))
    throw new Error("Usage: pnpm images:cleanup [--apply]");
  const home = resolve(process.env.LOCALDOT_HOME || join(homedir(), ".localdot"));
  const socket = process.env.LOCALDOT_DOCKER_SOCKET || "/var/run/docker.sock";
  const lock = join(home, "image-cleanup.lock");
  const homes = await registeredHomes(home);
  await mkdir(lock, { mode: 0o700 });
  try {
    const result = await cleanupImages({
      api: dockerApi(socket),
      metadata: () => readAllReferences(homes),
      apply: args[0] === "--apply",
      report: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ removed: result.removed.length, preview: !args.length }));
  } finally {
    await rmdir(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
