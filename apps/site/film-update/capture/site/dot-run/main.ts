// Dot Run, the game dot makes in the film: dot rolling along a glowing track above the clouds,
// collecting stars. Scripted, not played: `window.render(seconds, look)` draws any moment of the one run,
// in daylight, at sunset or at night.
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { Dot3D } from "../../../../src/dot3d/dot3d.ts";
import { studioLight } from "../../../../src/dot3d/rig.ts";

export type Look = "day" | "sunset" | "night";

declare global {
  interface Window {
    render(seconds: number, look?: Look): void;
    ready?: boolean;
  }
}

const params = new URLSearchParams(location.search);
if (params.has("desk")) document.body.dataset.desk = "";
const tab = document.getElementById("tab") as HTMLElement;
// Over the footage's own tab label, at the frame's 1920-pixel scale.
const fitTab = () => {
  const k = document.body.clientWidth / 1920;
  Object.assign(tab.style, {
    left: `${178 * k}px`,
    top: `${49 * k}px`,
    width: `${290 * k}px`,
    height: `${34 * k}px`,
    fontSize: `${23 * k}px`,
    paddingLeft: `${12 * k}px`,
    gap: `${12 * k}px`,
  });
};

// A seeded random, so every run of the page builds the same world.
let seed = 7;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NeutralToneMapping;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new Scene();
scene.environment = studioLight(renderer).texture;
scene.environmentIntensity = 0.55;
const HORIZON = new Color("#8a5a8f");
scene.fog = new FogExp2(HORIZON, 0.0075);
const camera = new PerspectiveCamera(55, 1, 0.1, 400);
scene.add(camera);
const key = new DirectionalLight("#fff4ea", 1.1);
key.position.set(2, 3, 2);
camera.add(key);
const ambient = new HemisphereLight("#cfe4ff", "#5b3a6e", 0.7);
scene.add(ambient);

// The sky: deep blue overhead, warm at the horizon.
const sky = new Mesh(
  new SphereGeometry(300, 32, 16),
  new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new Color("#100d30") }, bottom: { value: new Color("#c27a9a") } },
    vertexShader:
      "varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader:
      "uniform vec3 top; uniform vec3 bottom; varying vec3 p; void main(){ float h = clamp(normalize(p).y*1.6+0.35,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }",
  }),
);
scene.add(sky);

// The night's stars, far off in the sky.
const night = new BufferGeometry();
night.setAttribute(
  "position",
  new BufferAttribute(
    new Float32Array(
      Array.from({ length: 900 }, () => {
        const a = random() * Math.PI * 2;
        const y = 0.08 + random() * 0.9;
        const r = Math.sqrt(1 - y * y) * 280;
        return [Math.cos(a) * r, y * 280, Math.sin(a) * r];
      }).flat(),
    ),
    3,
  ),
);
const starfield = new Points(
  night,
  new PointsMaterial({ color: "#ffffff", size: 1.6, sizeAttenuation: false, fog: false }),
);
scene.add(starfield);

// Soft clouds: a procedural puff, many times over, below the track.
function puff(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  for (let i = 0; i < 26; i++) {
    const x = 128 + (random() - 0.5) * 120;
    const y = 140 + (random() - 0.5) * 60;
    const r = 30 + random() * 60;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
const puffs = [puff(), puff(), puff()];

// The track: a gentle ribbon over the clouds.
const points: Vector3[] = [];
for (let i = 0; i < 60; i++)
  points.push(new Vector3(Math.sin(i * 0.55) * 6, Math.sin(i * 0.37) * 1.6, -i * 9));
const path = new CatmullRomCurve3(points);
const LENGTH = path.getLength();
const WIDTH = 2.6;

function ribbon(): BufferGeometry {
  const steps = 1400;
  const position: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const p = path.getPointAt(u);
    const t = path.getTangentAt(u);
    const side = new Vector3().crossVectors(t, up).normalize();
    for (const s of [-1, 1]) {
      const q = p.clone().addScaledVector(side, (s * WIDTH) / 2);
      position.push(q.x, q.y, q.z);
      uv.push(s < 0 ? 0 : 1, (u * LENGTH) / 2);
    }
    if (i < steps) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uv), 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

// Its surface: dark glass with a lit grid, drawn here.
function glass(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#231f4d";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(120,220,255,0.35)";
  g.lineWidth = 2;
  for (const x of [32, 64, 96]) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 128);
    g.stroke();
  }
  g.strokeStyle = "rgba(255,150,220,0.45)";
  g.beginPath();
  g.moveTo(0, 64);
  g.lineTo(128, 64);
  g.stroke();
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = 1000;
  return texture;
}
const track = new Mesh(
  ribbon(),
  new MeshStandardMaterial({
    map: glass(),
    roughness: 0.85,
    metalness: 0,
    emissive: "#1b1640",
    envMapIntensity: 0.25,
  }),
);
scene.add(track);
const edges: { material: MeshBasicMaterial; colour: Color }[] = [];
const lamps: InstancedMesh[] = [];
for (const [offset, colour] of [
  [-WIDTH / 2, "#66e3ff"],
  [WIDTH / 2, "#ff7ad9"],
] as const) {
  const edge = path.getSpacedPoints(600).map((p, i, all) => {
    const t = (all[i + 1] ?? p)
      .clone()
      .sub(all[i - 1] ?? p)
      .normalize();
    const side = new Vector3().crossVectors(t, new Vector3(0, 1, 0)).normalize();
    return p.clone().addScaledVector(side, offset);
  });
  const line = new MeshBasicMaterial({ color: colour });
  edges.push({ material: line, colour: new Color(colour) });
  scene.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(edge), 1200, 0.06, 6), line));
  // Lights along the edge, lit at night.
  const lamp = new InstancedMesh(
    new SphereGeometry(0.09, 10, 8),
    new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(2.2) }),
    150,
  );
  for (let i = 0; i < 150; i++) {
    const at = edge[i * 4] as Vector3;
    lamp.setMatrixAt(i, new Matrix4().makeTranslation(at.x, at.y + 0.12, at.z));
  }
  lamps.push(lamp);
  scene.add(lamp);
}

