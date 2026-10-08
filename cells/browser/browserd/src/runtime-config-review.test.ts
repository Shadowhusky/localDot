import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browserProcessSpecs, browserRuntimeConfig } from "./runtime-config.ts";

function environment() {
  return {
    LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
    LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
    LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
    LOCALDOT_STREAM_TOKEN: "b".repeat(43),
    LOCALDOT_GATE_ADDR: "172.20.0.2",
    LOCALDOT_SCALE: "2",
  };
}

describe("independent fixed browser runtime configuration", () => {
  it("does not read unknown inherited injection settings or copy their getters", () => {
    const source = environment();
    let reads = 0;
    for (const key of ["NODE_OPTIONS", "LD_PRELOAD", "SELKIES_COMMAND_ENABLED", "HTTP_PROXY"])
      Object.defineProperty(source, key, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error("unrelated-private-value");
        },
      });
    const specs = browserProcessSpecs(browserRuntimeConfig(source));
    expect(reads).toBe(0);
    for (const value of Object.values(specs)) {
      expect(value.env.NODE_OPTIONS).toBeUndefined();
      expect(value.env.LD_PRELOAD).toBeUndefined();
      expect(value.env.HTTP_PROXY).toBeUndefined();
    }
    expect(specs.stream.env.SELKIES_COMMAND_ENABLED).toBe("false|locked");
  });

  it("a later bootstrap mutation cannot change captured destinations or either child's secrets", () => {
    const source = environment();
    const config = browserRuntimeConfig(source),
      specs = browserProcessSpecs(config);
    source.LOCALDOT_GATE_ADDR = "8.8.8.8";
    source.LOCALDOT_BROWSERD_TOKEN = "later-secret";
    source.LOCALDOT_SCALE = "1";
    expect(config.gateAddress).toBe("172.20.0.2");
    expect(specs.forwarder.env.LOCALDOT_GATE_ADDR).toBe("172.20.0.2");
    expect(specs.display.args).toContain("2560x1600x24");
    const serialized = JSON.stringify(specs);
    expect(serialized).not.toContain("a".repeat(43));
    expect(serialized).not.toContain("b".repeat(43));
    expect(serialized).not.toContain("later-secret");
  });

  it("rejects structurally extended config and forged scale before constructing commands", () => {
    const config = browserRuntimeConfig(environment());
    expect(() =>
      browserProcessSpecs({ ...config, args: ["--no-sandbox"] } as typeof config),
    ).toThrow(/^Browser configuration is invalid$/u);
    expect(() =>
      browserProcessSpecs({ ...config, scale: "2" } as unknown as typeof config),
    ).toThrow(/^Browser configuration is invalid$/u);
    expect(() =>
      browserProcessSpecs({ ...config, fullcolor: "true" } as unknown as typeof config),
    ).toThrow(/^Browser configuration is invalid$/u);
  });

  it("pins the private front to authenticated GET endpoints with discarded upstream auth and logs", () => {
    const text = readFileSync(
      new URL("../../root/etc/localdot/browser-nginx.conf", import.meta.url),
      "utf8",
    );
    expect(text).toContain('auth_basic "localDot browser";');
    expect(text).toContain("auth_basic_user_file /tmp/browser-runtime/stream.htpasswd;");
    expect(text).not.toMatch(/auth_basic\s+off/u);
    expect([...text.matchAll(/location = (\S+)/gu)].map((m) => m[1])).toEqual([
      "/api/status",
      "/api/websockets",
    ]);
    expect(text.match(/if \(\$request_method != GET\) \{ return 405; \}/gu)).toHaveLength(2);
    expect(text.match(/proxy_set_header Authorization "";/gu)).toHaveLength(2);
    expect(text).toContain("location / { return 404; }");
    expect(text).toContain("access_log off;");
    expect(text).toContain("error_log /dev/null;");
  });
});
