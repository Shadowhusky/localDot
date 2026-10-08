import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { afterEach, test } from "node:test";
import { prepareProfilePreferences } from "../browserd/src/profile-preferences.ts";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const alive = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp("/tmp/browser-preferences-");
  roots.push(root);
  const profile = `${root}/chromium`;
  const inner = `${profile}/Default`;
  await mkdir(profile, { mode: 0o700 });
  await mkdir(inner, { mode: 0o700 });
  return { root, profile, inner, prefs: `${inner}/Preferences` };
}

test("seeds the fixed Default profile and disables only the automatic download popup", async () => {
  const f = await fixture();
  await rm(f.inner, { recursive: true });
  await prepareProfilePreferences(f.profile, alive());
  assert.deepEqual(JSON.parse(await readFile(f.prefs, "utf8")), {
    download_bubble: { partial_view_enabled: false },
  });
  assert.equal((await lstat(f.prefs)).mode & 0o777, 0o600);
});

test("migrates an existing profile without clearing cookies or unrelated preferences; repeat is read-only", async () => {
  const f = await fixture();
  const preferences = {
    download_bubble: { partial_view_enabled: true, impressions: 3 },
    other: { label: "中文" },
  };
  await writeFile(f.prefs, JSON.stringify(preferences), { mode: 0o600 });
  await writeFile(`${f.inner}/Cookies`, "private-fixture-cookie", { mode: 0o600 });
  await prepareProfilePreferences(f.profile, alive());
  assert.deepEqual(JSON.parse(await readFile(f.prefs, "utf8")), {
    ...preferences,
    download_bubble: { ...preferences.download_bubble, partial_view_enabled: false },
  });
  assert.equal(await readFile(`${f.inner}/Cookies`, "utf8"), "private-fixture-cookie");
  const first = await lstat(f.prefs);
  await prepareProfilePreferences(f.profile, alive());
  const second = await lstat(f.prefs);
  assert.equal(second.ino, first.ino);
  assert.equal(second.mtimeMs, first.mtimeMs);
  assert.deepEqual((await readdir(f.inner)).sort(), ["Cookies", "Preferences"]);
});

for (const place of ["root", "Default", "Preferences"])
  test(`refuses a ${place} symlink without touching its target`, async () => {
    const f = await fixture();
    const outside = `${f.root}/outside`;
    const target = place === "Preferences" ? f.prefs : place === "Default" ? f.inner : f.profile;
    if (place === "Preferences") await writeFile(outside, "{}", { mode: 0o600 });
    else await mkdir(outside, { mode: 0o700 });
    await rm(target, { recursive: true, force: true });
    await symlink(outside, target);
    await assert.rejects(prepareProfilePreferences(f.profile, alive()));
    assert.equal(
      place === "Preferences" ? await readFile(outside, "utf8") : (await readdir(outside)).join(),
      place === "Preferences" ? "{}" : "",
    );
  });

test("refuses hard-linked preferences", async () => {
  const f = await fixture();
  await writeFile(f.prefs, "{}", { mode: 0o600 });
  await link(f.prefs, `${f.root}/outside`);
  await assert.rejects(prepareProfilePreferences(f.profile, alive()));
  assert.equal(await readFile(f.prefs, "utf8"), "{}");
});

for (const kind of ["fifo", "directory"])
  test(`refuses ${kind} preferences without blocking`, { timeout: 2000 }, async () => {
    const f = await fixture();
    if (kind === "fifo") execFileSync("mkfifo", ["-m", "600", f.prefs]);
    else await mkdir(f.prefs, { mode: 0o700 });
    await assert.rejects(prepareProfilePreferences(f.profile, alive()));
  });

for (const [label, contents] of [
  ["truncated", "{"],
  ["invalid", "not json"],
  ["array", "[]"],
  ["null", "null"],
  ["invalid section", '{"download_bubble":[]}'],
  ["invalid UTF8", Buffer.from([0xff, 0xfe])],
  ["oversized", Buffer.alloc(4 * 1024 * 1024 + 1, 32)],
])
  test(`refuses ${label} preferences without replacing the original`, async () => {
    const f = await fixture();
    await writeFile(f.prefs, contents, { mode: 0o600 });
    await assert.rejects(prepareProfilePreferences(f.profile, alive()));
    assert.deepEqual(await readFile(f.prefs), Buffer.from(contents));
    assert.deepEqual(await readdir(f.inner), ["Preferences"]);
  });

test("refuses non-private preferences", async () => {
  const f = await fixture();
  await writeFile(f.prefs, "{}", { mode: 0o600 });
  await chmod(f.prefs, 0o644);
  await assert.rejects(prepareProfilePreferences(f.profile, alive()));
  assert.equal(await readFile(f.prefs, "utf8"), "{}");
});

test("an already stopped preparation creates no profile files", async () => {
  const f = await fixture();
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(prepareProfilePreferences(f.profile, stop.signal));
  assert.deepEqual(await readdir(f.inner), []);
});
