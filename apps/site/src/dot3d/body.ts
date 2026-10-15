import { EYE_ANCHORS, R } from "@app/dot/engine/sphere.ts";
import {
  Color,
  DataTexture,
  Matrix3,
  MeshPhysicalMaterial,
  type Texture,
  Vector2,
  Vector4,
} from "three";
import type { EyeUniformValues } from "./face.ts";

// dot's porcelain (tools/dot-plates/plates.json "body"), with its two eyes painted on by the same
// geometry the app's SVG face uses: each eye is a decal projected along the face's axis, so the
// sphere carries it and a turn foreshortens it.
export interface BodyUniforms {
  uFace: { value: Matrix3 };
  uAnchor: { value: Vector2[] };
  uCaps: { value: Vector4[] };
  uLidA: { value: Vector4[] };
  uLidB: { value: Vector2[] };
  uHappy: { value: Vector4[] };
  uClosed: { value: Vector4[] };
  uArcs: { value: Vector2[] };
  uGloss: { value: Vector4[] };
  uGlossAlpha: { value: number[] };
  uUnitsPerPx: { value: number };
  uDim: { value: number };
  // The shade each worn item casts on the body (tools/dot-plates export_glb.py), white when none,
  // and which of them are cast by what sits on the face, so they turn with it.
  uShade0: { value: Texture };
  uShade1: { value: Texture };
  uShade2: { value: Texture };
  uShade3: { value: Texture };
  uShadeOnFace: { value: Vector4 };
}

const WHITE = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
export const SHADES = 4;

