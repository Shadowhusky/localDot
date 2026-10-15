import { expect, it } from "vitest";
import { mergedStatusEntry, mergePackageStatus, statusHash } from "./package-status.ts";
import { type Manifest, migrationPlan, verifyMigration } from "./system-migration-plan.ts";

const record = (name: string, version = "1", arch = "arm64") =>
  `Package: ${name}\nStatus: install ok installed\nArchitecture: ${arch}\nVersion: ${version}\nDescription: example\n continued\n\n`;
const entry = (text: string): Manifest[string] => ["f", 0o644, 0, 0, statusHash(text)];
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
  expect(() => mergePackageStatus(record("gh"), record("gh", "2"), record("gh", "3"))).toThrow();
  expect(() => mergePackageStatus(record("gh"), record("gh", "2"), "")).toThrow();
  for (const invalid of [
    record("gh") + record("gh"),
    "Package: gh\n",
    " orphan\n",
    record("gh").replace("Version: 1", "Status: duplicate"),
    "\0",
  ])
    expect(() => mergePackageStatus("", "", invalid)).toThrow();
});
it("verifies merged bytes and preserves local metadata without hiding other conflicts", () => {
  const texts: [string, string, string] = [
    record("alpha"),
    record("alpha", "2"),
    record("alpha") + record("local"),
  ];
  const entries: [Manifest[string], Manifest[string], Manifest[string]] = texts.map(
    entry,
  ) as typeof entries;
  entries[2][1] = 0o600;
  const merged = mergedStatusEntry(entries, texts);
  expect(merged.entry[1]).toBe(0o600);
  const path = "/var/lib/dpkg/status";
  const current = { [path]: entries[2] },
    target = { [path]: merged.entry };
  const plan = migrationPlan(current, target, current);
  verifyMigration(current, target, target, plan);
  expect(() => verifyMigration(current, target, { [path]: entries[1] }, plan)).toThrow();
  expect(() => mergedStatusEntry(entries, [texts[0], texts[1], "tampered"])).toThrow();
  expect(() =>
    migrationPlan(
      { ...current, "/bin/x": entry("old") },
      { ...target, "/bin/x": entry("new") },
      { ...current, "/bin/x": entry("user") },
    ),
  ).toThrow();
});
