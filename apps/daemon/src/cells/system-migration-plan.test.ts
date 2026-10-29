import { describe, expect, it } from "vitest";
import { archivePayload, helperOutput } from "./system-migration.ts";
import {
  LIBRARY_CACHE,
  LIBRARY_ID_CACHE,
  type Manifest,
  migrationPlan,
  SystemMigrationConflict,
  verifyMigration,
} from "./system-migration-plan.ts";
import { tar } from "./tar.ts";

const file = (text: string): Manifest[string] => ["f", 0o755, 1000, 1000, text];
const dir: Manifest[string] = ["d", 0o755, 0, 0, ""];
it("updates upstream files while preserving installed apps, permissions and user deletions", () => {
  const base = {
    "/bin": dir,
    "/bin/runtime": file("old"),
    "/bin/removed": file("old"),
    "/etc/user-disabled": file("old"),
  };
  const target = {
    "/bin": dir,
    "/bin/runtime": file("new"),
    "/bin/added": file("new"),
    "/etc/user-disabled": file("old"),
  };
  const current = {
    "/bin": dir,
    "/bin/runtime": file("old"),
    "/bin/removed": file("old"),
    "/opt/app": file("installed"),
  };
  const plan = migrationPlan(base, target, current);
  expect(plan.copy).toEqual(["/bin/runtime", "/bin/added"]);
  expect(plan.remove).toEqual(["/bin/removed"]);
  const result = {
    "/bin": dir,
    "/bin/runtime": file("new"),
    "/bin/added": file("new"),
    "/opt/app": file("installed"),
  };
  expect(() => verifyMigration(current, target, result, plan)).not.toThrow();
  expect(() =>
    verifyMigration(current, target, { ...result, "/opt/app": file("lost") }, plan),
  ).toThrow("verification failed");
});
it("rejects overlapping user changes and symlink ancestors before copying anything", () => {
  expect(() =>
    migrationPlan({ "/bin/a": file("old") }, { "/bin/a": file("new") }, { "/bin/a": file("user") }),
  ).toThrow(SystemMigrationConflict);
  expect(() =>
    migrationPlan(
      { "/bin/a": file("old") },
      { "/bin/a": file("new") },
      { "/bin/a": file("old"), "/bin": ["l", 0o777, 0, 0, "/elsewhere"] },
    ),
  ).toThrow(SystemMigrationConflict);
});
it("retains user files in an upstream-removed directory", () => {
  const base = { "/opt/old": dir, "/opt/old/owned": file("old") };
  const current = { ...base, "/opt/old/user": file("user") };
  const plan = migrationPlan(base, {}, current);
  verifyMigration(current, {}, { "/opt/old": dir, "/opt/old/user": file("user") }, plan);
});
it("accepts already-applied changes and refuses unsafe paths", () => {
  expect(
    migrationPlan({ "/a": file("old") }, { "/a": file("new") }, { "/a": file("new") }),
  ).toEqual({ copy: [], remove: [], directories: [], ldconfig: false });
  expect(() => migrationPlan({}, { "/../outside": file("new") }, {})).toThrow(
    "Invalid migration path",
  );
});
describe("ldconfig's caches", () => {
  const cache = (text: string, mode = 0o600): Manifest[string] => ["f", mode, 0, 0, text];
  const loader = (text: string) => cache(text, 0o644);

  it("keeps the user's library identity cache when both sides rewrote it", () => {
    const current = { [LIBRARY_ID_CACHE]: cache("user"), "/opt/app": file("installed") };
    const target = { [LIBRARY_ID_CACHE]: cache("image"), "/usr/lib/libfont": file("new") };
    const plan = migrationPlan({ [LIBRARY_ID_CACHE]: cache("old") }, target, current);
    expect(plan).toEqual({
      copy: ["/usr/lib/libfont"],
      remove: [],
      directories: [],
      ldconfig: false,
    });
    verifyMigration(current, target, { ...current, "/usr/lib/libfont": file("new") }, plan);
  });

  it("rebuilds the loader's index when both sides added libraries", () => {
    const base = { [LIBRARY_CACHE]: loader("old"), [LIBRARY_ID_CACHE]: cache("old") };
    const target = {
      [LIBRARY_CACHE]: loader("image"),
      [LIBRARY_ID_CACHE]: cache("image"),
      "/usr/lib/libfont.so.1": file("new"),
    };
    const current = {
      [LIBRARY_CACHE]: loader("user"),
      [LIBRARY_ID_CACHE]: cache("old"),
      "/usr/local/lib/libapp.so.1": file("installed"),
    };
    const plan = migrationPlan(base, target, current);
    // ldconfig rewrites its identity cache too, so it isn't copied first.
    expect(plan).toEqual({
      copy: ["/usr/lib/libfont.so.1"],
      remove: [],
      directories: [],
      ldconfig: true,
    });
    const rebuilt = {
      ...current,
      [LIBRARY_CACHE]: loader("both"),
      [LIBRARY_ID_CACHE]: cache("rebuilt"),
      "/usr/lib/libfont.so.1": file("new"),
    };
    verifyMigration(current, target, rebuilt, plan);
    for (const wrong of [
      { ...rebuilt, [LIBRARY_CACHE]: cache("both", 0o600) },
      { ...rebuilt, [LIBRARY_ID_CACHE]: ["f", 0o600, 1000, 0, "rebuilt"] as Manifest[string] },
      { ...rebuilt, [LIBRARY_CACHE]: ["l", 0o777, 0, 0, "/tmp/cache"] as Manifest[string] },
      { ...rebuilt, "/etc/ld.so.cache~": loader("left over") },
      { ...rebuilt, "/usr/local/lib/libapp.so.1": file("lost") },
    ])
      expect(() => verifyMigration(current, target, wrong, plan)).toThrow("verification failed");
    const { [LIBRARY_ID_CACHE]: _, ...missing } = rebuilt;
    expect(() => verifyMigration(current, target, missing, plan)).toThrow("verification failed");
  });

  it("refuses a loader index that isn't a plain file on every side", () => {
    expect(() =>
      migrationPlan(
        { [LIBRARY_CACHE]: loader("old") },
        { [LIBRARY_CACHE]: loader("image") },
        { [LIBRARY_CACHE]: ["l", 0o777, 0, 0, "/tmp/elsewhere"] },
      ),
    ).toThrow(SystemMigrationConflict);
  });
});

it("unwraps exact binary archive data and rejects corrupt or truncated envelopes", () => {
  const bytes = Buffer.from([0, 255, 192, 128, 10]);
  const envelope = tar([{ name: "localdot-update.tar", data: bytes }]);
  expect(archivePayload(envelope)).toEqual(bytes);
  expect(() => archivePayload(envelope.subarray(0, 514))).toThrow();
  const damaged = Buffer.from(envelope);
  damaged[0] = 1;
  expect(() => archivePayload(damaged)).toThrow();
  expect(() => archivePayload(tar([{ name: "other", data: bytes }]))).toThrow();
});
it("decodes framed helper output and rejects truncated frames", () => {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(3, 4);
  expect(helperOutput(Buffer.concat([header, Buffer.from("abc")]))).toEqual(Buffer.from("abc"));
  expect(() => helperOutput(Buffer.concat([header, Buffer.from("ab")]))).toThrow();
});
