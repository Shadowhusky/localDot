import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { assertLoopbackBindPorts } from "@anthropic-ai/sandbox-runtime/dist/sandbox/loopback-bind.js";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { loadConfigFromString } from "@anthropic-ai/sandbox-runtime/dist/utils/config-loader.js";
import { describe, expect, it } from "vitest";

const network = {
  allowedDomains: ["chatgpt.com:443", "auth.openai.com:443"],
  deniedDomains: [],
  strictAllowlist: true,
  allowLocalBinding: false,
  loopbackBindPorts: [1455],
};
const settings = {
  network,
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
};
const wrapper = {
  command: "/usr/bin/true",
  needsNetworkRestriction: true,
  readConfig: { denyOnly: [], allowWithinDeny: [] },
  writeConfig: { allowOnly: [], denyWithinAllow: [] },
  allowLocalBinding: false,
  loopbackBindPorts: [1455],
  binShell: "/bin/sh",
};

describe("the exact pinned native-loopback patch", () => {
  it("emits only callback bind/inbound and keeps exact proxy connectivity", () => {
    const result = wrapCommandWithSandboxMacOS({
      ...wrapper,
      httpProxyPort: 19877,
      socksProxyPort: 19878,
    });
    expect(result).toContain('(allow network-bind (local ip "localhost:1455"))');
    expect(result).toContain('(allow network-inbound (local ip "localhost:1455"))');
    expect(result).not.toContain('(remote ip "localhost:1455")');
    expect(result).not.toContain('"*:*"');
    expect(result).not.toContain('"localhost:*"');
    expect(result).not.toContain("(allow network*)");
    for (const port of [19877, 19878])
      expect(result).toContain(`(allow network-outbound (remote ip "localhost:${port}"))`);
  });
  it.each(
    [
      [],
      [0],
      [65536],
      [1.5],
      [1455, 1455],
      Array.from({ length: 33 }, (_, index) => index + 1),
    ].map((ports) => ({ ports })),
  )("rejects invalid exact ports: $ports", ({ ports: loopbackBindPorts }) => {
    expect(
      loadConfigFromString(
        JSON.stringify({ ...settings, network: { ...network, loopbackBindPorts } }),
      ),
    ).toBeNull();
    expect(() => wrapCommandWithSandboxMacOS({ ...wrapper, loopbackBindPorts })).toThrow();
  });
  it("rejects broad local binding/all Unix sockets and weaker isolation at the runtime boundary", async () => {
    for (const extra of [
      { allowLocalBinding: true },
      { allowAllUnixSockets: true },
      { strictAllowlist: false },
    ]) {
      const bad = { ...settings, network: { ...network, ...extra } };
      expect(loadConfigFromString(JSON.stringify(bad))).toBeNull();
      await expect(SandboxManager.initialize(bad)).rejects.toThrow();
      expect(() => SandboxManager.updateConfig(bad)).toThrow();
    }
    expect(() => wrapCommandWithSandboxMacOS({ ...wrapper, allowLocalBinding: true })).toThrow();
    expect(() => wrapCommandWithSandboxMacOS({ ...wrapper, allowAllUnixSockets: true })).toThrow();
    expect(() =>
      wrapCommandWithSandboxMacOS({ ...wrapper, needsNetworkRestriction: false }),
    ).toThrow();
    expect(() =>
      wrapCommandWithSandboxMacOS({ ...wrapper, enableWeakerNetworkIsolation: true }),
    ).toThrow();
  });
  it.each(["linux", "windows", "unknown"])(
    "fails closed on unsupported %s instead of ignoring the restriction",
    (platform) => {
      expect(() => assertLoopbackBindPorts(network, platform)).toThrow();
      expect(() =>
        assertLoopbackBindPorts({ ...network, loopbackBindPorts: undefined }, platform),
      ).not.toThrow();
    },
  );
});
