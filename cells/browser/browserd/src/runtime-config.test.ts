import { describe, expect, it } from "vitest";
import { browserProcessSpecs, browserRuntimeConfig } from "./runtime-config.ts";

function fixture() {
  return {
    LOCALDOT_BROWSER_CELL_ID: "01K6RFS0HRH9GMASGW2YAM9WJP",
    LOCALDOT_PARENT_CELL_ID: "01K6RFS0HRH9GMASGW2YAM9WJQ",
    LOCALDOT_BROWSERD_TOKEN: "service-".padEnd(43, "s"),
    LOCALDOT_STREAM_TOKEN: "stream-".padEnd(43, "t"),
    LOCALDOT_GATE_ADDR: "172.21.0.10",
    LOCALDOT_SCALE: "2",
  };
}

describe("browser runtime bootstrap confinement", () => {
  it("keeps both bearers out of every child command and environment", () => {
    const environment = fixture();
    const config = browserRuntimeConfig(environment);
    const specs = browserProcessSpecs(config);
    const serialized = JSON.stringify(specs);
    expect(serialized).not.toContain(environment.LOCALDOT_BROWSERD_TOKEN);
    expect(serialized).not.toContain(environment.LOCALDOT_STREAM_TOKEN);
    expect(serialized).not.toContain("PASSWORD");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(specs)).toBe(true);
    for (const child of Object.values(specs)) {
      expect(Object.isFrozen(child)).toBe(true);
      expect(Object.isFrozen(child.args)).toBe(true);
      expect(Object.isFrozen(child.env)).toBe(true);
    }
  });

  it("ignores inherited process injection, debug listeners and stream overrides", () => {
    const clean = browserProcessSpecs(browserRuntimeConfig(fixture()));
    const hostile = browserProcessSpecs(
      browserRuntimeConfig({
        ...fixture(),
        PATH: "/attacker/bin",
        HOME: "/private-profile-escape",
        LD_PRELOAD: "/attacker.so",
        NODE_OPTIONS: "--require=/attacker.js",
        HTTP_PROXY: "http://bypass.invalid:9999",
        CHROME_FLAGS: "--no-sandbox --remote-debugging-port=9222",
        SELKIES_ADDR: "0.0.0.0",
        SELKIES_COMMAND_ENABLED: "true",
        SELKIES_ENABLE_CLIPBOARD: "true",
      }),
    );
    expect(hostile).toEqual(clean);
  });

  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "8.8.8.8",
    "169.254.169.254",
    "172.15.0.1",
    "172.32.0.1",
    "::1",
    "10.0.0.1\n--no-sandbox",
    "gate.example.test",
  ])("refuses a non-private/non-canonical gate destination %s", (address) => {
    expect(() => browserRuntimeConfig({ ...fixture(), LOCALDOT_GATE_ADDR: address })).toThrow(
      /^Browser configuration is invalid$/u,
    );
  });

  it.each(["10.12.2.10", "172.16.0.10", "172.31.255.10", "192.168.1.10"])(
    "accepts a private IPv4 gate %s",
    (address) => {
      const specs = browserProcessSpecs(
        browserRuntimeConfig({ ...fixture(), LOCALDOT_GATE_ADDR: address }),
      );
      expect(specs.forwarder.env.LOCALDOT_GATE_ADDR).toBe(address);
      expect(specs.chromium.env.LOCALDOT_GATE_ADDR).toBeUndefined();
      expect(specs.forwarder.env.HTTP_PROXY).toBeUndefined();
    },
  );

  it.each([
    ["LOCALDOT_BROWSER_CELL_ID", "not-an-id"],
    ["LOCALDOT_PARENT_CELL_ID", fixture().LOCALDOT_BROWSER_CELL_ID],
    ["LOCALDOT_BROWSERD_TOKEN", "short"],
    ["LOCALDOT_STREAM_TOKEN", fixture().LOCALDOT_BROWSERD_TOKEN],
    ["LOCALDOT_STREAM_TOKEN", "malformed-secret\n".padEnd(43, "t")],
    ["LOCALDOT_SCALE", "3"],
    ["LOCALDOT_SCALE", undefined],
    ["LOCALDOT_STREAM_FULLCOLOR", "true"],
    ["LOCALDOT_STREAM_FULLCOLOR", ""],
  ])("rejects malformed bootstrap field %s without reflecting it", (name, value) => {
    expect(() => browserRuntimeConfig({ ...fixture(), [name]: value })).toThrow(
      /^Browser configuration is invalid$/u,
    );
  });

  it.each([
    [undefined, "false|locked"],
    ["0", "false|locked"],
    ["1", "true|locked"],
  ])("streams 4:2:0 unless LOCALDOT_STREAM_FULLCOLOR=1 (%s)", (value, expected) => {
    const { stream } = browserProcessSpecs(
      browserRuntimeConfig({ ...fixture(), LOCALDOT_STREAM_FULLCOLOR: value }),
    );
    expect(stream.env.SELKIES_VIDEO_FULLCOLOR).toBe(expected);
  });

  it("uses the real sandboxed Chromium binary, private pipe and forced loopback-excluding proxy", () => {
    const chromium = browserProcessSpecs(browserRuntimeConfig(fixture())).chromium;
    expect(chromium.executable).toBe("/usr/lib/chromium/chromium");
    expect(chromium.channel).toBe("cdp");
    expect(chromium.args).toContain("--remote-debugging-pipe");
    expect(chromium.args).toContain("--proxy-server=http://127.0.0.1:3129");
    expect(chromium.args).toContain("--proxy-bypass-list=<-loopback>");
    expect(chromium.args).toContain("--hide-crash-restore-bubble");
    expect(chromium.args).toEqual(
      expect.arrayContaining(["--use-gl=angle", "--use-angle=gl", "--ignore-gpu-blocklist"]),
    );
    expect(chromium.env.LIBGL_ALWAYS_SOFTWARE).toBe("1");
    expect(
      chromium.args.some((argument) =>
        /(?:no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|enable-unsafe-swiftshader|remote-debugging-port|ignore-certificate-errors|allow-insecure-localhost)/u.test(
          argument,
        ),
      ),
    ).toBe(false);
    expect(chromium.args.at(-1)).toBe("about:blank");
  });

  it.each([1, 2])("matches stream pixels and display pixels at scale %s", (scale) => {
    const specs = browserProcessSpecs(
      browserRuntimeConfig({ ...fixture(), LOCALDOT_SCALE: String(scale) }),
    );
    expect(specs.display.args).toContain(`${1280 * scale}x${800 * scale}x24`);
    expect(specs.display.args).toContain("-nolisten");
    expect(specs.stream.env.SELKIES_MANUAL_WIDTH).toBe(String(1280 * scale));
    expect(specs.stream.env.SELKIES_MANUAL_HEIGHT).toBe(String(800 * scale));
    expect(specs.chromium.args).toContain(`--force-device-scale-factor=${scale}`);
  });

  it("keeps the encoder private and disables its side channels before the authenticated front", () => {
    const { stream, streamProxy } = browserProcessSpecs(browserRuntimeConfig(fixture()));
    expect(stream.env.SELKIES_ADDR).toBe("127.0.0.1");
    expect(stream.env.SELKIES_ENABLE_CLIPBOARD).toBe("false");
    expect(stream.env.SELKIES_FILE_TRANSFERS).toBe("none");
    expect(stream.env.SELKIES_ENABLE_SHARED).toBe("true|locked");
    for (const key of [
      "SELKIES_COMMAND_ENABLED",
      "SELKIES_AUDIO_ENABLED",
      "SELKIES_MICROPHONE_ENABLED",
      "SELKIES_WEBCAM_ENABLED",
      "SELKIES_GAMEPAD_ENABLED",
      "SELKIES_PRINTING_ENABLED",
      "SELKIES_ENABLE_SHARING",
      "SELKIES_ENABLE_COLLAB",
      "SELKIES_ENABLE_PLAYER2",
      "SELKIES_ENABLE_PLAYER3",
      "SELKIES_ENABLE_PLAYER4",
      "SELKIES_ENABLE_BINARY_CLIPBOARD",
      "SELKIES_ENABLE_DUAL_MODE",
    ])
      expect(stream.env[key]).toBe("false|locked");
    expect(streamProxy.executable).toBe("/usr/sbin/nginx");
    expect(streamProxy.args).toContain("/etc/localdot/browser-nginx.conf");
  });
});
