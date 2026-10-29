import { describe, expect, it } from "vitest";
import {
  AUTO_INSTALLED,
  changedDatabases,
  contentHash,
  mergeAutoInstalled,
  mergePackageDatabases,
  mergePackageStatus,
  PACKAGE_STATUS,
} from "./package-status.ts";
import {
  type Manifest,
  migrationPlan,
  SystemMigrationConflict,
  verifyMigration,
} from "./system-migration-plan.ts";

const record = (name: string, version = "1", arch = "arm64") =>
  `Package: ${name}\nStatus: install ok installed\nArchitecture: ${arch}\nVersion: ${version}\nDescription: example\n continued\n\n`;
const auto = (name: string, mark = "1", arch = "arm64") =>
  `Package: ${name}\nArchitecture: ${arch}\nAuto-Installed: ${mark}\n\n`;
const entry = (text: string): Manifest[string] => ["f", 0o644, 0, 0, contentHash(text)];
const conflictOn = (path: string, run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SystemMigrationConflict);
    expect((error as SystemMigrationConflict).paths).toEqual([path]);
    return;
  }
  throw new Error("expected a conflict");
};
const huge = (text: string) => text + " ".repeat(16 * 1024 * 1024);

describe("dpkg status", () => {
  it("accepts the same GitHub CLI added upstream and locally while keeping a user app", () => {
    const base = record("libc6"),
      target = base + record("gh"),
      current = target + record("wechat");
    expect(mergePackageStatus(base, target, current)).toBe(current);
  });

  it("merges independent package upgrades, additions and removals including architectures", () => {
    const base = record("alpha") + record("remove-me") + record("multi", "1", "amd64");
    const target = record("alpha", "2") + record("multi", "1", "amd64") + record("multi");
    const current = base + record("user-app");
    const merged = mergePackageStatus(base, target, current);
    expect(merged).toContain(record("alpha", "2"));
    expect(merged).not.toContain("remove-me");
    expect(merged).toContain(record("user-app"));
    expect(merged).toContain(record("multi", "1", "amd64"));
    expect(merged).toContain(record("multi"));
  });

  it("rejects incompatible versions, deletion versus update, malformed and duplicate records", () => {
    conflictOn(PACKAGE_STATUS, () =>
      mergePackageStatus(record("gh"), record("gh", "2"), record("gh", "3")),
    );
    conflictOn(PACKAGE_STATUS, () => mergePackageStatus(record("gh"), record("gh", "2"), ""));
    for (const invalid of [
      record("gh") + record("gh"),
      "Package: gh\n",
      " orphan\n",
      record("gh").replace("Version: 1", "Status: duplicate"),
      record("gh").replace("\n", "\r\n"),
      "\0",
      huge(record("gh")),
    ])
      conflictOn(PACKAGE_STATUS, () => mergePackageStatus("", "", invalid));
  });
});

describe("APT's automatic-install marks", () => {
  const status = (...names: string[]) => names.map((name) => record(name)).join("");

  it("keeps the dependencies both sides installed, as each marked them", () => {
    // The new image's fonts and the user's app each pulled in their own libraries.
    const base = auto("libbase");
    const target = base + auto("libfont");
    const current = base + auto("libapp");
    const merged = mergeAutoInstalled(
      [base, target, current],
      [status("libbase"), status("libbase", "libfont"), status("libbase", "libapp")],
    );
    expect(merged).toBe(base + auto("libapp") + auto("libfont"));
  });

  it("applies the new image's marks and removals for packages the user left alone", () => {
    const base = auto("dropped") + auto("remarked");
    const target = auto("remarked", "0") + auto("added");
    const merged = mergeAutoInstalled(
      [base, target, base],
      [status("dropped", "remarked"), status("remarked", "added"), status("dropped", "remarked")],
    );
    expect(merged).toBe(auto("remarked", "0") + auto("added"));
  });

  it("refuses a mark both sides changed differently", () => {
    const base = auto("shared");
    const extra = (value: string) => base.replace("\n\n", `\nX-Note: ${value}\n\n`);
    conflictOn(AUTO_INSTALLED, () =>
      mergeAutoInstalled(
        [base, extra("image"), extra("user")],
        [status("shared"), status("shared"), status("shared")],
      ),
    );
  });

  it("never marks a package the user installed by name as automatic", () => {
    // Both installed the same build of an architecture-independent package; dpkg says "all".
    const shared = record("python3-shared", "1", "all");
    const target = auto("python3-shared");
    const merged = mergeAutoInstalled(
      [auto("base"), auto("base") + target, auto("base")],
      [record("base"), record("base") + shared, record("base") + shared],
    );
    expect(merged).toBe(auto("base"));
    // The other way round: the image asked for it by name, the user only as a dependency.
    expect(
      mergeAutoInstalled(
        ["", "", target],
        [record("base"), record("base") + shared, record("base") + shared],
      ),
    ).toBe("");
  });

  it("keeps the user's manual mark on a package the new image upgraded", () => {
    const merged = mergeAutoInstalled(
      [auto("lib"), auto("lib"), ""],
      [record("lib"), record("lib", "2"), record("lib")],
    );
    expect(merged).toBe("");
  });

  it("rejects malformed, duplicate, unmarked and oversized marks", () => {
    for (const invalid of [
      auto("lib") + auto("lib"),
      "Package: lib\nAuto-Installed: 1\n\n",
      "Package: lib\nArchitecture: arm64\n\n",
      auto("lib").replace("Package", "Package: again\nPackage"),
      " orphan\n",
      auto("lib").replace("\n", "\r\n"),
      "\0",
      huge(auto("lib")),
    ])
      conflictOn(AUTO_INSTALLED, () => mergeAutoInstalled(["", "", invalid], ["", "", ""]));
    conflictOn(PACKAGE_STATUS, () => mergeAutoInstalled(["", "", ""], ["", "", "Package: x\n"]));
  });
});