const clouds = new Group();
for (let i = 0; i < 140; i++) {
  const u = random();
  const p = path.getPointAt(u);
  const sprite = new Sprite(
    new SpriteMaterial({
      map: puffs[i % 3],
      transparent: true,
      depthWrite: false,
    }),
  );
  sprite.userData.hue = random() * 0.12;
  sprite.userData.opacity = 0.4 + random() * 0.25;
  const s = 10 + random() * 16;
  sprite.scale.set(s, s * 0.55, 1);
  // Off to either side and well below, so none passes close to the camera.
  const away = (random() < 0.5 ? -1 : 1) * (9 + random() * 30);
  sprite.position.set(p.x + away, p.y - 7 - random() * 9, p.z + (random() - 0.5) * 20);
  sprite.userData.x = sprite.position.x;
  clouds.add(sprite);
}
scene.add(clouds);

// Stars to collect, along the way.
function starShape(): Shape {
  const shape = new Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.17 : 0.4;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i) shape.lineTo(x, y);
    else shape.moveTo(x, y);
  }
  return shape;
}
const starGeometry = new ExtrudeGeometry(starShape(), {
  depth: 0.12,
  bevelEnabled: true,
  bevelSize: 0.04,
  bevelThickness: 0.04,
  bevelSegments: 2,
});
starGeometry.center();
const SPEED = 9.5;
const EVERY = 0.75;
const LEAD = 2.2;
// The run starts a little way along, so the camera behind dot is on the track too.
const START = 8;
const stars = Array.from({ length: 40 }, (_, i) => {
  const at = LEAD + i * EVERY;
  const u = (START + at * SPEED) / LENGTH;
  const p = path.getPointAt(Math.min(u, 1));
  const t = path.getTangentAt(Math.min(u, 1));
  const side = new Vector3().crossVectors(t, new Vector3(0, 1, 0)).normalize();
  const mesh = new Mesh(
    starGeometry,
    new MeshStandardMaterial({
      color: "#ffd25e",
      emissive: "#ff9d1a",
      emissiveIntensity: 0.9,
      metalness: 0.4,
      roughness: 0.3,
    }),
  );
  const lane = Math.sin(i * 1.7) * 0.6;
  mesh.position
    .copy(p)
    .addScaledVector(side, lane)
    .add(new Vector3(0, 0.95, 0));
  scene.add(mesh);
  return { at, mesh, lane };
});

let clock = 0;
// dot's own clock runs ahead, so its birth animation is over before the run starts.
const dot = new Dot3D({
  seed: 11,
  now: () => (clock + 3) * 1000,
  contactShadow: false,
  control: false,
});
scene.add(dot.group);
const DOT = 0.5;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.45, 0.35, 0.98);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function size(): void {
  const play = document.getElementById("play") as HTMLElement;
  const w = play.clientWidth;
  const h = play.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  camera.aspect = w / h;
  // A tall screen sees the track from further back, so the way ahead still fits.
  camera.fov = w < h ? 68 : 52;
  camera.updateProjectionMatrix();
  fitTab();
}

const score = document.getElementById("stars") as HTMLElement;

