// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { NEUTRAL_PARAMS } from "../params.ts";
import { MascotRenderer } from "./svg-renderer.ts";

describe("MascotRenderer", () => {
  it("mounts an SVG, redraws on apply and removes itself on unmount", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const renderer = new MascotRenderer();
    await renderer.mount(host);
    const svg = host.querySelector("svg");
    expect(svg).not.toBeNull();
    const eye = host.querySelector("[data-part='eye-left']");
    renderer.apply(NEUTRAL_PARAMS, 16);
    const open = eye?.getAttribute("d");
    renderer.apply({ ...NEUTRAL_PARAMS, eyeOpenL: 0 }, 16);
    expect(eye?.getAttribute("d")).not.toBe(open);
    renderer.setPresence("glance");
    expect(svg?.getAttribute("data-presence")).toBe("glance");
    renderer.unmount();
    expect(host.querySelector("svg")).toBeNull();
  });
});
