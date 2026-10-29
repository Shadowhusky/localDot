import { describe, expect, it } from "vitest";
import { previewPortRange } from "./config.ts";
import { frontFor, frontHosts, isTailnetAddress, previewFronts } from "./fronts.ts";

const SERVED = {
  state: "served" as const,
  origin: "https://pc.example.ts.net:4750",
  message: "Copy a link and open it on any device signed in to your Tailscale network.",
};

describe("the preview port block", () => {
  it("defaults to 4900-4915 and takes another block from LOCALDOT_PREVIEW_PORTS", () => {
    expect(previewPortRange(undefined)).toEqual({ from: 4900, to: 4915 });
    expect(previewPortRange("")).toEqual({ from: 4900, to: 4915 });
    expect(previewPortRange("4920-4935")).toEqual({ from: 4920, to: 4935 });
    for (const text of ["4900", "80-90", "4915-4900", "4900-70000", "4900-5200", "a-b"])
      expect(() => previewPortRange(text), text).toThrow(RangeError);
  });
});

describe("where previews open", () => {
  it("knows tailnet addresses", () => {
    expect(isTailnetAddress("100.91.187.75")).toBe(true);
    expect(isTailnetAddress("100.64.0.1")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("192.168.1.2")).toBe(false);
    expect(isTailnetAddress("[fd7a:115c:a1e0::a939:bb4b]")).toBe(true);
    expect(isTailnetAddress("pc.example.ts.net")).toBe(false);
  });

  it("uses an address front for every device when one is set up, beside Serve or not", () => {
    const fronts = previewFronts(
      ["https://pc.example.ts.net:4750", "https://100.91.187.75:4744", "https://example.com"],
      SERVED,
    );
    expect(fronts).toMatchObject({ direct: ["100.91.187.75"], served: "pc.example.ts.net" });
    expect(frontFor(fronts, "100.91.187.75:4744")).toEqual({
      hostname: "100.91.187.75",
      serve: false,
    });
    expect(frontFor(fronts, "localhost:4750")).toEqual({ hostname: "100.91.187.75", serve: false });
    expect(frontFor(fronts, "pc.example.ts.net:4750")).toEqual({
      hostname: "100.91.187.75",
      serve: false,
    });
  });

  it("uses Tailscale Serve's name otherwise, and nothing without Tailscale", () => {
    const served = previewFronts([], SERVED);
    expect(frontFor(served, "localhost:4750")).toEqual({
      hostname: "pc.example.ts.net",
      serve: true,
    });
    expect(frontFor(served, undefined)).toEqual({ hostname: "pc.example.ts.net", serve: true });
    const none = previewFronts(["https://example.com"], {
      state: "ready-to-enable",
      origin: "https://pc.example.ts.net:4750",
      message: "Turn on to open localDot from your devices signed in to Tailscale.",
    });
    expect(frontFor(none, "localhost:4750")).toBeUndefined();
    expect(none.problem).toContain("Turn on Tailscale in Settings › Your computer");
    const missing = previewFronts([], {
      state: "not-installed",
      message: "Tailscale isn't installed on this Mac. Install it and sign in to use it here.",
    });
    expect(missing.problem).toContain("Tailscale isn't installed on this Mac.");
  });

  it("accepts each front's name with the preview's port, and nothing else", () => {
    const fronts = previewFronts(["https://100.91.187.75:4744"], SERVED);
    expect(frontHosts(fronts, 4901)).toEqual(
      new Set(["100.91.187.75:4901", "pc.example.ts.net:4901"]),
    );
  });
});
