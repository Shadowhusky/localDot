import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserCellNames, browserSpec, chromiumSeccomp } from "./browser-spec.ts";
import { CHROMIUM_SANDBOX_RULE, chromiumProfile } from "./seccomp.ts";
import type { CellRecord } from "./types.ts";

const ID = "01JXYZ0000000000000000BRWS";
const PARENT = "01JXYZ0000000000000000ABCD";
const names = browserCellNames(ID);
const record: CellRecord = {
  v: 1,
  id: ID,
  createdAt: "2026-10-02T00:00:00.000Z",
  scale: 2,
  keydPort: 4761,
  tokens: { desktopd: "d".repeat(43), stream: "s".repeat(43) },
  kind: "browser",
  parent: PARENT,
  docker: { ...names, gateInternalIp: "172.24.0.10", gateEgressIp: "172.25.0.10", desktopIp: "172.24.0.11" },
};
const KEYD_ENV = ["LOCALDOT_CELL_ID=x", "HTTPS_PROXY=http://127.0.0.1:3129"];

describe("browserSpec (Review Focus 1 and 5)", () => {
  const seccompFile = join(mkdtempSync(join(tmpdir(), "ld-sc-")), "p.json");
  writeFileSync(seccompFile, JSON.stringify(chromiumProfile({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] })));
  const spec = browserSpec(record, "localdot/browser:dev", chromiumSeccomp(seccompFile), KEYD_ENV);

  it("runs read-only as uid 1000 with every capability dropped, no new privileges and the sandbox profile", () => {
    expect(spec.User).toBe("1000:1000");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig).not.toHaveProperty("CapAdd");
    expect(spec.HostConfig).not.toHaveProperty("Privileged");
    expect(spec.HostConfig.SecurityOpt[0]).toBe("no-new-privileges");
    const profile = JSON.parse(spec.HostConfig.SecurityOpt[1]?.replace(/^seccomp=/, "") ?? "{}");
    expect(profile.syscalls.at(-1)).toEqual(CHROMIUM_SANDBOX_RULE);
  });

  it("sits alone on its internal network and mounts the profile here and nowhere else", () => {
    expect(spec.HostConfig.NetworkMode).toBe(`localdot-cell-${ID}`);
    expect(Object.keys(spec.NetworkingConfig.EndpointsConfig)).toEqual([`localdot-cell-${ID}`]);
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: `localdot-profile-${ID}`, Target: "/profile" },
      { Type: "volume", Source: `localdot-cellfiles-${ID}`, Target: "/etc/localdot/cell" },
    ]);
    expect(JSON.stringify(spec)).not.toContain("docker.sock");
    expect(JSON.stringify(spec)).not.toContain(`localdot-home-${PARENT}`);
    expect(spec.HostConfig.Tmpfs["/tmp"]).toContain("noexec");
  });

  it("carries no secret: tokens and keyd's proxy settings only", () => {
    expect(spec.Env.join("\n")).not.toMatch(/ld_[a-z0-9]{2,12}_|BEGIN CERTIFICATE/);
    expect(spec.Env).toContain("HTTPS_PROXY=http://127.0.0.1:3129");
  });

  it("refuses a record that is not a browser's", () => {
    expect(() => browserSpec({ ...record, kind: "desktop" }, "i", "{}", [])).toThrow();
    expect(() => browserSpec({ ...record, parent: undefined }, "i", "{}", [])).toThrow();
  });
});

describe("chromiumProfile", () => {
  it("adds exactly the sandbox rule to Docker's default profile", () => {
    const base = { defaultAction: "SCMP_ACT_ERRNO", defaultErrnoRet: 1, syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] };
    const out = chromiumProfile(base);
    expect(out.syscalls).toEqual([...base.syscalls, CHROMIUM_SANDBOX_RULE]);
    expect({ ...out, syscalls: out.syscalls.slice(0, -1) }).toEqual(base);
    expect(() => chromiumProfile({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [] })).toThrow();
  });
});
