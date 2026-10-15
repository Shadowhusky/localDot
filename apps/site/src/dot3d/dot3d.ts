import { DotEngine, type Point } from "@app/dot/engine/engine.ts";
import { R } from "@app/dot/engine/sphere.ts";
import type { DotState, Reaction } from "@app/dot/engine/states.ts";
import { eyeGeometry } from "@app/dot/render/eye-geometry.ts";
import { LOD_DETAIL } from "@app/dot/render/lod.ts";
import type { Wearable } from "@localdot/protocol";
import {
  CanvasTexture,
  DirectionalLight,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  SphereGeometry,
} from "three";
import { type BodyUniforms, bodyMaterial, SHADES, setEyes, setShades } from "./body.ts";
import { eyeUniforms, faceQuaternion, tippedFace } from "./face.ts";
import { XENON_COLOUR, XENON_LIGHTS } from "./rig.ts";
import { loadedShadow, loadedWearable, ON_FACE, wearable, wearableShadow } from "./wardrobe.ts";

// Every dot shares its ball and its shadow.
let sphere: SphereGeometry | null = null;
let shadowMap: CanvasTexture | null = null;

// A soft contact shadow, drawn once.
function shadowTexture(): CanvasTexture {
  if (shadowMap) return shadowMap;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(0.45, "rgba(0,0,0,0.28)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  shadowMap = new CanvasTexture(canvas);
  return shadowMap;
}

// dot in three dimensions: the app's DotEngine moves it, and the body's shader paints the face the
// app's eye geometry describes. The group's origin is the body's centre; its radius is 1.
export class Dot3D {
  readonly group = new Group();
  // The engine's hop, squash and lean, about the body's bottom.
  private readonly bob = new Group();
  // The body and what it wears, about its centre; turns with the face's roll.
  readonly head = new Group();
  // Glasses and the like, which turn with the face as the eyes do.
  readonly face = new Group();
  private readonly uniforms: BodyUniforms;
  private engine: DotEngine;
  private readonly now: () => number;
  private readonly options: { seed: number; state: DotState; reducedMotion: boolean };
  private readonly shadow: Mesh;
  private readonly xenon: DirectionalLight[];
  private readonly faceMatrix = new Matrix3();
  private readonly worn = new Map<Wearable, Object3D>();
  private wearing: readonly Wearable[] = [];
  private readonly m4 = new Matrix4();
  // How far the head's top tips toward the camera, in radians (face.ts perspectiveTip).
  tip = 0;
  // A turntable's turn about the head's own tipped axis, in radians.
  spin = 0;

  // `control: false` for a dot that never has its computer, so it brings no xenon lights: every
  // light in the scene is part of every material's shader, and changing the count recompiles them.
  // `now` is its clock in ms, the page's by default.
  constructor(
    options: {
      seed?: number;
      state?: DotState;
      reducedMotion?: boolean;
      control?: boolean;
      now?: () => number;
    } = {},
  ) {
    const { material, uniforms } = bodyMaterial();
    this.uniforms = uniforms;
    sphere ??= new SphereGeometry(1, 96, 64);
    const body = new Mesh(sphere, material);
    this.head.add(body, this.face);
    this.head.position.y = 1;
    this.bob.position.y = -1;
    this.bob.add(this.head);
    this.shadow = new Mesh(
      new PlaneGeometry(2.4, 2.4),
      new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = -1.02;
    this.shadow.renderOrder = -1;
    this.xenon = (options.control === false ? [] : XENON_LIGHTS).map(({ at }) => {
      const light = new DirectionalLight(XENON_COLOUR, 0);
      light.position.set(at[0], at[1], at[2]);
      light.target = this.head;
      return light;
    });
    this.group.add(this.bob, this.shadow, ...this.xenon);
    this.now = options.now ?? (() => performance.now());
    this.options = {
      seed: options.seed ?? 7,
      state: options.state ?? "idle",
      reducedMotion: options.reducedMotion ?? false,
    };
    this.engine = this.start();
  }

  private start(): DotEngine {
    return new DotEngine({ ...this.options, t: this.now(), lod: "hero" });
  }

  // Begins again at the clock's time, as fresh as when made: a film seeking back replays its cues.
  restart(): void {
    this.engine = this.start();
  }

  setState(state: DotState): void {
    this.engine.setState(state, this.now());
  }

  react(reaction: Reaction): void {
    this.engine.react(reaction, this.now());
  }

  setControl(on: boolean): void {
    this.engine.setControl(on, this.now());
  }

  // Where its work is, in gaze units (apps/web/src/dot/gaze.ts gazeTo).
  setFocus(point: Point | null): void {
    this.engine.setFocus(point, this.now());
  }

  pointerAt(point: Point): void {
    this.engine.pointerAt(point.x, point.y, this.now());
  }

  say(ms: number): void {
    this.engine.say(this.now(), ms);
  }

  hop(): void {
    this.engine.hop(this.now());
  }

  // Puts on what the list names and takes off the rest; models load once and are shared. What has
  // already loaded goes on at once.
  wear(list: readonly Wearable[]): void {
    if (list.length === this.wearing.length && list.every((w, i) => w === this.wearing[i])) return;
    this.wearing = [...list];
    for (const [name, item] of this.worn) {
      if (list.includes(name)) continue;
      item.removeFromParent();
      this.worn.delete(name);
    }
    const putOn = (name: Wearable, item: Object3D | null) => {
      if (!item || !this.wearing.includes(name) || this.worn.has(name)) return;
      (ON_FACE.has(name) ? this.face : this.head).add(item);
      this.worn.set(name, item);
    };
    for (const name of list) {
      if (this.worn.has(name)) continue;
      const item = loadedWearable(name);
      if (item) putOn(name, item);
      else void wearable(name).then((loaded) => putOn(name, loaded));
    }
    const wanted = this.wearing;
    const casters = wanted.slice(0, SHADES);
    const onFace = casters.map((name) => ON_FACE.has(name));
    const shades = casters.map(loadedShadow);
    if (shades.every((shade) => shade)) setShades(this.uniforms, shades, onFace);
    else
      void Promise.all(casters.map(wearableShadow)).then((loaded) => {
        if (wanted === this.wearing) setShades(this.uniforms, loaded, onFace);
      });
  }

  // `pxPerRadius`: device pixels from the body's centre to its edge on screen, for crisp eye edges.
  update(pxPerRadius: number): void {
    const p = this.engine.pose(this.now());
    this.bob.position.set(p.body.x / R, -1 - p.body.y / R, 0);
    this.bob.scale.set(p.body.sx, p.body.sy, p.body.sx);
    this.head.rotation.set(this.tip, this.spin, (-p.roll * Math.PI) / 180);
    const turn = tippedFace(faceQuaternion(p.gaze.x, p.gaze.y, 0), this.tip);
    this.face.quaternion.copy(turn);
    this.faceMatrix.setFromMatrix4(this.m4.makeRotationFromQuaternion(turn.invert()));
    this.uniforms.uFace.value.copy(this.faceMatrix);
    const devPerUnit = Math.max(0.5, pxPerRadius / R);
    this.uniforms.uUnitsPerPx.value = 1 / devPerUnit;
    setEyes(this.uniforms, [
      eyeUniforms(eyeGeometry(p.eyes[0], LOD_DETAIL.hero, devPerUnit)),
      eyeUniforms(eyeGeometry(p.eyes[1], LOD_DETAIL.hero, devPerUnit)),
    ]);
    this.uniforms.uDim.value = p.plate.dim;
    const rim = p.plate.rim * (1 - p.plate.dim);
    XENON_LIGHTS.forEach(({ power }, i) => {
      const light = this.xenon[i];
      if (light) light.intensity = (rim * power) / 400;
    });
    this.shadow.position.x = p.shadow.x / R;
    this.shadow.scale.setScalar(p.shadow.s * p.body.sx);
    (this.shadow.material as MeshBasicMaterial).opacity = p.shadow.o;
  }
}