const EYE_GLSL = /* glsl */ `
uniform mat3 uFace;
uniform vec2 uAnchor[2];
uniform vec4 uCaps[2];
uniform vec4 uLidA[2];
uniform vec2 uLidB[2];
uniform vec4 uHappy[2];
uniform vec4 uClosed[2];
uniform vec2 uArcs[2];
uniform vec4 uGloss[2];
uniform float uGlossAlpha[2];
uniform float uUnitsPerPx;
uniform float uDim;
uniform sampler2D uShade0;
uniform sampler2D uShade1;
uniform sampler2D uShade2;
uniform sampler2D uShade3;
uniform vec4 uShadeOnFace;
varying vec3 vBody;

vec2 shadeUv(vec3 p) {
  return vec2(0.5 + atan(p.x, p.z) / 6.2831853, 0.5 + asin(clamp(p.y, -1.0, 1.0)) / 3.1415927);
}

// The worn items' shade at a point of the body: u = 0.5 + atan2(x, z) / 2pi, v = 0.5 + asin(y) / pi,
// read where the body is for what the head wears and where the face is for what the face wears.
float shade(vec3 body, vec3 face) {
  vec2 b = shadeUv(body);
  vec2 f = shadeUv(face);
  return texture2D(uShade0, mix(b, f, uShadeOnFace.x)).r * texture2D(uShade1, mix(b, f, uShadeOnFace.y)).r *
    texture2D(uShade2, mix(b, f, uShadeOnFace.z)).r * texture2D(uShade3, mix(b, f, uShadeOnFace.w)).r;
}

float quadY(float x, float halfW, float y0, float y1, float y2) {
  float t = clamp(0.5 * (x / halfW + 1.0), 0.0, 1.0);
  return (1.0 - t) * (1.0 - t) * y0 + 2.0 * t * (1.0 - t) * y1 + t * t * y2;
}

float dot2(vec2 v) {
  return dot(v, v);
}

// The exact distance from p to the quadratic Bezier A, B, C (Inigo Quilez's solution of the cubic).
float bezier(vec2 p, vec2 A, vec2 B, vec2 C) {
  vec2 a = B - A;
  vec2 b = A - 2.0 * B + C;
  vec2 c = a * 2.0;
  vec2 d = A - p;
  float kk = 1.0 / dot(b, b);
  float kx = kk * dot(a, b);
  float ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  float kz = kk * dot(d, a);
  float q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  float pp = ky - kx * kx;
  float h = q * q + 4.0 * pp * pp * pp;
  if (h >= 0.0) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - q) / 2.0;
    vec2 uv = sign(x) * pow(abs(x), vec2(1.0 / 3.0));
    float t = clamp(uv.x + uv.y - kx, 0.0, 1.0);
    return sqrt(dot2(d + (c + b * t) * t));
  }
  float z = sqrt(-pp);
  float v = acos(q / (pp * z * 2.0)) / 3.0;
  float m = cos(v);
  float n = sin(v) * 1.732050808;
  vec3 t = clamp(vec3(m + m, -n - m, n - m) * z - kx, 0.0, 1.0);
  return sqrt(min(dot2(d + (c + b * t.x) * t.x), dot2(d + (c + b * t.y) * t.y)));
}

// Coverage of an arc from (-aw, y) through control (0, peak) to (aw, y), stroked with round caps as
// the app's SVG draws it.
float arc(vec2 q, vec4 a, float aa) {
  vec2 A = vec2(-a.x, a.y);
  vec2 C = vec2(a.x, a.y);
  float d;
  if (abs(a.z - a.y) < 1e-4) {
    vec2 s = C - A;
    d = length(q - A - s * clamp(dot(q - A, s) / dot(s, s), 0.0, 1.0));
  } else {
    d = bezier(q, A, vec2(0.0, a.z), C);
  }
  return 1.0 - smoothstep(0.5 * a.w - aa, 0.5 * a.w + aa, d);
}

// One eye at q, in its own frame units with y down: x the ink, y the gloss.
vec2 eye(int i, vec2 q, float aa) {
  vec4 caps = uCaps[i];
  float hw = caps.x;
  float hh = caps.y;
  float r = hw;
  float h = max(hh - r, 0.0);
  vec2 c = vec2(q.x, q.y - clamp(q.y, -h, h));
  float capsule = 1.0 - smoothstep(-aa, aa, length(c) - r);
  vec4 lidA = uLidA[i];
  vec2 lidB = uLidB[i];
  float W = lidA.x;
  float top = quadY(q.x, W, lidA.y - lidA.w * W, lidA.y + 2.0 * lidB.x, lidA.y + lidA.w * W);
  float bottom = quadY(q.x, W, lidA.z, lidA.z - 2.0 * lidB.y, lidA.z);
  float open = smoothstep(top - aa, top + aa, q.y) * (1.0 - smoothstep(bottom - aa, bottom + aa, q.y));
  // The app lets the squinting eye and its arc overlap as one becomes the other, which a small dot
  // blurs together; this large, the squint's sliver would show as a second eye above the arc. So the
  // open eye gives way as an arc starts to show.
  float yield = 1.0 - smoothstep(0.0, 0.25, max(uArcs[i].x, uArcs[i].y));
  float ink = capsule * open * caps.z * yield;
  ink = max(ink, arc(q, uHappy[i], aa) * uArcs[i].x);
  ink = max(ink, arc(q, uClosed[i], aa) * uArcs[i].y);
  vec4 g = uGloss[i];
  float e = length((q - g.xy) / g.zw);
  // The app's gloss gradient (GLOSS_STOPS): 0.75 at the centre, 0.22 at 0.55, clear at the rim.
  float stop = e < 0.55 ? mix(0.75, 0.22, e / 0.55) : mix(0.22, 0.0, clamp((e - 0.55) / 0.45, 0.0, 1.0));
  float gloss = stop * uGlossAlpha[i] * capsule * open * yield;
  return vec2(ink * caps.w, gloss * caps.w);
}
`;

