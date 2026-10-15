import { outfit, type PersonaId } from "@localdot/protocol";
import {
  type DirectionalLight,
  type Group,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { Dot3D } from "../dot3d/dot3d.ts";
import { perspectiveTip } from "../dot3d/face.ts";
import { centreRig, studioLight, studioLights } from "../dot3d/rig.ts";
import { loadWardrobe } from "../dot3d/wardrobe.ts";
import { type Point2, quadCss } from "../scene/quad.ts";
import { Ring } from "../scene/ring.ts";
import { WASH } from "../story/content.ts";
import { pinned } from "../story/roles.ts";
import { ease, mix, span } from "../story/tracks.ts";
import { type Block, blockAt } from "./blocking.ts";
import { LINEUP_SCRIPT, SCRIPT } from "./script.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Where the app's pieces are in its captured window, in its own pixels (film/capture.mjs).
export interface Layout {
  size: { w: number; h: number };
  theatre: Rect;
  dock: Rect;
  handBack: Rect | null;
  // dot's line beside the dock, and what it said.
  line: Rect & { text: string };
}

// The film's frame, and the site's camera: 30 degrees, the plane two units tall at its distance.
export const W = 1920;
export const H = 1080;
const FOV = 30;
const TAN = Math.tan((FOV * Math.PI) / 360);
const D = 1 / TAN;
// How far dot stands from the camera when it is not in the app, in world units.
const FREE = 6;
// The app's dock holds a ball 24 units across its 64-unit frame.
const BALL = 24 / 64;
const UP = new Vector3(0, 1, 0);
// The line-up from the left; dot, last in its designer's beret, closes it.
const LINEUP: readonly PersonaId[] = ["everyday", "coder", "research", "finance", "video"];
const SLOTS = [0.175, 0.305, 0.435, 0.565, 0.695];

interface Plane {
  // A point of the app, in its own pixels, in the world.
  at(px: number, py: number): Vector3;
  normal: Vector3;
  // World units per app pixel.
  unit: number;
}

export class FilmStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, W / H, 0.05, 200);
  private readonly dot: Dot3D;
  private readonly rig: Group;
  private readonly lineup: Dot3D[];
  private readonly ring: Ring;
  // The film's clock, in ms, as every dot reads it.
  private ms = 0;
  private done = 0;
  private lineupDone = 0;
  private last = Number.POSITIVE_INFINITY;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly app: HTMLElement,
    ring: HTMLElement,
    private readonly studio: HTMLElement,
    private readonly layout: Layout,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(2);
    this.renderer.setSize(W, H, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.environment = studioLight(this.renderer).texture;
    const now = () => this.ms;
    this.dot = new Dot3D({ seed: 7, now });
    this.scene.add(this.dot.group);
    this.rig = studioLights();
    for (const light of this.rig.children)
      if ("target" in light) (light as DirectionalLight).target = this.dot.group;
    this.camera.add(this.rig);
    this.scene.add(this.camera);
    this.camera.position.set(0, 0, D);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.lineup = LINEUP.map((persona, i) => {
      const dot = new Dot3D({ seed: 11 + i * 7, now, control: false });
      dot.wear(outfit(persona));
      dot.group.visible = false;
      this.scene.add(dot.group);
      return dot;
    });
    this.ring = new Ring(ring, 3);
  }

  // Every model in before the first frame. A film renders frame by frame, so its shaders can compile
  // as they are first needed.
  async ready(): Promise<void> {
    await loadWardrobe();
  }

  // Where the app's pixel shows in the frame now, for what points at it.
  appPoint(px: number, py: number, t: number): Point2 {
    return this.toFrame(this.placeApp(blockAt(t), false).at(px, py));
  }

  renderAt(seconds: number): void {
    const t = Math.max(0, seconds);
    this.drive(t);
    const block = blockAt(t);
    const plane = this.placeApp(block, true);
    const at = this.placeDot(block, plane);
    this.placeLineup(block);
    this.ring.update(
      block.ring.shown,
      block.ring.turn,
      at.position,
      at.radius * block.ring.size,
      this.camera,
      (p) => this.toFrame(p),
      false,
    );
    const wash = block.wash ? (WASH[block.wash] ?? "") : "";
    this.studio.style.setProperty("--wash", wash || "transparent");
    this.studio.style.setProperty("--wash-on", wash ? "1" : "0");
    this.renderer.render(this.scene, this.camera);
  }

  // dot's script up to t; seeking back starts it again from the top.
  private drive(t: number): void {
    if (t < this.last) {
      this.ms = 0;
      this.dot.restart();
      for (const dot of this.lineup) dot.restart();
      this.done = 0;
      this.lineupDone = 0;
    }
    this.last = t;
    for (let input = SCRIPT[this.done]; input && input[0] <= t; input = SCRIPT[++this.done]) {
      this.ms = input[0] * 1000;
      input[1](this.dot);
    }
    for (
      let input = LINEUP_SCRIPT[this.lineupDone];
      input && input[0] <= t;
      input = LINEUP_SCRIPT[++this.lineupDone]
    ) {
      this.ms = input[0] * 1000;
      for (const dot of this.lineup) input[1](dot);
    }
    this.ms = t * 1000;
  }

  // The app's window: beside the words, or its Theatre filling the frame, and as far back as it is.
  private placeApp(block: Block, apply: boolean): Plane {
    const { size, theatre } = this.layout;
    const k = ease.inOut(block.app.focus);
    const scale = (0.8 * H) / theatre.h;
    const focus = {
      cx: W / 2 - (theatre.x + theatre.w / 2 - size.w / 2) * scale,
      cy: H * 0.43 - (theatre.y + theatre.h / 2 - size.h / 2) * scale,
      hp: size.h * scale,
    };
    const cx = mix(block.app.x * W, focus.cx, k);
    const cy = mix(block.app.y * H, focus.cy, k);
    const hp = mix(block.app.h * H, focus.hp, k);
    const yaw = mix(block.app.yaw, 0, k);
    // At the plane's own distance, a world unit is H / 2 pixels.
    const unit = (2 / H) * (hp / size.h);
    const centre = new Vector3((cx - W / 2) * (2 / H), (H / 2 - cy) * (2 / H), -block.app.back);
    const plane: Plane = {
      at: (px, py) =>
        new Vector3((px - size.w / 2) * unit, (size.h / 2 - py) * unit, 0)
          .applyAxisAngle(UP, yaw)
          .add(centre),
      normal: new Vector3(0, 0, 1).applyAxisAngle(UP, yaw),
      unit,
    };
    if (apply) {
      const quad = [
        plane.at(0, 0),
        plane.at(size.w, 0),
        plane.at(size.w, size.h),
        plane.at(0, size.h),
      ].map((p) => this.toFrame(p));
      this.app.style.transform = quadCss(size.w, size.h, quad);
      this.app.style.opacity = block.app.shown.toFixed(3);
      this.app.style.visibility = block.app.shown < 0.005 ? "hidden" : "visible";
      this.app.toggleAttribute("data-yours", block.app.yours);
      this.app.style.setProperty("--focus", k.toFixed(3));
    }
    return plane;
  }

  // dot free at its spot or sitting in the dock, flattened about its foot when it lands.
  private placeDot(block: Block, plane: Plane): { position: Vector3; radius: number } {
    const { dock } = this.layout;
    const free = this.atFrame(block.spot.x * W, block.spot.y * H, FREE);
    const rFree = block.spot.r * H * this.worldPerPx(FREE);
    // Docked, the ball stands just in front of the app on the ray through the dock's centre, so it
    // shows centred in the dock, beside its line, at the dock's size.
    const onPlane = plane.at(dock.x + dock.w / 2, dock.y + dock.h / 2);
    const ray = onPlane.sub(this.camera.position);
    const far = ray.length();
    const atPlane = dock.w * BALL * plane.unit;
    const near = far - atPlane;
    const rDock = (atPlane * near) / far;
    const docked = this.camera.position.clone().add(ray.multiplyScalar(near / far));
    const position = free.lerp(docked, block.docked);
    const radius = mix(rFree, rDock, block.docked);
    this.stand(this.dot, position, radius, block.squash);
    centreRig(this.rig, this.camera, position);
    this.dot.spin = block.spin;
    const worn = outfit(block.persona);
    this.dot.wear(block.pinned ? pinned(worn) : worn);
    this.dot.update(this.pxPerRadius(position, radius));
    return { position, radius };
  }

  private placeLineup(block: Block): void {
    for (const [i, dot] of this.lineup.entries()) {
      const pop = ease.out(span(block.lineup.shown, i * 0.12, i * 0.12 + 0.5));
      dot.group.visible = pop > 0.001;
      if (!dot.group.visible) continue;
      const hop = block.lineup.hops[i] ?? { lift: 0, squash: 0 };
      const position = this.atFrame((SLOTS[i] as number) * W, (0.56 - hop.lift) * H, FREE);
      const radius = 0.065 * H * this.worldPerPx(FREE) * pop;
      this.stand(dot, position, radius, hop.squash);
      dot.update(this.pxPerRadius(position, radius));
    }
  }

  private stand(dot: Dot3D, position: Vector3, radius: number, squash: number): void {
    dot.group.position.copy(position);
    dot.group.position.y -= radius * squash;
    dot.group.scale.set(
      radius * (1 + squash * 0.5),
      radius * (1 - squash),
      radius * (1 + squash * 0.5),
    );
    dot.group.lookAt(this.camera.position);
    dot.tip = perspectiveTip(radius, this.camera.position.distanceTo(position));
  }

  private pxPerRadius(position: Vector3, radius: number): number {
    return (radius / this.worldPerPx(this.camera.position.distanceTo(position))) * 2;
  }

  private toFrame(p: Vector3): Point2 {
    const n = p.clone().project(this.camera);
    return [((n.x + 1) / 2) * W, ((1 - n.y) / 2) * H];
  }

  // The point that shows at frame pixel (x, y), `distance` from the camera.
  private atFrame(x: number, y: number, distance: number): Vector3 {
    const ray = new Vector3((x / W) * 2 - 1, 1 - (y / H) * 2, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position);
    return this.camera.position.clone().add(ray.normalize().multiplyScalar(distance));
  }

  private worldPerPx(distance: number): number {
    return (2 * distance * TAN) / H;
  }
}
