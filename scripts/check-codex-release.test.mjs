import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_VERSION } from "../harness/codex/src/version.ts";
import {
  ACCOUNT_PROBES,
  digest,
  makeRecord,
  NATIVE_PROBES,
  REQUIRED_PROBES,
  releaseInputs,
  stampAccount,
  stampNative,
  validateProbeReport,
  verifyAcceptance,
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
    "vitest.codex-signin.config.ts",
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
const passedReport = (probes, scope) => ({
  success: true,
  numTotalTests: probes.length,
  numPassedTests: probes.length,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  testResults: [
    {
      status: "passed",
      message: "",
      assertionResults: probes.map((title) => ({
        title,
        fullName: scope ? `${scope} ${title}` : title,
        status: "passed",
        failureMessages: [],
        duration: 1,
      })),
    },
  ],
});
function fixture() {
  const schema = JSON.parse(
    readFileSync(
      new URL(`../harness/codex/schema/contract-${CODEX_VERSION}.json`, import.meta.url),
      "utf8",
    ),
  );
  const report = passedReport(
    REQUIRED_PROBES,
    `actual pinned Codex ${CODEX_VERSION} offline acceptance`,
  );
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

it("binds the native C executable source to the release inventory", () => {
  const root = sourceTree(),
    relative = "harness/codex/src/testing/native-probe.c";
  writeFileSync(join(root, relative), "int main(void) { return 0; }\n");
  const first = releaseInputs(root);
  expect(first[relative] ?? "").toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(root, relative), "int main(void) { return 1; }\n");
  expect(releaseInputs(root)[relative]).not.toBe(first[relative]);
});

const exited = { code: 0, signal: null };
function acceptance() {
  const evidence = {
    inputs: { "harness/codex/src/args.ts": "a".repeat(64) },
    manifest: { fixture: true },
    native: passedReport(NATIVE_PROBES, "native macOS Codex confinement"),
    account: passedReport(ACCOUNT_PROBES, ""),
  };
  const unstamped = {
    format: 1,
    codexVersion: CODEX_VERSION,
    platform: "darwin-arm64",
    manifestSha256: digest(evidence.manifest),
    nativeSandbox: { passed: false },
    realAccount: { passed: false },
  };
  const native = stampNative(unstamped, { ...evidence, report: evidence.native, exit: exited });
  const record = stampAccount(native, { ...evidence, report: evidence.account, exit: exited });
  return { evidence, unstamped, native, record };
}
describe("ChatGPT plan acceptance record", () => {
  it("stamps native and account runs into one record that verifies", () => {
    const { evidence, record } = acceptance();
    expect(record).toEqual({
      format: 1,
      codexVersion: CODEX_VERSION,
      platform: "darwin-arm64",
      manifestSha256: digest(evidence.manifest),
      nativeSandbox: {
        passed: true,
        inputSha256: digest(evidence.inputs),
        reportSha256: digest(evidence.native),
      },
      realAccount: { passed: true, reportSha256: digest(evidence.account) },
    });
    expect(verifyAcceptance(record, evidence)).toBe(true);
  });
  it("verifies an unstamped record without any report", () => {
    const { evidence, unstamped } = acceptance();
    expect(
      verifyAcceptance(unstamped, { inputs: evidence.inputs, manifest: evidence.manifest }),
    ).toBe(true);
  });
  it("binds the native stamp to the release sources", () => {
    const { evidence, record } = acceptance();
    evidence.inputs["apps/daemon/src/agent/wiring.ts"] = "b".repeat(64);
    expect(() => verifyAcceptance(record, evidence)).toThrow(/Rerun native/);
  });
  it("binds the account stamp to the pin and manifest only", () => {
    const { evidence, unstamped } = acceptance();
    const record = stampAccount(unstamped, { ...evidence, report: evidence.account, exit: exited });
    evidence.inputs["apps/daemon/src/agent/wiring.ts"] = "b".repeat(64);
    expect(verifyAcceptance(record, evidence)).toBe(true);
    expect(() => verifyAcceptance(record, { ...evidence, manifest: { changedPin: true } })).toThrow(
      /another pin/,
    );
  });
  it.each(["nativeSandbox", "realAccount"])(
    "refuses a passed %s stamp whose report is missing or changed",
    (stamp) => {
      const { evidence, record } = acceptance();
      const report = stamp === "nativeSandbox" ? "native" : "account";
      expect(() => verifyAcceptance(record, { ...evidence, [report]: undefined })).toThrow();
      evidence[report].testResults[0].assertionResults[0].duration++;
      expect(() => verifyAcceptance(record, evidence)).toThrow(/Rerun/);
    },
  );
  it.each(["native", "account"])(
    "refuses a %s stamp re-digested over an incomplete report",
    (kind) => {
      const { evidence, record } = acceptance();
      evidence[kind].testResults[0].assertionResults[0].status = "skipped";
      const forged =
        kind === "native"
          ? {
              ...record,
              nativeSandbox: {
                passed: true,
                inputSha256: digest(evidence.inputs),
                reportSha256: digest(evidence.native),
              },
            }
          : { ...record, realAccount: { passed: true, reportSha256: digest(evidence.account) } };
      expect(() => verifyAcceptance(forged, evidence)).toThrow();
    },
  );
  it.each([
    ["a truthy native stamp", { nativeSandbox: { passed: "true" } }],
    [
      "a failed native stamp with leftover digests",
      { nativeSandbox: { passed: false, inputSha256: "a".repeat(64) } },
    ],
    ["a native stamp without its digests", { nativeSandbox: { passed: true } }],
    [
      "a failed stamp with leftover digests",
      { realAccount: { passed: false, reportSha256: "c".repeat(64) } },
    ],
    ["a missing stamp", { realAccount: undefined }],
    ["another platform", { platform: "linux-x64" }],
    ["another version", { codexVersion: "0.155.0" }],
    ["another format", { format: 2 }],
    ["an extra claim", { accepted: true }],
  ])("refuses a record with %s", (_name, patch) => {
    const { evidence, record } = acceptance();
    expect(() => verifyAcceptance({ ...record, ...patch }, evidence)).toThrow();
  });
  it.each(["failed", "pending", "skipped", "todo"])(
    "refuses to stamp a %s native or account probe",
    (status) => {
      const { evidence, unstamped } = acceptance();
      evidence.native.testResults[0].assertionResults[3].status = status;
      expect(() =>
        stampNative(unstamped, { ...evidence, report: evidence.native, exit: exited }),
      ).toThrow();
      evidence.account.testResults[0].assertionResults[0].status = status;
      expect(() =>
        stampAccount(unstamped, { ...evidence, report: evidence.account, exit: exited }),
      ).toThrow();
    },
  );
  it("refuses another suite's report and an unclean worker exit", () => {
    const { evidence, unstamped } = acceptance();
    expect(() =>
      stampNative(unstamped, { ...evidence, report: evidence.account, exit: exited }),
    ).toThrow(/failures or skips|Missing, duplicate|Expected/);
    expect(() =>
      stampAccount(unstamped, { ...evidence, report: evidence.native, exit: exited }),
    ).toThrow();
    expect(() =>
      stampNative(unstamped, {
        ...evidence,
        report: evidence.native,
        exit: { code: null, signal: "SIGTERM" },
      }),
    ).toThrow(/worker/);
  });
  it("keeps a same-pin stamp and drops the stamps of another pin when stamping", () => {
    const { evidence, record } = acceptance();
    const again = stampNative(record, { ...evidence, report: evidence.native, exit: exited });
    expect(again.realAccount).toEqual(record.realAccount);
    const otherPin = { ...record, manifestSha256: "0".repeat(64) };
    const fresh = stampNative(otherPin, { ...evidence, report: evidence.native, exit: exited });
    expect(fresh.realAccount).toEqual({ passed: false });
    expect(fresh.manifestSha256).toBe(digest(evidence.manifest));
  });
});
