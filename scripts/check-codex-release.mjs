import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonical, canonicalDigest as digest } from "../harness/codex/src/acceptance.ts";
import { CONTRACT_FILES } from "../harness/codex/src/contract.ts";
import { CODEX_VERSION, codexRelease } from "../harness/codex/src/version.ts";

export { digest };

// This is a developer/CI release gate, never a runtime feature toggle. Only --account signs in to a
// real account, and only when an operator runs it. Schema equality alone cannot authorize a pin
// upgrade. The record also binds the current implementation, measured manifest and every required
// actual-binary probe, with no passing skips.
export const REQUIRED_PROBES = Object.freeze([
  "regenerates all35 committed schema files from the independently verified pin",
  "sends store:false on both actual requests and carries encrypted reasoning into continuation",
  "refreshes only the owned fake credentials while preserving the protected home sentinel",
  "does not reuse a reader after the fake credential file changes",
  "runs the actual tool bridge with no command tool, declines file edits, and submits the full PNG",
  "keeps frame A for two same-turn clicks even when the first returns a newer image",
  "cancels the remaining click and its image after a stale batch action, then submits a fresh full-frame turn",
  "Stop fences a pending real MCP call and closes Codex, nc and all pipes without a late image",
  "preserves held takeover after a pending MCP call is canceled and only resumes after matching hand-back",
  "matching native Pause drains a real MCP call and resumes once without replaying its effect",
  "uncertain real MCP result ownership contains native Pause and refuses Resume",
  "pauses a failed fake refresh without daemon retry, replacement, fallback or new frames until Stop",
  "refuses a forced alternate-model sub-agent without creating a child thread or granting tools",
  "exposes no connector, plugin, foreign MCP or web tool and sends only allowed fixture HTTP requests",
  "closes the real nc bridge and pending call on app-server stdin EOF without delivering a late image",
]);
export const NATIVE_PROBES = Object.freeze([
  "allows owned home/work while denying protected config writes and user/data reads",
  "denies all protected home writes with writable owned positive controls",
  "denies parent canaries and both shared-temp spellings while private temp stays writable",
  "denies the owned real-home canary through natural and Data-volume spellings",
  "grants only the owned UDS and exact proxy ports",
  "denies every task/account listener and refuses the unavailable browser profile",
  "receives the scrubbed production environment",
  "authenticates to the owned default proxy and rejects a foreign CONNECT host",
  "denies native sandbox reinitialization with an unsandboxed positive control",
]);
export const ACCOUNT_PROBES = Object.freeze([
  "manual device-code cancellation, real ChatGPT sign-in and forced refresh in an owned native home",
]);
const SCOPE = `actual pinned Codex ${CODEX_VERSION} offline acceptance`;
const SUITES = Object.freeze({
  offline: {
    probes: REQUIRED_PROBES,
    scope: SCOPE,
    file: "apps/daemon/src/agent/codex/codex-harness.codex.test.ts",
    config: "vitest.codex.config.ts",
    timeout: (REQUIRED_PROBES.length + 1) * 75_000,
  },
  native: {
    probes: NATIVE_PROBES,
    scope: "native macOS Codex confinement",
    file: "apps/daemon/src/agent/codex/sandbox.codex.test.ts",
    config: "vitest.codex.config.ts",
    timeout: (NATIVE_PROBES.length + 2) * 60_000,
  },
  // The real sign-in prints a one-time code for the operator, so it runs attached to the terminal.
  account: {
    probes: ACCOUNT_PROBES,
    scope: "",
    file: "apps/daemon/src/agent/codex/signin.codex.test.ts",
    config: "vitest.codex-signin.config.ts",
    timeout: 720_000,
    interactive: true,
  },
});
const PASSED_EXIT = Object.freeze({ code: 0, signal: null });
const UNSTAMPED = Object.freeze({ passed: false });
const DIRECTORIES = ["harness/codex", "apps/daemon/src", "packages/protocol/src"];
const FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "vitest.codex.config.ts",
  "vitest.codex-signin.config.ts",
  "scripts/check-codex-release.mjs",
  "scripts/check-codex-release.test.mjs",
  ".github/workflows/ci.yml",
];
const EXTENSION = /\.(?:[cm]?js|tsx?|c|json|ya?ml)$/;
const HEX = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function read(path) {
  const info = lstatSync(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024,
    "Release input must be a bounded regular file.",
  );
  return readFileSync(path);
}
export function releaseInputs(root) {
  root = realpathSync(root);
  const hashes = {};
  let directories = 0;
  function file(relative) {
    assert.ok(Object.keys(hashes).length < 4096, "Release input limit exceeded.");
    hashes[relative] = createHash("sha256")
      .update(read(join(root, relative)))
      .digest("hex");
  }
  function walk(relative) {
    assert.ok(
      ++directories <= 8192 && relative.length <= 2048,
      "Release directory limit exceeded.",
    );
    const path = join(root, relative);
    const info = lstatSync(path);
    assert.ok(
      info.isDirectory() && !info.isSymbolicLink(),
      "Release source directories cannot be links.",
    );
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["node_modules", "acceptance", "dist", ".cache"].includes(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), "Release sources cannot be links.");
      if (entry.isDirectory()) walk(child);
      else if (EXTENSION.test(entry.name)) file(child);
    }
  }
  for (const directory of DIRECTORIES) walk(directory);
  for (const path of FILES) file(path);
  for (const path of [
    "harness/codex/src/args.ts",
    "harness/codex/src/install.ts",
    "harness/codex/src/testing/pinned-fixture.ts",
    "apps/daemon/src/agent/codex/driver.ts",
    "apps/daemon/src/agent/codex/codex-harness.codex.test.ts",
  ])
    assert.ok(HEX.test(hashes[path] ?? ""), `Missing required release source: ${path}`);
  return canonical(hashes);
}
export function validateProbeReport(report, exit, kind = "offline") {
  const { probes, scope } = SUITES[kind];
  assert.deepEqual(exit, PASSED_EXIT, "The actual probe worker must exit successfully.");
  assert.ok(object(report) && report.success === true, "Actual probes did not pass.");
  for (const key of [
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ])
    assert.equal(report[key], 0, `Release probes contain failures or skips: ${key}`);
  assert.equal(report.numTotalTests, probes.length);
  assert.equal(report.numPassedTests, probes.length);
  assert.ok(Array.isArray(report.testResults) && report.testResults.length === 1);
  assert.ok(
    report.unhandledErrors === undefined ||
      (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length === 0),
    "Unhandled probe failures cannot pass acceptance.",
  );
  const suite = report.testResults[0];
  assert.equal(suite.status, "passed");
  assert.equal(suite.message, "");
  assert.ok(Array.isArray(suite.assertionResults));
  const assertions = suite.assertionResults;
  assert.deepEqual(
    assertions.map((test) => test.title).sort(),
    [...probes].sort(),
    "Missing, duplicate or unexpected pinned probe.",
  );
  for (const test of assertions) {
    assert.equal(test.fullName, scope ? `${scope} ${test.title}` : test.title);
    assert.equal(test.status, "passed");
    assert.deepEqual(test.failureMessages, []);
    assert.ok(
      typeof test.duration === "number" && Number.isFinite(test.duration) && test.duration > 0,
    );
  }
  return true;
}
export function makeRecord({ inputs, manifest, expectedSchema, generatedSchema, report, exit }) {
  validateProbeReport(report, exit);
  assert.ok(
    object(inputs) &&
      Object.keys(inputs).length > 0 &&
      Object.values(inputs).every((hash) => typeof hash === "string" && HEX.test(hash)),
  );
  assert.equal(expectedSchema.codexVersion, CODEX_VERSION);
  assert.deepEqual(Object.keys(expectedSchema.files).sort(), [...CONTRACT_FILES].sort());
  assert.deepEqual(
    canonical(generatedSchema),
    canonical(expectedSchema),
    "Generated pinned schemas changed or are missing.",
  );
  return {
    format: 1,
    codexVersion: CODEX_VERSION,
    platform: "darwin-arm64",
    manifestSha256: digest(manifest),
    inputSha256: digest(inputs),
    inputs,
    generatedSchema,
    reportSha256: digest(report),
    exit,
  };
}
export function verifyRecord(record, evidence) {
  assert.deepEqual(
    canonical(record),
    canonical(makeRecord(evidence)),
    "The release pin, schemas, source or required probe record changed. Rerun actual offline acceptance.",
  );
  return true;
}
// record.json carries the stamps that open the ChatGPT plan at runtime. The native stamp is bound
// to the release sources like the offline record; the account stamp needs a person, so it is bound
// only to the pin and its manifest.
function acceptanceBase(previous, manifest) {
  const base = {
    format: 1,
    codexVersion: CODEX_VERSION,
    platform: "darwin-arm64",
    manifestSha256: digest(manifest),
  };
  const same =
    object(previous) && Object.entries(base).every(([key, value]) => previous[key] === value);
  return {
    ...base,
    nativeSandbox: same ? previous.nativeSandbox : UNSTAMPED,
    realAccount: same ? previous.realAccount : UNSTAMPED,
  };
}
const nativeStamp = (inputs, report) => ({
  passed: true,
  inputSha256: digest(inputs),
  reportSha256: digest(report),
});
const accountStamp = (report) => ({ passed: true, reportSha256: digest(report) });
export function stampNative(previous, { inputs, manifest, report, exit }) {
  validateProbeReport(report, exit, "native");
  return { ...acceptanceBase(previous, manifest), nativeSandbox: nativeStamp(inputs, report) };
}
export function stampAccount(previous, { manifest, report, exit }) {
  validateProbeReport(report, exit, "account");
  return { ...acceptanceBase(previous, manifest), realAccount: accountStamp(report) };
}
export function verifyAcceptance(record, { inputs, manifest, native, account }) {
  const expected = acceptanceBase(undefined, manifest);
  assert.ok(object(record), "The acceptance record is missing.");
  assert.deepEqual(
    Object.keys(record).sort(),
    Object.keys(expected).sort(),
    "The acceptance record has missing or unexpected fields.",
  );
  for (const key of ["format", "codexVersion", "platform", "manifestSha256"])
    assert.equal(
      record[key],
      expected[key],
      "The acceptance record names another pin. Rerun native and account acceptance.",
    );
  if (record.nativeSandbox?.passed !== false) {
    validateProbeReport(native, PASSED_EXIT, "native");
    assert.deepEqual(
      record.nativeSandbox,
      nativeStamp(inputs, native),
      "The native sandbox stamp does not match this source. Rerun native acceptance.",
    );
  } else assert.deepEqual(record.nativeSandbox, UNSTAMPED);
  if (record.realAccount?.passed !== false) {
    validateProbeReport(account, PASSED_EXIT, "account");
    assert.deepEqual(
      record.realAccount,
      accountStamp(account),
      "The real-account stamp does not match its report. Rerun account acceptance.",
    );
  } else assert.deepEqual(record.realAccount, UNSTAMPED);
  return true;
}
export function verifyAcceptanceFolder(folder, { inputs, manifest }) {
  const record = JSON.parse(read(join(folder, "record.json")));
  const report = (name, stamp) =>
    stamp?.passed === false ? undefined : JSON.parse(read(join(folder, name)));
  verifyAcceptance(record, {
    inputs,
    manifest,
    native: report("native-report.json", record.nativeSandbox),
    account: report("account-report.json", record.realAccount),
  });
  return record;
}
const manifestOf = (root) =>
  JSON.parse(read(join(root, `harness/codex/releases/${CODEX_VERSION}.json`)));