// Each look is light, sky and colour over the same world, with the chase camera at its own angle.
interface Style {
  top: string;
  bottom: string;
  fog: string;
  density: number;
  sky: string;
  ground: string;
  ambient: number;
  key: number;
  cloud: [hue: number, saturation: number, lightness: number, opacity: number];
  edge: number;
  bloom: number;
  stars: boolean;
  camera: { up: number; back: number; side: number };
}
const LOOKS: Record<Look, Style> = {
  day: {
    top: "#16479a",
    bottom: "#4a86c6",
    fog: "#5d92c9",
    density: 0.0055,
    sky: "#ffffff",
    ground: "#7f9fc6",
    ambient: 1.1,
    key: 1.3,
    cloud: [0.6, 0.2, 0.84, 0.85],
    edge: 1,
    bloom: 0.2,
    stars: false,
    camera: { up: 3.1, back: 7, side: 0 },
  },
  sunset: {
    top: "#0c0a26",
    bottom: "#5a3550",
    fog: "#4a2f55",
    density: 0.0075,
    sky: "#cfe4ff",
    ground: "#5b3a6e",
    ambient: 0.7,
    key: 1.1,
    cloud: [0.86, 0.3, 0.42, 1],
    edge: 1,
    bloom: 0.45,
    stars: false,
    camera: { up: 2.3, back: 6, side: 0 },
  },
  night: {
    top: "#01020a",
    bottom: "#1b2152",
    fog: "#151a3c",
    density: 0.009,
    sky: "#8fa2ff",
    ground: "#120e26",
    ambient: 0.45,
    key: 0.75,
    cloud: [0.66, 0.35, 0.38, 0.7],
    edge: 1.4,
    bloom: 0.6,
    stars: true,
    camera: { up: 1.6, back: 5, side: 1.1 },
  },
};
let shown: Look | null = null;
function style(look: Look): Style {
  const s = LOOKS[look];
  if (shown === look) return s;
  shown = look;
  const shader = sky.material as ShaderMaterial;
  (shader.uniforms.top as { value: Color }).value.set(s.top);
  (shader.uniforms.bottom as { value: Color }).value.set(s.bottom);
  (scene.fog as FogExp2).color.set(s.fog);
  (scene.fog as FogExp2).density = s.density;
  ambient.color.set(s.sky);
  ambient.groundColor.set(s.ground);
  ambient.intensity = s.ambient;
  key.intensity = s.key;
  for (const cloud of clouds.children) {
    const material = (cloud as Sprite).material;
    const [hue, saturation, lightness, opacity] = s.cloud;
    material.color.setHSL(hue + cloud.userData.hue, saturation, lightness);
    material.opacity = Math.min(1, cloud.userData.opacity * opacity);
  }
  for (const edge of edges) edge.material.color.copy(edge.colour).multiplyScalar(s.edge);
  for (const lamp of lamps) lamp.visible = s.stars;
  starfield.visible = s.stars;
  bloom.strength = s.bloom;
  return s;
}

window.render = (seconds: number, look: Look = "sunset") => {
  clock = seconds;
  const { camera: angle } = style(look);
  const u = Math.min(0.98, (START + seconds * SPEED) / LENGTH);
  const p = path.getPointAt(u);
  const t = path.getTangentAt(u);
  const side = new Vector3().crossVectors(t, new Vector3(0, 1, 0)).normalize();
  // dot weaves gently to meet each star on its lane, bobbing as it rolls.
  const lane = Math.sin(((seconds - LEAD) / EVERY) * Math.PI * 0.5) * 0.35;
  const bob = Math.abs(Math.sin(seconds * Math.PI * 2)) * 0.12;
  dot.group.position
    .copy(p)
    .addScaledVector(side, lane)
    .add(new Vector3(0, DOT + bob, 0));
  dot.group.scale.setScalar(DOT);
  dot.spin = Math.sin(seconds * 1.3) * 0.25;
  // A chase camera a few lengths behind and above, looking down the track ahead.
  const ahead = path.getPointAt(Math.min(0.99, u + 7 / LENGTH));
  const behind = path.getPointAt(Math.max(0, u - angle.back / LENGTH));
  camera.position
    .copy(behind)
    .addScaledVector(side, angle.side)
    .add(new Vector3(0, angle.up, 0));
  camera.lookAt(ahead.clone().add(new Vector3(0, 0.2, 0)));
  dot.group.lookAt(camera.position);
  let collected = 0;
  for (const star of stars) {
    const since = seconds - star.at;
    star.mesh.rotation.y = seconds * 2.4 + star.at;
    if (since < 0) {
      star.mesh.visible = true;
      star.mesh.scale.setScalar(1);
      continue;
    }
    collected++;
    // Picked up: it spins away into nothing.
    const k = Math.min(1, since / 0.25);
    star.mesh.visible = k < 1;
    star.mesh.scale.setScalar(1 - k);
    star.mesh.rotation.y += k * 6;
  }
  score.textContent = String(collected);
  for (const [i, cloud] of clouds.children.entries())
    cloud.position.x = cloud.userData.x + Math.sin(seconds * 0.2 + i) * 0.6;
  const px =
    (renderer.domElement.height / 2 / Math.tan((camera.fov * Math.PI) / 360)) *
    (DOT / camera.position.distanceTo(dot.group.position));
  dot.update(px);
  composer.render();
};

size();
window.addEventListener("resize", size);
document.fonts.ready.then(() => {
  window.render(0);
  window.ready = true;
});
