import type { AvatarParams } from "../params.ts";
import type { AvatarRenderer, Presence, ThemePack } from "../renderer.ts";
import { eyePath, mascotGeometry } from "./geometry.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export class MascotRenderer implements AvatarRenderer {
  #svg: SVGSVGElement | null = null;
  #parts: Record<string, SVGElement> = {};

  async mount(host: HTMLElement, _pack?: ThemePack): Promise<void> {
    const svg = el("svg", {
      viewBox: "0 0 100 100",
      role: "img",
      "aria-label": "localDot companion",
    });
    const clip = el("clipPath", { id: `mascot-clip-${Math.random().toString(36).slice(2)}` });
    const clipBody = el("ellipse", { cx: "50", cy: "54", rx: "30", ry: "30" });
    clip.appendChild(clipBody);
    const defs = el("defs", {});
    defs.appendChild(clip);
    const body = el("ellipse", {
      cx: "50",
      cy: "54",
      rx: "30",
      ry: "30",
      fill: "var(--avatar-body, #ECEDEF)",
      "data-part": "body",
    });
    const face = el("g", { "clip-path": `url(#${clip.id})`, "data-part": "face" });
    const eyeAttrs = {
      fill: "none",
      stroke: "var(--avatar-eye, #0A0B0D)",
      "stroke-width": "4.2",
      "stroke-linecap": "round",
    };
    const eyeLeft = el("path", { ...eyeAttrs, "data-part": "eye-left" });
    const eyeRight = el("path", { ...eyeAttrs, "data-part": "eye-right" });
    const mouth = el("ellipse", { fill: "var(--avatar-eye, #0A0B0D)", "data-part": "mouth" });
    const blushLeft = el("ellipse", {
      rx: "4",
      ry: "2.4",
      fill: "var(--avatar-blush, #E88AA0)",
      "data-part": "blush-left",
    });
    const blushRight = el("ellipse", {
      rx: "4",
      ry: "2.4",
      fill: "var(--avatar-blush, #E88AA0)",
      "data-part": "blush-right",
    });
    for (const part of [eyeLeft, eyeRight, mouth, blushLeft, blushRight]) face.appendChild(part);
    svg.append(defs, body, face);
    host.appendChild(svg);
    this.#svg = svg;
    this.#parts = { clipBody, body, face, eyeLeft, eyeRight, mouth, blushLeft, blushRight };
  }

  apply(params: AvatarParams, _dtMs: number): void {
    if (!this.#svg) return;
    const g = mascotGeometry(params);
    const p = this.#parts;
    for (const node of [p.body, p.clipBody]) {
      node?.setAttribute("cx", `${g.body.cx}`);
      node?.setAttribute("cy", `${g.body.cy}`);
      node?.setAttribute("ry", `${g.body.ry}`);
    }
    p.face?.setAttribute("transform", `rotate(${g.tiltDeg} ${g.body.cx} ${g.body.cy})`);
    p.eyeLeft?.setAttribute("d", eyePath(g.eyes[0]));
    p.eyeRight?.setAttribute("d", eyePath(g.eyes[1]));
    p.mouth?.setAttribute("cx", `${g.mouth.cx}`);
    p.mouth?.setAttribute("cy", `${g.mouth.cy}`);
    p.mouth?.setAttribute("rx", `${g.mouth.rx}`);
    p.mouth?.setAttribute("ry", `${g.mouth.ry}`);
    p.mouth?.setAttribute("opacity", g.mouth.visible ? "1" : "0");
    p.blushLeft?.setAttribute("cx", `${g.eyes[0].cx - 3}`);
    p.blushLeft?.setAttribute("cy", `${g.eyes[0].cy + 9}`);
    p.blushRight?.setAttribute("cx", `${g.eyes[1].cx + 3}`);
    p.blushRight?.setAttribute("cy", `${g.eyes[1].cy + 9}`);
    for (const node of [p.blushLeft, p.blushRight])
      node?.setAttribute("opacity", `${g.blushOpacity}`);
  }

  setPresence(presence: Presence): void {
    this.#svg?.setAttribute("data-presence", presence);
  }

  unmount(): void {
    this.#svg?.remove();
    this.#svg = null;
    this.#parts = {};
  }
}
