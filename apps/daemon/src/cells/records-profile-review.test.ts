import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserSpec } from "./browser-spec.ts";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { streamOptions } from "./spec.ts";
import { CellStore } from "./store.ts";
import { sampleBrowserRecord } from "./testing/sample-browser-record.ts";
import { sampleRecord } from "./testing/sample-record.ts";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "records-profile-review-"));
  homes.push(home);
  const store = new CellStore(home);
  const parent = sampleRecord();
  store.save(parent);
  const browser = sampleBrowserRecord(parent);
  const file = (id: string) => join(home, "cells", id, "cell.json");
  const raw = (id: string, value: unknown) => {
    mkdirSync(store.folder(id), { recursive: true });
    writeFileSync(file(id), JSON.stringify(value));
  };
  return { home, store, parent, browser, file, raw };
}

describe("independent records and profile boundaries", () => {
  it("a failed duplicate profile reservation preserves the existing bytes", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const before = readFileSync(f.file(f.browser.id));
    const second = sampleBrowserRecord(f.parent);
    expect(() => f.store.saveBrowser(second)).toThrow();
    expect(readFileSync(f.file(f.browser.id))).toEqual(before);
    expect(f.store.getStored(second.id)).toBeUndefined();
    expect(f.store.browserFor(f.parent.id)?.id).toBe(f.browser.id);
  });

  it("runtime credential refresh retains the exact owned profile and leaves desktop state untouched", () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    const desktop = readFileSync(f.file(f.parent.id));
    f.store.saveBrowser({
      ...f.browser,
      tokens: { browserd: "n".repeat(43), stream: "r".repeat(43) },
    });
    const loaded = new CellStore(f.home).getBrowser(f.browser.id);
    expect(loaded?.tokens.browserd).toBe("n".repeat(43));
    expect(loaded?.docker.profileVolume).toBe(f.browser.docker.profileVolume);
    expect(readFileSync(f.file(f.parent.id))).toEqual(desktop);
    expect(f.store.list().map((record) => record.id)).toEqual([f.parent.id]);
  });

  it.each(["root", "tokens", "docker", "ownership"] as const)(
    "rejects a persisted own __proto__ key at %s without token diagnostics or rewrite",
    (level) => {
      const f = fixture();
      const raw = JSON.parse(JSON.stringify(f.browser)) as Record<string, unknown>;
      if (level === "ownership")
        raw.ownership = { browser: "a", gate: "b", internalNetwork: "c", egressNetwork: "d" };
      const target = level === "root" ? raw : (raw[level] as Record<string, unknown>);
      Object.defineProperty(target, "__proto__", {
        value: { secret: f.browser.tokens.browserd },
        enumerable: true,
      });
      f.raw(f.browser.id, raw);
      const before = readFileSync(f.file(f.browser.id));
      const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(f.store.getStored(f.browser.id)).toBeUndefined();
      expect(readFileSync(f.file(f.browser.id))).toEqual(before);
      expect(diagnostics.mock.calls.flat().join(" ")).not.toContain(f.browser.tokens.browserd);
    },
  );

  it("an unrelated corrupt occupied identity blocks new associations and port reuse", () => {
    const f = fixture();
    const corrupt = sampleRecord();
    f.raw(corrupt.id, { v: 99, id: corrupt.id, token: f.browser.tokens.browserd });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => f.store.saveBrowser(f.browser)).toThrow("cannot be confirmed");
    const orchestrator = new CellOrchestrator({
      docker: new DockerClient("/not-a-real-socket"),
      store: f.store,
      images: { desktop: "desktop", gate: "gate" },
      probeDesktopd: async () => {},
      probeStream: async () => false,
    });
    try {
      expect(() => orchestrator.reservedKeydPorts()).toThrow("unreadable cell records");
      expect(f.store.getStored(f.browser.id)).toBeUndefined();
    } finally {
      orchestrator.dispose();
    }
  });

  it("mixed inventory reserves browser ports while desktop reconciliation ignores the browser", async () => {
    const f = fixture();
    f.store.saveBrowser(f.browser);
    f.store.remove(f.parent.id);
    const docker = new DockerClient("/not-a-real-socket");
    const effect = vi.spyOn(docker, "request");
    const orchestrator = new CellOrchestrator({
      docker,
      store: f.store,
      images: { desktop: "desktop", gate: "gate" },
      probeDesktopd: async () => {},
      probeStream: async () => false,
    });
    try {
      expect(orchestrator.reservedKeydPorts()).toContain(f.browser.keydPort);
      await orchestrator.reconcile();
      await orchestrator.containFenced();
      expect(effect).not.toHaveBeenCalled();
      expect(f.store.getBrowser(f.browser.id)).toEqual(f.browser);
    } finally {
      orchestrator.dispose();
    }
  });

  it("only the named profile is persistent and inherited config is explicitly temporary", () => {
    const record = sampleBrowserRecord();
    const spec = browserSpec(record, "fixture-image", streamOptions(), "localdot-accounts");
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: "localdot-accounts", Target: "/profile" },
    ]);
    expect(Object.hasOwn(spec.HostConfig.Tmpfs, "/config")).toBe(true);
    expect(spec.HostConfig.Tmpfs["/config"]).toMatch(/uid=1000,gid=1000,mode=0700/u);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(spec).not.toHaveProperty("ExposedPorts");
  });
});

