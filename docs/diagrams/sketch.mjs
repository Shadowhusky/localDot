import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rough = require("roughjs");
const opentype = require("opentype.js");

const font = (file) => {
  const data = readFileSync(new URL(`./fonts/${file}`, import.meta.url));
  return opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
};
const REGULAR = font("Kalam-Regular.ttf");
const BOLD = font("Kalam-Bold.ttf");

export const GRAPHITE = "#2c2e33";
export const SOFT = "#5d6168";
export const XENON = "#3fb5de";
const PAPER = "#f6f2e8";

const round = (n) => Math.round(n * 10) / 10;

// One sheet of paper. Every shape takes the next seed, so a rebuild draws the same wobble.
export class Sheet {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.gen = rough.generator();
    this.seed = 1;
    this.strokes = [];
    this.letters = [];
  }

  #options(options = {}) {
    return {
      stroke: GRAPHITE,
      strokeWidth: 2.2,
      roughness: 1.5,
      bowing: 1.3,
      fillStyle: "hachure",
      fillWeight: 1.5,
      hachureGap: 7,
      hachureAngle: -41,
      seed: this.seed++,
      ...options,
    };
  }

  #add(drawable) {
    const dash = drawable.options.strokeLineDash;
    const dashed = dash ? ` stroke-dasharray="${dash.join(" ")}"` : "";
    for (const p of this.gen.toPaths(drawable))
      this.strokes.push(
        `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill ?? "none"}" stroke-linecap="round" stroke-linejoin="round"${dashed}/>`,
      );
  }

  rect(x, y, w, h, options) {
    this.#add(this.gen.rectangle(x, y, w, h, this.#options(options)));
  }

  rounded(x, y, w, h, r, options) {
    const d = `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
    this.#add(this.gen.path(d, this.#options(options)));
  }

  circle(cx, cy, d, options) {
    this.#add(this.gen.circle(cx, cy, d, this.#options(options)));
  }

  ellipse(cx, cy, w, h, options) {
    this.#add(this.gen.ellipse(cx, cy, w, h, this.#options(options)));
  }

  line(x1, y1, x2, y2, options) {
    this.#add(this.gen.line(x1, y1, x2, y2, this.#options(options)));
  }

  path(d, options) {
    this.#add(this.gen.path(d, this.#options(options)));
  }

  polygon(points, options) {
    this.#add(this.gen.polygon(points, this.#options(options)));
  }

  polyline(points, options) {
    this.#add(this.gen.linearPath(points, this.#options(options)));
  }

  // A hand-drawn arrow along a curve through `points`, head at the last point.
  arrow(points, options = {}) {
    const { head = 17, ...rest } = options;
    if (points.length === 2) this.line(...points[0], ...points[1], { roughness: 1.1, ...rest });
    else this.#add(this.gen.curve(points, this.#options({ roughness: 1.1, ...rest })));
    const [ax, ay] = points.at(-2);
    const [bx, by] = points.at(-1);
    const angle = Math.atan2(by - ay, bx - ax);
    for (const turn of [0.5, -0.5]) {
      const a = angle + Math.PI + turn;
      this.line(bx, by, bx + head * Math.cos(a), by + head * Math.sin(a), {
        roughness: 0.8,
        ...rest,
      });
    }
  }

  tick(x, y, size = 26, options) {
    this.polyline(
      [
        [x - size * 0.45, y],
        [x - size * 0.1, y + size * 0.38],
        [x + size * 0.5, y - size * 0.45],
      ],
      { strokeWidth: 3, ...options },
    );
  }

  cross(x, y, size = 24, options) {
    const h = size / 2;
    this.line(x - h, y - h, x + h, y + h, { strokeWidth: 3, ...options });
    this.line(x - h, y + h, x + h, y - h, { strokeWidth: 3, ...options });
  }

  // Hand lettering, converted to outlines so the file needs no font to render.
  text(content, x, y, options = {}) {
    const {
      size = 28,
      bold = false,
      anchor = "start",
      color = GRAPHITE,
      leading = 1.25,
      rotate = 0,
    } = options;
    const face = bold ? BOLD : REGULAR;
    const lines = String(content).split("\n");
    lines.forEach((line, i) => {
      const width = face.getAdvanceWidth(line, size);
      const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
      const d = face.getPath(line, left, y + i * size * leading, size).toPathData(1);
      const turn = rotate ? ` transform="rotate(${rotate} ${round(x)} ${round(y)})"` : "";
      this.letters.push(`<path d="${d}" fill="${color}"${turn}/>`);
    });
  }

  measure(content, size = 28, bold = false) {
    return (bold ? BOLD : REGULAR).getAdvanceWidth(content, size);
  }

  svg(title) {
    const { width: w, height: h } = this;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}">
<title>${title}</title>
<defs>
<filter id="grain" x="0" y="0" width="100%" height="100%">
<feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="3" seed="4"/>
<feColorMatrix type="matrix" values="0 0 0 0 0.33  0 0 0 0 0.3  0 0 0 0 0.25  0 0 0 -0.55 0.36"/>
</filter>
<filter id="fibres" x="0" y="0" width="100%" height="100%">
<feTurbulence type="fractalNoise" baseFrequency="0.012 0.09" numOctaves="2" seed="9"/>
<feColorMatrix type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.45  0 0 0 0 0.36  0 0 0 -0.2 0.11"/>
</filter>
<filter id="pencil" x="-5%" y="-5%" width="110%" height="110%">
<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="wobble"/>
<feDisplacementMap in="SourceGraphic" in2="wobble" scale="1.8" xChannelSelector="R" yChannelSelector="G" result="moved"/>
<feTurbulence type="fractalNoise" baseFrequency="1.7" numOctaves="1" seed="3" result="tooth"/>
<feColorMatrix in="tooth" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.4 1.85" result="graphite"/>
<feComposite in="moved" in2="graphite" operator="in"/>
</filter>
<filter id="lead" x="-2%" y="-5%" width="104%" height="110%">
<feTurbulence type="fractalNoise" baseFrequency="1.9" numOctaves="1" seed="11" result="tooth"/>
<feColorMatrix in="tooth" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.75" result="graphite"/>
<feComposite in="SourceGraphic" in2="graphite" operator="in"/>
</filter>
<pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
<path d="M32 0H0V32" fill="none" stroke="#7fa3bf" stroke-width="0.8" stroke-opacity="0.22"/>
</pattern>
<radialGradient id="vignette" cx="50%" cy="45%" r="75%">
<stop offset="60%" stop-color="#8a7a5a" stop-opacity="0"/>
<stop offset="100%" stop-color="#8a7a5a" stop-opacity="0.16"/>
</radialGradient>
</defs>
<rect width="${w}" height="${h}" fill="${PAPER}"/>
<rect width="${w}" height="${h}" fill="url(#grid)"/>
<rect width="${w}" height="${h}" filter="url(#fibres)"/>
<rect width="${w}" height="${h}" filter="url(#grain)"/>
<rect width="${w}" height="${h}" fill="url(#vignette)"/>
<g filter="url(#pencil)">
${this.strokes.join("\n")}
</g>
<g filter="url(#lead)">
${this.letters.join("\n")}
</g>
</svg>
`;
  }
}
