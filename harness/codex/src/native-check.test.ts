import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeCheckError,
  PROBE_SCRIPT,
  type Probe,
  type ProbeOutcome,
  parseOutcomes,
  probeArgs,
  probePlan,
  verifyProbes,
} from "./native-check.ts";
import { CODEX_HOME_DENY_WRITE } from "./profile.ts";

const context = {
  home: "/owned/codex/home",
  realHome: "/Users/someone",
  userCodex: "/Users/someone/.codex",
  work: "/owned/codex/work/.owned-1",
  canary: "/owned/codex/.localdot-check-1",
  marker: "1",
  ownSocket: "/owned/codex/run/a/m.sock",
  foreignSocket: "/owned/codex/run/b/m.sock",
  tcpPort: 4767,
  spellings: (path: string) => [path, `/System/Volumes/Data${path}`],
};
const plan = probePlan(context);
const controls = plan.filter((probe) => probe.expect !== "proxy");
const passing = (probes: readonly Probe[]): ProbeOutcome[] =>
  probes.map((probe) =>
    probe.expect === "deny"
      ? { ok: false, errno: 1 }
      : { ok: true, errno: probe.expect === "proxy" ? 407403 : 0 },
  );
const plainOk = (): ProbeOutcome[] => controls.map(() => ({ ok: true, errno: 0 }));
const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("this Mac's sandbox check plan", () => {
  it("covers the native suite's denials and their positive controls for both purposes", () => {
    const has = (purpose: string, op: string, args: string[], expect: string) =>
      plan.some(
        (probe) =>
          probe.purpose === purpose &&
          probe.op === op &&
          probe.expect === expect &&
          JSON.stringify(probe.args) === JSON.stringify(args),
      );
    expect(has("task", "read", ["/owned/codex/home/config.toml"], "allow")).toBe(true);
    expect(has("task", "write", ["/owned/codex/home/config.toml"], "deny")).toBe(true);
    expect(has("task", "write", ["/owned/codex/home/.localdot-check-1"], "allow")).toBe(true);
    for (const path of ["/Users/someone", "/System/Volumes/Data/Users/someone"])
      expect(has("task", "directory", [path], "deny")).toBe(true);
    expect(has("task", "directory", ["/Users/someone/.codex"], "deny")).toBe(true);
    for (const path of [context.canary, `/System/Volumes/Data${context.canary}`]) {
      expect(has("task", "read", [path], "deny")).toBe(true);
      expect(has("task", "write", [path], "deny")).toBe(true);
    }
    expect(has("task", "unix", [context.ownSocket], "allow")).toBe(true);
    expect(has("task", "unix", [context.foreignSocket], "deny")).toBe(true);
    expect(has("task", "connect", ["127.0.0.1", "4767"], "deny")).toBe(true);
    expect(has("task", "bind", ["::1", "0"], "deny")).toBe(true);
    for (const name of CODEX_HOME_DENY_WRITE)
      expect(has("account", "write", [`/owned/codex/home/${name}`], "deny")).toBe(true);
    for (const purpose of ["task", "account"]) {
      expect(has(purpose, "nested", [], "deny")).toBe(true);
      expect(has(purpose, "proxy", [], "proxy")).toBe(true);
      expect(plan.some((p) => p.purpose === purpose && p.op === "environment")).toBe(true);
    }
    expect(plan.some((probe) => probe.args.some((arg) => arg.startsWith("0.0.0.0")))).toBe(false);
  });
  it("passes a held sandbox and names the first probe that does not hold", () => {
    expect(verifyProbes(plan, plainOk(), passing(plan))).toHaveLength(plan.length);
    const leak = passing(plan);
    const index = plan.findIndex((probe) => probe.op === "write" && probe.expect === "deny");
    leak[index] = { ok: true, errno: 0 };
    expect(() => verifyProbes(plan, plainOk(), leak)).toThrow(NativeCheckError);
    try {
      verifyProbes(plan, plainOk(), leak);
    } catch (error) {
      expect((error as NativeCheckError).probe).toBe("task write");
    }
  });
  it("counts only a permission error as the sandbox's denial", () => {
    const missing = passing(plan);
    missing[plan.findIndex((probe) => probe.op === "directory")] = { ok: false, errno: 2 };
    expect(() => verifyProbes(plan, plainOk(), missing)).toThrow(NativeCheckError);
    const access = passing(plan);
    access[plan.findIndex((probe) => probe.op === "directory")] = { ok: false, errno: 13 };
    expect(() => verifyProbes(plan, plainOk(), access)).not.toThrow();
  });
  it("fails when a probe can't work outside the sandbox either", () => {
    const plain = plainOk();
    plain[controls.findIndex((probe) => probe.op === "nested")] = { ok: false, errno: 1 };
    expect(() => verifyProbes(plan, plain, passing(plan))).toThrow(NativeCheckError);
  });
  it("needs the proxy to ask for its password and refuse other hosts", () => {
    const sandboxed = passing(plan);
    sandboxed[plan.findIndex((probe) => probe.op === "proxy")] = { ok: true, errno: 200200 };
    expect(() => verifyProbes(plan, plainOk(), sandboxed)).toThrow(NativeCheckError);
  });
  it("refuses short, long or malformed probe output", () => {
    expect(parseOutcomes("ok 0\nno 1\n", 2)).toEqual([
      { ok: true, errno: 0 },
      { ok: false, errno: 1 },
    ]);
    for (const output of ["ok 0\n", "ok 0\nno 1\nok 0\n", "ok 0\nno 1", "ok 0\nyes 1\n", ""])
      expect(() => parseOutcomes(output, 2)).toThrow(NativeCheckError);
    expect(() => verifyProbes(plan, plainOk().slice(1), passing(plan))).toThrow(NativeCheckError);
  });
  it.skipIf(!existsSync("/usr/bin/perl"))(
    "reports outcomes and error numbers from the system Perl",
    () => {
      const dir = realpathSync(mkdtempSync("/tmp/localdot-native-check-"));
      owned.push(dir);
      const script = join(dir, "probe.pl"),
        file = join(dir, "file");
      writeFileSync(script, PROBE_SCRIPT);
      writeFileSync(file, "x");
      const probes: Probe[] = [
        { purpose: "task", op: "read", args: [file], expect: "allow" },
        { purpose: "task", op: "read", args: [join(dir, "missing")], expect: "deny" },
        { purpose: "task", op: "directory", args: [dir], expect: "allow" },
        { purpose: "task", op: "write", args: [join(dir, "new")], expect: "allow" },
        { purpose: "task", op: "environment", args: ["/owned", "OPENAI_API_KEY"], expect: "allow" },
      ];
      const output = execFileSync("/usr/bin/perl", [script, "plain", ...probeArgs(probes)], {
        env: { PATH: "/usr/bin:/bin", CODEX_HOME: "/owned" },
        encoding: "utf8",
      });
      expect(parseOutcomes(output, probes.length)).toEqual([
        { ok: true, errno: 0 },
        { ok: false, errno: 2 },
        { ok: true, errno: 0 },
        { ok: true, errno: 0 },
        { ok: true, errno: 0 },
      ]);
      expect(existsSync(join(dir, "new"))).toBe(false);
    },
  );
});