type Rule = {
  names: string[];
  action: string;
  includes?: { caps?: string[]; arches?: string[] };
  excludes?: { caps?: string[]; arches?: string[] };
  args?: { index: number; op: string; value: number; valueTwo?: number }[];
};
const policy = JSON.parse(
  readFileSync(new URL("./browser-seccomp.json", import.meta.url), "utf8"),
) as { defaultAction: string; syscalls: Rule[] };
function allowed(name: string, arch: string, values: bigint[], caps: string[] = []) {
  return policy.syscalls.some((rule) => {
    if (!rule.names.includes(name) || rule.action !== "SCMP_ACT_ALLOW") return false;
    if (rule.includes?.arches && !rule.includes.arches.includes(arch)) return false;
    if (rule.excludes?.arches?.includes(arch)) return false;
    if (rule.includes?.caps && !rule.includes.caps.every((cap) => caps.includes(cap))) return false;
    if (rule.excludes?.caps?.some((cap) => caps.includes(cap))) return false;
    return (rule.args ?? []).every((arg) => {
      const actual = values[arg.index] ?? 0n;
      if (arg.op === "SCMP_CMP_MASKED_EQ")
        return (actual & BigInt(arg.value)) === BigInt(arg.valueTwo ?? 0);
      if (arg.op === "SCMP_CMP_EQ") return actual === BigInt(arg.value);
      return false;
    });
  });
}

describe("independent namespace policy matrix", () => {
  it.each(["amd64", "arm64", "s390", "s390x"])(
    "keeps no-capability namespace restrictions on %s",
    (arch) => {
      expect(policy.defaultAction).toBe("SCMP_ACT_ERRNO");
      const cloneArgs = (flags: bigint) =>
        arch.startsWith("s390") ? [0n, flags | 17n] : [flags | 17n, 0n];
      for (const accepted of [0x10000000n, 0x20000000n, 0x40000000n, 0x70000000n]) {
        expect(allowed("clone", arch, cloneArgs(accepted))).toBe(true);
        expect(allowed("unshare", arch, [accepted])).toBe(true);
        for (const denied of [0x00020000n, 0x02000000n, 0x04000000n, 0x08000000n]) {
          expect(allowed("clone", arch, cloneArgs(accepted | denied))).toBe(false);
          expect(allowed("unshare", arch, [accepted | denied])).toBe(false);
        }
      }
      for (const syscall of ["mount", "setns", "bpf", "clone3"])
        expect(allowed(syscall, arch, [])).toBe(false);
      expect(allowed("unshare", arch, [0x80n])).toBe(false);
      expect(allowed("chroot", arch, [])).toBe(true);
    },
  );

  it("keeps inherited conditional capability rules conditional", () => {
    expect(allowed("mount", "amd64", [])).toBe(false);
    expect(allowed("mount", "amd64", [], ["CAP_SYS_ADMIN"])).toBe(true);
    expect(allowed("bpf", "arm64", [])).toBe(false);
    expect(allowed("bpf", "arm64", [], ["CAP_BPF"])).toBe(true);
  });
});
