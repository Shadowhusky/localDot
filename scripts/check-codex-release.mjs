import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { CONTRACT_FILES } from "../harness/codex/src/contract.ts";
import { CODEX_VERSION, codexRelease } from "../harness/codex/src/version.ts";

// This is a developer/CI release gate, never a runtime feature toggle or a real account probe.
// Schema equality alone cannot authorize a pin upgrade. The record also binds the current
// implementation, measured manifest and every required actual-binary probe, with no passing skips.
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
const SCOPE = `actual pinned Codex ${CODEX_VERSION} offline acceptance`;
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
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
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
export function validateProbeReport(report, exit) {
  assert.deepEqual(
    exit,
    { code: 0, signal: null },
    "The actual probe worker must exit successfully.",
  );
  assert.ok(object(report) && report.success === true, "Actual probes did not pass.");
  for (const key of [
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ])
    assert.equal(report[key], 0, `Release probes contain failures or skips: ${key}`);
  assert.equal(report.numTotalTests, REQUIRED_PROBES.length);
  assert.equal(report.numPassedTests, REQUIRED_PROBES.length);
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
    [...REQUIRED_PROBES].sort(),
    "Missing, duplicate or unexpected pinned probe.",
  );
  for (const test of assertions) {
    assert.equal(test.fullName, `${SCOPE} ${test.title}`);
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
    nativeSandbox: "unverified",
    realAccount: "not-run",
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
function evidence(root, report, generatedSchema, exit) {
  return {
    inputs: releaseInputs(root),
    manifest: JSON.parse(read(join(root, `harness/codex/releases/${CODEX_VERSION}.json`))),
    expectedSchema: JSON.parse(
      read(join(root, `harness/codex/schema/contract-${CODEX_VERSION}.json`)),
    ),
    generatedSchema,
    report,
    exit,
  };
}
export async function main(argv) {
  const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (argv.length === 0 || (argv.length === 2 && argv[0] === "--verify")) {
    const folder = argv[1] ?? join(root, "harness/codex/acceptance");
    assert.ok(isAbsolute(folder), "The acceptance directory must be absolute.");
    const record = JSON.parse(read(join(folder, "offline-record.json")));
    const report = JSON.parse(read(join(folder, "offline-report.json")));
    verifyRecord(record, evidence(root, report, record.generatedSchema, record.exit));
    console.log(
      `Pinned Codex ${CODEX_VERSION}: schemas and all ${REQUIRED_PROBES.length} offline probes match this source. Native and real-account acceptance remain separate.`,
    );
    return;
  }
  assert.ok(
    argv.length === 5 && argv[0] === "--run" && argv[1] === "--archive" && argv[3] === "--out",
    "Use --verify ABS_DIRECTORY or --run --archive ABS_TGZ --out NEW_ABS_DIRECTORY.",
  );
  const archive = argv[2],
    output = argv[4];
  assert.ok(isAbsolute(archive) && isAbsolute(output));
  assert.equal(
    `${process.platform}-${process.arch}`,
    "darwin-arm64",
    "The offline acceptance runner is unverified on this platform.",
  );
  assert.ok(codexRelease()); // The production manifest validator must accept this platform's exact pin.
  mkdirSync(output, { mode: 0o700 }); // Exclusive directory: never overwrite earlier evidence.
  const before = releaseInputs(root),
    rawReport = join(output, "raw-report.json");
  let exit = { code: 0, signal: null },
    stdout = "",
    stderr = "";
  try {
    ({ stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.codex.config.ts",
        "apps/daemon/src/agent/codex/codex-harness.codex.test.ts",
        "--reporter=json",
        `--outputFile=${rawReport}`,
      ],
      {
        cwd: root,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: homedir(),
          LOCALDOT_CODEX_TESTS: "1",
          LOCALDOT_CODEX_ARCHIVE: archive,
          LOCALDOT_CODEX_PROBE_OUTPUT: join(output, "wire"),
        },
        maxBuffer: 2 * 1024 * 1024,
        timeout: (REQUIRED_PROBES.length + 1) * 75_000,
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
    writeFileSync(join(output, "worker.log"), stdout + stderr, { mode: 0o600 });
  }
  const report = JSON.parse(read(rawReport));
  // The committed evidence keeps test results, not the build machine's absolute checkout path.
  for (const suite of report.testResults ?? [])
    suite.name = "apps/daemon/src/agent/codex/codex-harness.codex.test.ts";
  const generatedSchema = JSON.parse(read(join(output, "wire/schema-contract.json")));
  const data = evidence(root, report, generatedSchema, exit);
  assert.deepEqual(before, data.inputs, "Sources changed while the probes were running.");
  const record = makeRecord(data);
  writeFileSync(join(output, "offline-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(output, "offline-record.json"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
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