export function bodyMaterial(): { material: MeshPhysicalMaterial; uniforms: BodyUniforms } {
  const uniforms: BodyUniforms = {
    uFace: { value: new Matrix3() },
    uAnchor: { value: EYE_ANCHORS.map(([x, y]) => new Vector2(x, y)) },
    uCaps: { value: [new Vector4(), new Vector4()] },
    uLidA: { value: [new Vector4(), new Vector4()] },
    uLidB: { value: [new Vector2(), new Vector2()] },
    uHappy: { value: [new Vector4(1, 0, 0, 1), new Vector4(1, 0, 0, 1)] },
    uClosed: { value: [new Vector4(1, 0, 0, 1), new Vector4(1, 0, 0, 1)] },
    uArcs: { value: [new Vector2(), new Vector2()] },
    uGloss: { value: [new Vector4(0, 0, 1, 1), new Vector4(0, 0, 1, 1)] },
    uGlossAlpha: { value: [0, 0] },
    uUnitsPerPx: { value: 0.1 },
    uDim: { value: 0 },
    uShade0: { value: WHITE },
    uShade1: { value: WHITE },
    uShade2: { value: WHITE },
    uShade3: { value: WHITE },
    uShadeOnFace: { value: new Vector4() },
  };
  const material = new MeshPhysicalMaterial({
    color: new Color(0.8, 0.812, 0.83),
    roughness: 0.5,
    clearcoat: 0.12,
    clearcoatRoughness: 0.4,
    sheen: 0.25,
    sheenRoughness: 0.6,
    sheenColor: new Color(1, 1, 1),
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBody;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBody = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${EYE_GLSL}`)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec3 faceP = uFace * normalize(vBody);
        vec2 frame = vec2(faceP.x, -faceP.y) * ${R.toFixed(1)};
        float aa = max(uUnitsPerPx, 0.02) * 0.75;
        vec2 inkGloss = vec2(0.0);
        if (faceP.z > 0.0) {
          vec2 a = eye(0, frame - uAnchor[0], aa);
          vec2 b = eye(1, frame - uAnchor[1], aa);
          inkGloss = max(a, b);
        }
        vec3 eyeInk = mix(vec3(0.0105, 0.0115, 0.014), vec3(0.003, 0.0035, 0.004), clamp(frame.y * 0.08 + 0.5, 0.0, 1.0));
        diffuseColor.rgb *= shade(normalize(vBody), normalize(faceP));
        diffuseColor.rgb = mix(diffuseColor.rgb, eyeInk, inkGloss.x);`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, inkGloss.x);",
      )
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `outgoingLight = mix(outgoingLight, outgoingLight * 0.3, uDim);
        outgoingLight = mix(outgoingLight, eyeInk + min(outgoingLight, vec3(1.0)) * 0.035, inkGloss.x);
        outgoingLight = mix(outgoingLight, vec3(0.8), inkGloss.y * (1.0 - uDim * 0.7));
        #include <opaque_fragment>`,
      );
  };
  return { material, uniforms };
}

export function setEyes(
  uniforms: BodyUniforms,
  eyes: readonly [EyeUniformValues, EyeUniformValues],
) {
  eyes.forEach((e, i) => {
    (uniforms.uCaps.value[i] as Vector4).set(...e.caps);
    (uniforms.uLidA.value[i] as Vector4).set(...e.lidA);
    (uniforms.uLidB.value[i] as Vector2).set(...e.lidB);
    (uniforms.uHappy.value[i] as Vector4).set(...e.happy);
    (uniforms.uClosed.value[i] as Vector4).set(...e.closed);
    (uniforms.uArcs.value[i] as Vector2).set(...e.arcs);
    (uniforms.uGloss.value[i] as Vector4).set(...e.gloss);
    uniforms.uGlossAlpha.value[i] = e.glossAlpha;
  });
}

export function setShades(
  uniforms: BodyUniforms,
  shades: readonly (Texture | null)[],
  onFace: readonly boolean[],
): void {
  uniforms.uShade0.value = shades[0] ?? WHITE;
  uniforms.uShade1.value = shades[1] ?? WHITE;
  uniforms.uShade2.value = shades[2] ?? WHITE;
  uniforms.uShade3.value = shades[3] ?? WHITE;
  uniforms.uShadeOnFace.value.set(
    ...([0, 1, 2, 3].map((i) => (onFace[i] ? 1 : 0)) as [number, number, number, number]),
  );
}
