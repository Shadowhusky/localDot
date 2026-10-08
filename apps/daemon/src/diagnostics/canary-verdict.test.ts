import { expect, it } from "vitest";
import { CANARY_FORMS, type CanaryControls, canaryScanVerdict } from "./canary-verdict.ts";

function fixture() {
  const controls: CanaryControls = {
    canary: "canary-synthetic-0123456789",
    marker: "marker-???-0123456789",
    clipboard: "clipboard-0123456789",
    surrogate: `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`,
    files: CANARY_FORMS.map((form) => ({ form, path: `/tmp/controls/${form}` })),
  };
  const report = {
    processes: 21,
    bytes: 105 * 1024 * 1024,
    files: 101,
    fileBytes: 4096,
    unreadableMemory: 0,
    fileErrors: [] as string[],
    hits: [
      ...controls.files.map(({ form, path }) => `${controls.marker}|${form}|file ${path}`),
      `${controls.marker}|raw|environ`,
      `${controls.marker}|raw|cmdline`,
      `${controls.surrogate}|raw|environ`,
      ...[controls.marker, controls.surrogate, controls.clipboard].map(
        (value) => `${value}|raw|memory`,
      ),
    ],
    memoryReads: Array.from({ length: 21 }, (_, i) => ({
      pid: i + 1,
      comm: i === 2 ? "xclip" : "fixture",
      bytes: 5 * 1024 * 1024,
    })),
    memoryHits: [controls.marker, controls.surrogate, controls.clipboard].map((needle, i) => ({
      pid: i + 1,
      comm: i === 2 ? "xclip" : "fixture",
      needle,
      form: "raw",
    })),
    processErrors: [] as {
      pid: number;
      comm: string;
      surface: string;
      errno: number;
      vanished: boolean;
    }[],
  };
  return { controls, report, verdict: () => canaryScanVerdict(report, controls) };
}

it("accepts only a complete scan with every encoding and process/clipboard control", () => {
  const f = fixture(),
    result = f.verdict();
  expect(result).toEqual({
    ok: true,
    reason: "passed",
    coverage: { processes: 21, memoryBytes: 105 * 1024 * 1024, files: 101, fileBytes: 4096 },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /canary-synthetic|marker-|clipboard-|ld_key_|\/tmp|xclip/,
  );
});
it.each(CANARY_FORMS)("detects a %s leak even when controls are also missing", (form) => {
  const f = fixture();
  f.report.hits = [`${f.controls.canary}|${form}|file /tmp/leak`];
  f.report.memoryHits = [];
  expect(f.verdict()).toEqual({ ok: false, reason: "leak" });
});
it.each(CANARY_FORMS)("requires the %s file control in the same report", (form) => {
  const f = fixture();
  f.report.hits = f.report.hits.filter(
    (hit) => hit !== `${f.controls.marker}|${form}|file /tmp/controls/${form}`,
  );
  expect(f.verdict()).toEqual({ ok: false, reason: "missing-controls" });
});
it.each([
  "marker-env",
  "marker-command",
  "marker-memory",
  "surrogate-env",
  "surrogate-memory",
  "clipboard",
  "clipboard-process",
])("refuses absent %s positive evidence", (fault) => {
  const f = fixture();
  const hit =
    fault === "marker-env"
      ? `${f.controls.marker}|raw|environ`
      : fault === "marker-command"
        ? `${f.controls.marker}|raw|cmdline`
        : `${f.controls.surrogate}|raw|environ`;
  if (["marker-env", "marker-command", "surrogate-env"].includes(fault))
    f.report.hits = f.report.hits.filter((value) => value !== hit);
  else if (fault === "clipboard-process") {
    const read = f.report.memoryReads[2],
      memory = f.report.memoryHits[2];
    if (read && memory) read.comm = memory.comm = "unrelated";
  } else {
    const needle =
      fault === "marker-memory"
        ? f.controls.marker
        : fault === "surrogate-memory"
          ? f.controls.surrogate
          : f.controls.clipboard;
    f.report.memoryHits = f.report.memoryHits.filter((item) => item.needle !== needle);
  }
  expect(f.verdict()).toEqual({ ok: false, reason: "missing-controls" });
});
it.each([
  "count",
  "bytes",
  "duplicate-pid",
  "unread-pid",
  "wrong-comm",
  "missing-memory-hit",
  "unknown-needle",
  "unknown-form",
  "duplicate-hit",
  "unknown-field",
  "fraction",
  "overflow",
])("refuses inconsistent %s scanner evidence", (fault) => {
  const f = fixture();
  if (fault === "count") f.report.processes++;
  if (fault === "bytes") f.report.bytes++;
  if (fault === "duplicate-pid") f.report.memoryReads[1] = { ...f.report.memoryReads[0]! };
  if (fault === "unread-pid") f.report.memoryHits[0]!.pid = 900;
  if (fault === "wrong-comm") f.report.memoryHits[0]!.comm = "other";
  if (fault === "missing-memory-hit")
    f.report.hits = f.report.hits.filter((hit) => hit !== `${f.controls.marker}|raw|memory`);
  if (fault === "unknown-needle") f.report.hits.push("unrecognized-needle|raw|memory");
  if (fault === "unknown-form") f.report.hits.push(`${f.controls.marker}|rot13|memory`);
  if (fault === "duplicate-hit") f.report.hits.push(f.report.hits[0]!);
  if (fault === "unknown-field") Object.assign(f.report, { privateDetail: "never return" });
  if (fault === "fraction") f.report.files = 101.5;
  if (fault === "overflow") f.report.memoryReads[0]!.bytes = Number.MAX_SAFE_INTEGER;
  expect(f.verdict()).toEqual({ ok: false, reason: "invalid-evidence" });
});
it.each([
  "files",
  "file-bytes",
  "processes",
  "memory",
  "file-error",
  "process-error",
  "unexplained-unreadable",
])("refuses insufficient %s coverage", (fault) => {
  const f = fixture();
  if (fault === "files") f.report.files = 100;
  if (fault === "file-bytes") f.report.fileBytes = 0;
  if (fault === "processes") {
    f.report.memoryReads.pop();
    f.report.processes--;
    f.report.bytes -= 5 * 1024 * 1024;
  }
  if (fault === "memory") {
    f.report.memoryReads[20]!.bytes = 1;
    f.report.bytes -= 5 * 1024 * 1024 - 1;
    f.report.memoryReads[19]!.bytes--;
    f.report.bytes--;
  }
  if (fault === "file-error") f.report.fileErrors.push("private path read failure");
  if (fault === "process-error")
    f.report.processErrors.push({
      pid: 1,
      comm: "fixture",
      surface: "environ",
      errno: 13,
      vanished: false,
    });
  if (fault === "unexplained-unreadable") f.report.unreadableMemory++;
  expect(f.verdict()).toEqual({ ok: false, reason: "incomplete-scan" });
});
it("permits recorded vanished processes without counting them as read coverage", () => {
  const f = fixture();
  f.report.processErrors.push({
    pid: 900,
    comm: "exited",
    surface: "memory",
    errno: 3,
    vanished: true,
  });
  f.report.unreadableMemory = 1;
  expect(f.verdict().ok).toBe(true);
});
it("refuses a control plan omitting an encoding, aliased needles or missing controls", () => {
  const f = fixture();
  f.controls.files[0] = { ...f.controls.files[1]! };
  expect(f.verdict().reason).toBe("missing-controls");
  f.controls.canary = f.controls.marker;
  expect(f.verdict().reason).toBe("invalid-evidence");
  expect(canaryScanVerdict({}, f.controls).ok).toBe(false);
});