describe("merging the scanned databases", () => {
  const texts = {
    base: { [PACKAGE_STATUS]: record("libc6"), [AUTO_INSTALLED]: auto("libbase") },
    target: {
      [PACKAGE_STATUS]: record("libc6") + record("fonts"),
      [AUTO_INSTALLED]: auto("libbase") + auto("libfont"),
    },
    current: {
      [PACKAGE_STATUS]: record("libc6") + record("app"),
      [AUTO_INSTALLED]: auto("libbase") + auto("libapp"),
    },
  };
  const manifestOf = (side: Record<string, string>): Manifest =>
    Object.fromEntries(Object.entries(side).map(([path, text]) => [path, entry(text)]));
  const sides = () =>
    [texts.base, texts.target, texts.current].map((side) => ({ ...side })) as Record<
      string,
      string | null
    >[];
  const manifests = () =>
    [texts.base, texts.target, texts.current].map(manifestOf) as [Manifest, Manifest, Manifest];

  it("merges both databases and checks the result like any other updated file", () => {
    const all = manifests();
    const paths = changedDatabases(all);
    expect(paths).toEqual([PACKAGE_STATUS, AUTO_INSTALLED]);
    const merged = mergePackageDatabases(paths, all, sides());
    expect(merged.get(AUTO_INSTALLED)?.text).toBe(
      auto("libbase") + auto("libapp") + auto("libfont"),
    );
    const [base, target, current] = all;
    const before = { ...base },
      after = { ...target };
    for (const [path, result] of merged) {
      before[path] = current[path] as Manifest[string];
      after[path] = result.entry;
    }
    const plan = migrationPlan(before, after, current);
    expect(plan.copy.sort()).toEqual([AUTO_INSTALLED, PACKAGE_STATUS].sort());
    verifyMigration(current, after, after, plan);
    expect(() =>
      verifyMigration(
        current,
        after,
        { ...after, [AUTO_INSTALLED]: target[AUTO_INSTALLED] as Manifest[string] },
        plan,
      ),
    ).toThrow("verification failed");
    expect(() => verifyMigration(current, after, current, plan)).toThrow("verification failed");
  });

  it("leaves a database that only one side changed to the ordinary file merge", () => {
    const all = manifests();
    all[2][AUTO_INSTALLED] = all[0][AUTO_INSTALLED] as Manifest[string];
    expect(changedDatabases(all)).toEqual([PACKAGE_STATUS]);
    delete all[0][PACKAGE_STATUS];
    expect(changedDatabases(all)).toEqual([]);
  });

  it("keeps local metadata when upstream did not change it, and refuses three-way metadata", () => {
    const all = manifests();
    (all[2][AUTO_INSTALLED] as Manifest[string])[1] = 0o600;
    expect(
      mergePackageDatabases([AUTO_INSTALLED], all, sides()).get(AUTO_INSTALLED)?.entry[1],
    ).toBe(0o600);
    (all[1][AUTO_INSTALLED] as Manifest[string])[1] = 0o640;
    conflictOn(AUTO_INSTALLED, () => mergePackageDatabases([AUTO_INSTALLED], all, sides()));
  });

  it("refuses any text that isn't the exact file the scan saw", () => {
    const tampered = sides();
    tampered[2] = { ...tampered[2], [AUTO_INSTALLED]: `${texts.current[AUTO_INSTALLED]}\n` };
    conflictOn(AUTO_INSTALLED, () =>
      mergePackageDatabases([AUTO_INSTALLED], manifests(), tampered),
    );
    const unreadable = sides();
    unreadable[0] = { ...unreadable[0], [AUTO_INSTALLED]: null };
    conflictOn(AUTO_INSTALLED, () =>
      mergePackageDatabases([AUTO_INSTALLED], manifests(), unreadable),
    );
    // The marks are merged with what each side did to the packages, so those are checked too.
    const status = sides();
    status[1] = { ...status[1], [PACKAGE_STATUS]: null };
    conflictOn(PACKAGE_STATUS, () => mergePackageDatabases([AUTO_INSTALLED], manifests(), status));
    const linked = manifests();
    linked[2][AUTO_INSTALLED] = ["l", 0o777, 0, 0, "/tmp/elsewhere"];
    conflictOn(AUTO_INSTALLED, () => mergePackageDatabases([AUTO_INSTALLED], linked, sides()));
    conflictOn(AUTO_INSTALLED, () => mergePackageDatabases([AUTO_INSTALLED], manifests(), []));
  });
});
