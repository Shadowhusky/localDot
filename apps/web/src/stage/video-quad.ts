import { Mesh, MeshGeometry, Shader, Texture, type TextureSource } from "pixi.js";

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

// A plain bilinear read skips texels once a canvas pixel covers more than one, and small type falls
// apart. Reads spread evenly over the pixel's footprint weigh them all, without the cost of a mip
// chain for every frame; a smaller picture has fewer canvas pixels, so it can afford more reads.
// Near one to one the reads draw together, as a single bilinear read is sharpest there.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTexture;
uniform vec4 uColor;
void main() {
  vec2 footprint = fwidth(vUV);
  float texels = footprint.x * float(textureSize(uTexture, 0).x);
  vec4 color;
  if (texels <= 1.0) {
    color = texture(uTexture, vUV);
  } else if (texels <= 2.5) {
    vec2 d = footprint * 0.25 * min(texels - 1.0, 1.0);
    color = 0.25 * (texture(uTexture, vUV + vec2(-d.x, -d.y)) + texture(uTexture, vUV + vec2(d.x, -d.y))
      + texture(uTexture, vUV + vec2(-d.x, d.y)) + texture(uTexture, vUV + vec2(d.x, d.y)));
  } else {
    vec2 d = footprint / 3.0;
    color = vec4(0.0);
    for (float y = -1.0; y <= 1.0; y += 1.0)
      for (float x = -1.0; x <= 1.0; x += 1.0) color += texture(uTexture, vUV + vec2(x, y) * d);
    color /= 9.0;
  }
  outColor = color * uColor;
}`;

export interface QuadHole {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The picture as triangles, or only the top and sides of it around a hole reaching its bottom.
export function quadMesh(width: number, height: number, hole: QuadHole | null) {
  const rects: [number, number, number, number][] = hole
    ? [
        [0, 0, width, hole.y],
        [0, hole.y, hole.x, height],
        [hole.x + hole.w, hole.y, width, height],
      ]
    : [[0, 0, width, height]];
  return {
    positions: new Float32Array(
      rects.flatMap(([left, top, right, bottom]) => [
        left,
        top,
        right,
        top,
        right,
        bottom,
        left,
        bottom,
      ]),
    ),
    uvs: new Float32Array(
      rects.flatMap(([left, top, right, bottom]) => [
        left / width,
        top / height,
        right / width,
        top / height,
        right / width,
        bottom / height,
        left / width,
        bottom / height,
      ]),
    ),
    indices: new Uint32Array(
      rects.flatMap((_, n) => [4 * n, 4 * n + 1, 4 * n + 2, 4 * n, 4 * n + 2, 4 * n + 3]),
    ),
  };
}

// The decoded frame's quad, in frame pixels, for WebGL 2. It draws under the same camera a Sprite
// would, and a picture has no see-through pixels to blend.
export class VideoQuad extends Mesh<MeshGeometry, Shader> {
  #size = { w: 1, h: 1 };
  #hole: QuadHole | null = null;

  constructor() {
    const shader = Shader.from({
      gl: { vertex: VERTEX, fragment: FRAGMENT, name: "video-quad" },
      resources: { uTexture: Texture.EMPTY.source, uSampler: Texture.EMPTY.source.style },
    });
    super({
      geometry: new MeshGeometry({
        positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      }),
      shader,
    });
    this.state.blend = false;
  }

  show(source: TextureSource, width: number, height: number): void {
    const { shader, geometry } = this;
    if (!shader) return;
    shader.resources.uTexture = source;
    shader.resources.uSampler = source.style;
    this.#size = { w: width, h: height };
    geometry.positions = quadMesh(width, height, this.#hole).positions;
    if (this.#hole) this.around(this.#hole);
  }

  // What a window opaque above it covers isn't drawn: each pixel here costs up to nine texture reads.
  around(hole: QuadHole | null): void {
    const { geometry } = this;
    this.#hole = hole;
    const mesh = quadMesh(this.#size.w, this.#size.h, hole);
    geometry.positions = mesh.positions;
    geometry.uvs = mesh.uvs;
    geometry.indices = mesh.indices;
  }
}
