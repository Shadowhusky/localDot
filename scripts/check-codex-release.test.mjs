import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_VERSION } from "../harness/codex/src/version.ts";
import {
  digest,
  makeRecord,
  REQUIRED_PROBES,
  releaseInputs,
  validateProbeReport,
  verifyRecord,
} from "./check-codex-release.mjs";

// These are pure gate tests. Only the separate opt-in suite proves actual binary behavior.
const clone = (value) => JSON.parse(JSON.stringify(value));
const owned = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true });
});
function sourceTree() {
  const root = mkdtempSync("/tmp/ld-release-gate-");
  owned.push(root);
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vitest.config.ts",
    "vitest.codex.config.ts",
    "scripts/check-codex-release.mjs",
    "scripts/check-codex-release.test.mjs",
    ".github/workflows/ci.yml",
    "harness/codex/src/args.ts",
    "harness/codex/src/install.ts",
    "harness/codex/src/testing/pinned-fixture.ts",
    "apps/daemon/src/agent/codex/driver.ts",
    "apps/daemon/src/agent/codex/codex-harness.codex.test.ts",
    "packages/protocol/src/fixture.ts",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "inert source fixture");
  }
  return root;
}
function fixture() {
  const schema = JSON.parse(
    readFileSync(
      new URL(`../harness/codex/schema/contract-${CODEX_VERSION}.json`, import.meta.url),
      "utf8",
    ),
  );
  const report = {
    success: true,
    numTotalTests: REQUIRED_PROBES.length,
    numPassedTests: REQUIRED_PROBES.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      {
        status: "passed",
        message: "",
        assertionResults: REQUIRED_PROBES.map((title) => ({
          title,
          fullName: `actual pinned Codex ${CODEX_VERSION} offline acceptance ${title}`,
          status: "passed",
          failureMessages: [],
          duration: 1,
        })),
      },
    ],
  };
  const evidence = {
    inputs: { "harness/codex/src/args.ts": "a".repeat(64) },
    manifest: { fixture: true },
    expectedSchema: schema,
    generatedSchema: clone(schema),
    report,
    exit: { code: 0, signal: null },
  };
  return { evidence, record: makeRecord(evidence) };
}
describe("pinned release gate", () => {
  it("binds modified and newly added production source files without hashing recursive acceptance outputs", () => {
    const root = sourceTree(),
      before = releaseInputs(root);
    mkdirSync(join(root, "harness/codex/acceptance"));
    writeFileSync(
      join(root, "harness/codex/acceptance/offline-record.json"),
      "inert prior receipt",
    );
    expect(releaseInputs(root)).toEqual(before);
    writeFileSync(join(root, "harness/codex/src/args.ts"), "changed source fixture");
    expect(releaseInputs(root)["harness/codex/src/args.ts"]).not.toBe(
      before["harness/codex/src/args.ts"],
    );
    writeFileSync(join(root, "apps/daemon/src/new-boundary.ts"), "new source fixture");
    expect(releaseInputs(root)["apps/daemon/src/new-boundary.ts"]).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses missing critical sources and source symlinks before following them", () => {
    const root = sourceTree();
    rmSync(join(root, "harness/codex/src/args.ts"));
    expect(() => releaseInputs(root)).toThrow(/Missing required release source/);
    symlinkSync(join(root, "package.json"), join(root, "harness/codex/src/args.ts"));
    expect(() => releaseInputs(root)).toThrow(/cannot be links/);
  });
  it("requires a complete passing probe report, schema and source-bound record", () => {
    const { evidence, record } = fixture();
    expect(verifyRecord(record, evidence)).toBe(true);
    expect(record.nativeSandbox).toBe("unverified");
    expect(record.realAccount).toBe("not-run");
  });
  it.each(["failed", "pending", "skipped", "todo"])(
    "refuses a %s pinned probe even if the report claims success",
    (status) => {
      const { evidence } = fixture();
      evidence.report.testResults[0].assertionResults[5].status = status;
      expect(() => validateProbeReport(evidence.report, evidence.exit)).toThrow();
    },
  );
  it("refuses omitted or duplicated security probes", () => {
    const { evidence } = fixture();
    evidence.report.testResults[0].assertionResults[7] = clone(
      evidence.report.testResults[0].assertionResults[6],
    );
    expect(() => makeRecord(evidence)).toThrow(/Missing, duplicate/);
  });
  it("does not count a filtered run with passing skips", () => {
    const { evidence } = fixture();
    evidence.report.numPassedTests--;
    evidence.report.numPendingTests++;
    expect(() => makeRecord(evidence)).toThrow(/failures or skips/);
  });
  it.each([
    { code: 1, signal: null },
    { code: null, signal: "SIGTERM" },
    { code: 0, signal: "SIGKILL" },
  ])("rejects worker exit $code/$signal regardless of schema equality", (exit) => {
    const { evidence } = fixture();
    expect(() => makeRecord({ ...evidence, exit })).toThrow(/worker/);
  });
  it("rejects hook or unhandled failures even with all tests marked passed", () => {
    const { evidence } = fixture();
    evidence.report.testResults[0].message = "Cleanup hook failed";
    expect(() => makeRecord(evidence)).toThrow();
    evidence.report.testResults[0].message = "";
    evidence.report.unhandledErrors = ["transport failure"];
    expect(() => makeRecord(evidence)).toThrow(/Unhandled/);
  });
  it("rejects missing and changed generated schemas", () => {
    const { evidence } = fixture();
    delete evidence.generatedSchema.files["ServerRequest.json"];
    expect(() => makeRecord(evidence)).toThrow(/schemas changed/);
    evidence.generatedSchema = clone(evidence.expectedSchema);
    evidence.generatedSchema.files["ServerRequest.json"] = "b".repeat(64);
    expect(() => makeRecord(evidence)).toThrow(/schemas changed/);
  });
  it("rejects a contract edited to omit a required schema", () => {
    const { evidence } = fixture();
    delete evidence.expectedSchema.files["v2/TurnStartParams.json"];
    evidence.generatedSchema = clone(evidence.expectedSchema);
    expect(() => makeRecord(evidence)).toThrow();
  });
  it.each(["inputs", "manifest", "report"])(
    "requires new actual probe evidence after the %s changes",
    (field) => {
      const { evidence, record } = fixture();
      if (field === "inputs") evidence.inputs["harness/codex/src/args.ts"] = "b".repeat(64);
      if (field === "manifest") evidence.manifest.changedPin = true;
      if (field === "report") evidence.report.testResults[0].assertionResults[0].duration++;
      expect(() => verifyRecord(record, evidence)).toThrow(/Rerun actual/);
    },
  );
  it("keeps native, Linux and real-account claims out of offline acceptance", () => {
    const { evidence, record } = fixture();
    for (const patch of [
      { nativeSandbox: "verified" },
      { platform: "linux-x64" },
      { realAccount: "verified" },
    ])
      expect(() => verifyRecord({ ...record, ...patch }, evidence)).toThrow();
  });
  it("canonical hashes ignore object key order while retaining array order", () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });
});