function evidence(root, report, generatedSchema, exit) {
  return {
    inputs: releaseInputs(root),
    manifest: manifestOf(root),
    expectedSchema: JSON.parse(
      read(join(root, `harness/codex/schema/contract-${CODEX_VERSION}.json`)),
    ),
    generatedSchema,
    report,
    exit,
  };
}
function worker(root, kind, args, env) {
  const { timeout, interactive } = SUITES[kind];
  if (!interactive)
    return promisify(execFile)(process.execPath, args, {
      cwd: root,
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout,
    });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      timeout,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 && signal === null
        ? resolve({ stdout: "", stderr: "" })
        : reject(Object.assign(new Error("The probe worker failed."), { code, signal })),
    );
  });
}
async function probe(root, kind, archive, output) {
  const suite = SUITES[kind],
    rawReport = join(output, "raw-report.json");
  let exit = PASSED_EXIT,
    stdout = "",
    stderr = "";
  try {
    ({ stdout, stderr } = await worker(
      root,
      kind,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        suite.config,
        suite.file,
        "--reporter=json",
        `--outputFile=${rawReport}`,
      ],
      {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: homedir(),
        LOCALDOT_CODEX_TESTS: "1",
        LOCALDOT_CODEX_ARCHIVE: archive,
        ...(kind === "offline" ? { LOCALDOT_CODEX_PROBE_OUTPUT: join(output, "wire") } : {}),
        ...(kind === "account" ? { LOCALDOT_CODEX_SIGNIN: "1" } : {}),
      },
    ));
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    exit = {
      code: typeof error.code === "number" ? error.code : null,
      signal: error.signal ?? null,
    };
    // A startup, hook, timeout or cleanup error has no accepted record. Retain its diagnostics.
    writeFileSync(join(output, "failed-exit.json"), `${JSON.stringify(exit)}\n`, { mode: 0o600 });
  } finally {
    if (!suite.interactive)
      writeFileSync(join(output, "worker.log"), stdout + stderr, { mode: 0o600 });
  }
  const report = JSON.parse(read(rawReport));
  // The committed evidence keeps test results, not the build machine's absolute checkout path.
  for (const result of report.testResults ?? []) result.name = suite.file;
  return { report, exit };
}
const json = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export async function main(argv) {
  const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (argv.length === 0 || (argv.length === 2 && argv[0] === "--verify")) {
    const folder = argv[1] ?? join(root, "harness/codex/acceptance");
    assert.ok(isAbsolute(folder), "The acceptance directory must be absolute.");
    const record = JSON.parse(read(join(folder, "offline-record.json")));
    const report = JSON.parse(read(join(folder, "offline-report.json")));
    const data = evidence(root, report, record.generatedSchema, record.exit);
    const acceptance = verifyAcceptanceFolder(folder, data);
    verifyRecord(record, data);
    const state = (stamp) => (stamp.passed ? "passed" : "not run");
    console.log(
      `Pinned Codex ${CODEX_VERSION}: schemas and all ${REQUIRED_PROBES.length} offline probes match this source. Native sandbox ${state(acceptance.nativeSandbox)}; real account ${state(acceptance.realAccount)}.`,
    );
    return;
  }
  const modes = { "--run": "offline", "--native": "native", "--account": "account" };
  assert.ok(
    argv.length === 5 &&
      Object.hasOwn(modes, argv[0]) &&
      argv[1] === "--archive" &&
      argv[3] === "--out",
    "Use --verify ABS_DIRECTORY, or --run, --native or --account with --archive ABS_TGZ --out NEW_ABS_DIRECTORY.",
  );
  const kind = modes[argv[0]],
    archive = argv[2],
    output = argv[4];
  assert.ok(isAbsolute(archive) && isAbsolute(output));
  assert.equal(
    `${process.platform}-${process.arch}`,
    "darwin-arm64",
    "The acceptance runner is unverified on this platform.",
  );
  assert.ok(codexRelease()); // The production manifest validator must accept this platform's exact pin.
  mkdirSync(output, { mode: 0o700 }); // Exclusive directory: never overwrite earlier evidence.
  const before = releaseInputs(root);
  const { report, exit } = await probe(root, kind, archive, output);
  if (kind !== "offline") {
    const data = { inputs: releaseInputs(root), manifest: manifestOf(root), report, exit };
    assert.deepEqual(before, data.inputs, "Sources changed while the probes were running.");
    const previous = JSON.parse(read(join(root, "harness/codex/acceptance/record.json")));
    const record = kind === "native" ? stampNative(previous, data) : stampAccount(previous, data);
    json(join(output, `${kind}-report.json`), report);
    json(join(output, "record.json"), record);
    console.log(
      `All ${SUITES[kind].probes.length} ${kind} probes passed. Stamped record and report: ${output}`,
    );
    return;
  }
  const generatedSchema = JSON.parse(read(join(output, "wire/schema-contract.json")));
  const data = evidence(root, report, generatedSchema, exit);
  assert.deepEqual(before, data.inputs, "Sources changed while the probes were running.");
  const record = makeRecord(data);
  json(join(output, "offline-report.json"), report);
  json(join(output, "offline-record.json"), record);
  verifyRecord(record, data);
  console.log(
    `All ${REQUIRED_PROBES.length} actual pinned offline probes passed. Verified release evidence: ${output}`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`Codex release gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}
