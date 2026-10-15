import type { Point } from "@app/dot/engine/engine.ts";
import { gazeTo } from "@app/dot/gaze.ts";
import { VOICES } from "@app/dot/voices.ts";
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
import { JUMP, spinFrom, spinJump } from "../dot3d/jump.ts";
import { centreRig, studioLight, studioLights } from "../dot3d/rig.ts";
import { warmWardrobe } from "../dot3d/wardrobe.ts";
import { ZH_LINES } from "../i18n/zh.ts";
import { LANG, talkMs } from "../i18n.ts";
import { heroDot } from "../signals.ts";
import { setSite, site } from "../state.ts";
import { Beats } from "../story/beats.ts";
import { CHAPTERS } from "../story/chapters.ts";
import { ROLE_ORDER, ROLES_FROM, ROLES_TO, WASH } from "../story/content.ts";
import type { ChapterName, Director } from "../story/director.ts";
import { pinned, roleAt } from "../story/roles.ts";
import { shotAt } from "../story/shot-at.ts";
import { type Shot, TALL, WIDE } from "../story/shots.ts";
import { ease, mix, span } from "../story/tracks.ts";
import { Cards } from "./cards.ts";
import { Poke } from "./poke.ts";
import { type Point2, quadCss } from "./quad.ts";
import { Ring } from "./ring.ts";

const FOV = 30;
const TAN = Math.tan((FOV * Math.PI) / 360);
// The camera's distance at which the z = 0 plane fills the stage's height (2 world units).
const D = 1 / TAN;
// A docked dot's ball is three eighths of its slot (the app's 64-unit frame, radius 24).
const BALL = 24 / 64;
interface Pose {
  camera: Vector3;
  target: Vector3;
}

interface Placed {
  pose: Pose;
  dotAt: Vector3;
  radius: number;
  screen: number;
  // Progress out of the app, 0 while the app fills the stage.
  out: number;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const lerp3 = (a: Vector3, b: Vector3, t: number) => a.clone().lerp(b, t);

// The one 3D layer over the page: dot, and the camera that takes the app out into dot's studio.
export class World {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 200);
  private readonly dot: Dot3D;
  private readonly rig: Group;
  private readonly lineup: Dot3D[] = [];
  private w = 1;
  private h = 1;
  // The demo's window on the page, in stage pixels as laid out; the scene moves it by transform.
  private win = { x: 0, y: 0, w: 1, h: 1 };
  // The dock's centre and the ball's radius, in stage pixels, as laid out in the app.
  private dock = { x: 0, y: 0, r: 0 };
  private pointer: Point | null = null;
  private last = performance.now();
  private outWas = 0;
  private pinWas = false;
  private readonly poke: Poke | null;
  private installWas = false;
  private warmed = false;
  // What dot has on, and the spin-jump taking it to the next dot.
  private dressed: PersonaId = "everyday";
  private jump: { start: number; to: PersonaId; from: number } | null = null;
  private heroCss = "";
  private heroShown = "";
  private controlWas: string | null = null;
  private readonly beats: Beats;
  private readonly ring: Ring | null;
  private readonly cards: Cards | null;
  private running = true;
  private firstFrame: (() => void) | null = null;
  private introShown = "";
  private wash = "";
  private readonly intro = document.querySelector<HTMLElement>(".hero-intro");
  private readonly studio = document.querySelector<HTMLElement>(".site-studio");

  constructor(
    canvas: HTMLCanvasElement,
    private readonly stage: HTMLElement,
    private readonly hero: HTMLElement,
    private readonly director: Director,
    private readonly reduced: boolean,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.environment = studioLight(this.renderer).texture;
    this.dot = new Dot3D({ reducedMotion: reduced });
    this.scene.add(this.dot.group);
    // The rig rides with the camera and aims at dot, so dot is lit as in its portraits from
    // wherever it is seen.
    this.rig = studioLights();
    for (const light of this.rig.children)
      if ("target" in light) (light as DirectionalLight).target = this.dot.group;
    this.camera.add(this.rig);
    this.scene.add(this.camera);

    for (const [i, role] of stage.querySelectorAll<HTMLElement>(".role").entries()) {
      const step = (ROLES_TO - ROLES_FROM) / ROLE_ORDER.length;
      role.dataset.span = `${ROLES_FROM + i * step} ${ROLES_FROM + (i + 1) * step}`;
    }
    this.beats = new Beats(stage, director);
    const list = stage.querySelector<HTMLElement>(".ring");
    this.ring = list ? new Ring(list) : null;
    for (const video of stage.querySelectorAll<HTMLVideoElement>(".cards video[data-src]"))
      video.src = video.dataset.src ?? "";
    const cards = stage.querySelector<HTMLElement>(".cards");
    this.cards = cards ? new Cards(cards) : null;
    this.beats.onShow = (text) => {
      if (text) this.dot.say(talkMs(text));
    };
    const press = stage.querySelector<HTMLButtonElement>(".dot-press");
    const line = stage.querySelector<HTMLElement>(".dot-line");
    this.poke = press && line ? new Poke(press, line, () => this.pressed()) : null;

    // The line-up's dots exist from the start, hidden, so meeting them never stalls a frame.
    for (let i = 0; i < ROLE_ORDER.length - 1; i++) {
      const dot = new Dot3D({ seed: 11 + i * 7, reducedMotion: reduced, control: false });
      dot.group.visible = false;
      this.lineup.push(dot);
      this.scene.add(dot.group);
    }
    this.renderer.compile(this.scene, this.camera);
    new ResizeObserver(() => this.resize()).observe(stage);
    // The window itself moves on a phone, rising over the headline for a task the visitor picked,
    // and on a short one the picture comes in under the task list once a task is picked.
    const watch = new ResizeObserver(() => this.measureWindow());
    watch.observe(this.hero);
    const frame = this.hero.querySelector(".stage-frame");
    if (frame) watch.observe(frame);
    window.addEventListener("pointermove", (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
    });
    document.addEventListener("visibilitychange", () => {
      this.running = !document.hidden;
      if (this.running) this.loop();
    });
    this.resize();
    this.loop();
  }

  // Once, after the first frame with dot in it.
  onFirstFrame(callback: () => void): void {
    this.firstFrame = callback;
  }

  private resize(): void {
    const rect = this.stage.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    this.cards?.resize();
    this.measureWindow();
  }

  private measureWindow(): void {
    this.win = {
      x: this.hero.offsetLeft,
      y: this.hero.offsetTop,
      w: this.hero.offsetWidth || this.w,
      h: this.hero.offsetHeight || this.h,
    };
    this.measureDock();
  }

  // The dock's place in the app, measured while the app is untransformed and kept for the rest.
  private measureDock(): void {
    if (this.heroCss !== "" && this.heroCss !== "none") return;
    const slot = this.hero.querySelector<HTMLElement>(".narrator-dock");
    if (!slot) return;
    const box = slot.getBoundingClientRect();
    const origin = this.hero.getBoundingClientRect();
    this.dock = {
      x: box.left - origin.left + box.width / 2,
      y: box.top - origin.top + box.height / 2,
      r: box.width * BALL,
    };
  }

  // A point of the window, in its own pixels, on the z = 0 plane in world units: the window is two
  // units tall there.
  private onPlane(px: number, py: number): Vector3 {
    const k = 2 / this.win.h;
    return v((px - this.win.w / 2) * k, (this.win.h / 2 - py) * k, 0);
  }

  // Where the camera starts: back and across just so far that the plane lies on the window.
  private home(): Pose {
    const k = 2 / this.win.h;
    const x = -(this.win.x + this.win.w / 2 - this.w / 2) * k;
    const y = (this.win.y + this.win.h / 2 - this.h / 2) * k;
    return { camera: v(x, y, (D * this.h) / this.win.h), target: v(x, y, 0) };
  }

  private toStage(p: Vector3): Point2 {
    const n = p.clone().project(this.camera);
    return [((n.x + 1) / 2) * this.w, ((1 - n.y) / 2) * this.h];
  }

  // A point that shows at stage pixel (sx, sy) at `distance` from a camera in `pose`.
  private atScreen(pose: Pose, sx: number, sy: number, distance: number): Vector3 {
    const cam = new PerspectiveCamera(FOV, this.w / this.h, 0.05, 200);
    cam.position.copy(pose.camera);
    cam.lookAt(pose.target);
    cam.updateMatrixWorld();
    const ndc = v((sx / this.w) * 2 - 1, 1 - (sy / this.h) * 2, 0.5).unproject(cam);
    return pose.camera.clone().add(ndc.sub(pose.camera).normalize().multiplyScalar(distance));
  }

  private worldPerPx(distance: number): number {
    return (2 * distance * TAN) / this.h;
  }

  private active(name: ChapterName): boolean {
    const c = this.director.local(name);
    return c > 0 && c < 1;
  }

  private loop = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    if (site.film) return;
    const now = performance.now();
    const dt = Math.min(64, now - this.last);
    this.last = now;
    this.director.update(dt);
    this.compose();
    this.renderer.render(this.scene, this.camera);
    if (this.firstFrame) {
      this.firstFrame();
      this.firstFrame = null;
    }
  };

  private compose(): void {
    const portrait = this.w / this.h < 0.8;
    const placed = this.place(portrait);
    this.camera.position.copy(placed.pose.camera);
    this.camera.lookAt(placed.pose.target);
    this.camera.updateMatrixWorld();
    this.placeHero(placed);
    this.dot.group.position.copy(placed.dotAt);
    centreRig(this.rig, this.camera, placed.dotAt);
    this.dot.group.scale.setScalar(placed.radius);
    this.dot.group.lookAt(this.camera.position);
    this.dot.tip = perspectiveTip(placed.radius, this.camera.position.distanceTo(placed.dotAt));
    const { lift, squash } = this.dress();
    if (lift || squash) {
      const r = placed.radius;
      this.dot.group.position.y += (lift - squash) * r;
      this.dot.group.scale.set(r * (1 + squash / 2), r * (1 - squash), r * (1 + squash / 2));
    }
    this.behave(placed);
    const radiusPx = placed.radius / this.worldPerPx(this.camera.position.distanceTo(placed.dotAt));
    this.dot.update(radiusPx * this.renderer.getPixelRatio());
    // Once the visitor is into the story, every outfit is readied before the dots need one.
    if (!this.warmed && this.director.local("watch") > 0) {
      this.warmed = true;
      void warmWardrobe(this.renderer, this.camera, this.scene);
    }
    const [x, y] = this.toStage(placed.dotAt);
    this.poke?.place(x, y, radiusPx, this.w, placed.out > 0.9);
    this.lineUp(portrait, placed);
    this.beats.update();
    this.extras(portrait);
    this.chrome(placed);
  }

  // The page's words over the window, gone once the app steps back, and the studio's wash of each
  // dot's colour.
  private chrome({ out }: Placed): void {
    const intro = (1 - span(out, 0, 0.3)).toFixed(3);
    if (intro !== this.introShown && this.intro) {
      this.introShown = intro;
      this.intro.style.opacity = intro;
      this.intro.style.visibility = intro === "0.000" ? "hidden" : "";
    }
    const dots = this.director.local("dots");
    const persona = dots > 0 && dots < 0.8 ? roleAt(dots, ROLE_ORDER, ROLES_FROM, ROLES_TO) : null;
    const wash = persona ? (WASH[persona] ?? "") : "";
    if (wash !== this.wash && this.studio) {
      this.wash = wash;
      this.studio.style.setProperty("--wash", wash || "transparent");
      this.studio.style.setProperty("--wash-on", wash ? "1" : "0");
    }
  }

  // The camera, dot and the app's screen for this moment of the story.
  private place(portrait: boolean): Placed {
    const shots = portrait ? TALL : WIDE;
    // With reduced motion the camera does not travel: each chapter is one still shot, cut to.
    const at = this.reduced ? this.stillAt(this.director.at) : this.director.at;
    const first = shots[0] as Shot;
    const range = CHAPTERS.find((c) => c.name === "out");
    const from = range?.from ?? 0;
    const firstAt = from + first.at * ((range?.to ?? 1) - from);
    const short = Math.min(this.w, this.h);
    const out = span(at, from, firstAt);
    if (at > firstAt) {
      const now = shotAt(shots, CHAPTERS, at);
      const pose = { camera: now.camera, target: now.target };
      const distance = now.dot.depth * pose.camera.distanceTo(pose.target);
      return {
        pose,
        dotAt: this.atScreen(pose, this.w * now.dot.x, this.h * now.dot.y, distance),
        radius: now.dot.r * short * this.worldPerPx(distance),
        screen: now.screen,
        out,
      };
    }
    // Out of the app: the camera pulls back from the app's screen while dot leaves its dock, arcs
    // toward the camera and settles where the first shot has it.
    const home = this.home();
    const away: Pose = { camera: v(...first.camera), target: v(...first.target) };
    const travel = ease.inOut(span(out, 0.02, 1));
    // Docked, the ball sits on the app's screen, its centre on the ray through the dock's centre.
    const near = home.camera.z;
    const r0 = this.dock.r * this.worldPerPx(near);
    const docked = home.camera
      .clone()
      .lerp(this.onPlane(this.dock.x, this.dock.y), (near - r0) / near);
    const rDocked = this.dock.r * this.worldPerPx(near - r0);
    const distance = first.dot.depth * away.camera.distanceTo(away.target);
    const settled = this.atScreen(away, this.w * first.dot.x, this.h * first.dot.y, distance);
    const r1 = first.dot.r * short * this.worldPerPx(distance);
    const leave = ease.inOut(span(out, 0.06, 0.92));
    const middle = docked
      .clone()
      .lerp(settled, 0.5)
      .add(v(0, portrait ? 0.5 : 0.7, 0.9));
    const a = docked.clone().lerp(middle, leave);
    const b = middle.clone().lerp(settled, leave);
    return {
      pose: {
        camera: lerp3(home.camera, away.camera, travel),
        target: lerp3(home.target, away.target, travel),
      },
      dotAt: a.lerp(b, leave),
      radius: mix(rDocked, r1, ease.out(leave)),
      screen: 1,
      out,
    };
  }

  // The middle of the chapter the story is in.
  private stillAt(at: number): number {
    const chapter = CHAPTERS.find((c) => at >= c.from && at < c.to) ?? CHAPTERS.at(-1);
    if (!chapter) return at;
    if (chapter.name === "app") return 0;
    return chapter.from + (chapter.to - chapter.from) * 0.6;
  }

  // The app rides the z = 0 plane: its corners, projected, place its window on the page.
  private placeHero({ out, screen }: Placed): void {
    const { x, y, w, h } = this.win;
    const corners: Point2[] = (
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ] as const
    ).map(([px, py]) => {
      const [sx, sy] = this.toStage(this.onPlane(px, py));
      return [sx - x, sy - y] as const;
    });
    const css = quadCss(w, h, corners);
    if (css === "none") this.measureDock();
    if (css !== this.heroCss) {
      this.heroCss = css;
      this.hero.style.transform = css;
      this.hero.toggleAttribute("data-out", css !== "none");
    }
    // Out in the story the app is a picture, except while the visitor has its controls.
    const inert = out > 0.05 && site.control !== "you";
    if (this.hero.inert !== inert) this.hero.inert = inert;
    const shown = screen.toFixed(3);
    if (shown !== this.heroShown) {
      this.heroShown = shown;
      this.hero.style.opacity = shown;
      this.hero.style.visibility = screen < 0.005 ? "hidden" : "";
      if (site.offstage !== screen < 0.005) setSite({ offstage: screen < 0.005 });
    }
  }

  // What dot wears: nothing until the Dots chapter, each dot in turn there, a star pin after it while
  // it talks about open source, and the visitor's accessory whenever one is chosen. On the turntable each dot arrives with a spin-jump, changing outfit facing away;
  // returns how high that has dot and how squashed.
  private dress(): { lift: number; squash: number } {
    const dots = this.director.local("dots");
    const turntable = dots > 0 && dots < 1;
    let persona: PersonaId = "everyday";
    if (turntable) persona = roleAt(dots, ROLE_ORDER, ROLES_FROM, ROLES_TO);
    const now = performance.now();
    if (!turntable || this.reduced) {
      this.jump = null;
      this.dressed = persona;
    } else if (persona !== (this.jump?.to ?? this.dressed)) {
      // A new dot while the last still turns carries on from where that turn has got to.
      this.jump = { start: now, to: persona, from: this.dot.spin };
    }
    let lift = 0;
    let squash = 0;
    this.dot.spin = 0;
    if (this.jump) {
      const j = spinJump((now - this.jump.start) / 1000);
      this.dot.spin = spinFrom(this.jump.from, j.spin) % (Math.PI * 2);
      lift = j.lift;
      squash = j.squash;
      if (j.swapped) this.dressed = this.jump.to;
      if (now - this.jump.start > JUMP * 1000) this.jump = null;
    }
    const pin = this.active("yours");
    if (pin && !this.pinWas) this.dot.hop();
    this.pinWas = pin;
    const worn = outfit(this.dressed, site.accessory);
    this.dot.wear(pin ? pinned(worn) : worn);
    return { lift, squash };
  }

  // Pressed, dot answers with one of its own lines.
  private pressed(): void {
    if (!this.poke) return;
    const text = this.poke.next(
      LANG === "zh" ? ZH_LINES[this.dressed] : VOICES[this.dressed].lines,
    );
    this.dot.react("acknowledged");
    this.dot.say(talkMs(text));
    this.poke.show(text, talkMs(text) + 1800);
  }

  // Where dot looks and how it feels.
  private behave({ out }: Placed): void {
    if (out > 0.05 && this.outWas <= 0.05) this.dot.hop();
    if (out > 0.92 && this.outWas <= 0.92) this.dot.react("acknowledged");
    this.outWas = out;
    const install = this.active("install");
    if (install && !this.installWas) this.dot.react("success");
    this.installWas = install;
    if (out < 0.05) {
      this.dot.setState(heroDot.state);
      this.dot.setControl(heroDot.control);
      this.dot.setFocus(this.heroGaze());
    } else {
      const centre = this.toStage(this.dot.group.position);
      if ((this.active("watch") || this.active("replay")) && site.control !== "you") {
        // It watches its own computer work.
        const monitor = this.toStage(this.onPlane(this.win.w * 0.36, this.win.h * 0.42));
        this.dot.setState("watching");
        this.dot.setFocus(gazeTo(monitor[0] - centre[0], monitor[1] - centre[1]));
      } else {
        this.dot.setState("your-turn");
        if (this.pointer)
          this.dot.pointerAt(gazeTo(this.pointer.x - centre[0], this.pointer.y - centre[1]));
      }
      this.dot.setControl(false);
    }
    if (site.control !== this.controlWas) {
      if (this.controlWas) this.dot.react(site.control === "you" ? "acknowledged" : "live");
      this.controlWas = site.control;
    }
  }

  // The Dots chapter ends with every dot in a row, the visitor's choice of accessory on all of them.
  private lineUp(portrait: boolean, placed: Placed): void {
    const dots = this.director.local("dots");
    const shown = span(dots, ROLES_TO - 0.02, ROLES_TO + 0.06) * (1 - span(dots, 0.94, 0.99));
    if (shown <= 0) {
      for (const dot of this.lineup) dot.group.visible = false;
      return;
    }
    const others = ROLE_ORDER.filter((p) => p !== "everyday");
    const pose = placed.pose;
    const distance = this.camera.position.distanceTo(placed.dotAt);
    const short = Math.min(this.w, this.h);
    others.forEach((persona, i) => {
      const dot = this.lineup[i] as Dot3D;
      // Around dot: on a phone a row above and a row below it, on a wide screen one row.
      const slot = portrait
        ? ([
            { x: 0.2, y: 0.19 },
            { x: 0.8, y: 0.19 },
            { x: 0.2, y: 0.35 },
            { x: 0.5, y: 0.35 },
            { x: 0.8, y: 0.35 },
          ][i] ?? { x: 0.5, y: 0.35 })
        : { x: 0.5 + ((i < 2 ? i : i + 1) - 2.5) * 0.13, y: 0.42 };
      const pop = ease.out(span(shown, i * 0.08, i * 0.08 + 0.5));
      dot.group.visible = pop > 0.001;
      dot.group.position.copy(this.atScreen(pose, this.w * slot.x, this.h * slot.y, distance));
      const radius = (portrait ? 0.1 : 0.07) * short * this.worldPerPx(distance);
      dot.group.scale.setScalar(radius * pop);
      dot.group.lookAt(this.camera.position);
      dot.tip = perspectiveTip(radius, distance);
      dot.wear(outfit(persona, site.accessory));
      dot.setState("your-turn");
      const centre = this.toStage(dot.group.position);
      if (this.pointer)
        dot.pointerAt(gazeTo(this.pointer.x - centre[0], this.pointer.y - centre[1]));
      dot.update((dot.group.scale.x / this.worldPerPx(distance)) * this.renderer.getPixelRatio());
    });
  }

  // The ring of models, the export clips, and the rewind.
  private extras(portrait: boolean): void {
    const models = this.director.local("models");
    this.ring?.update(
      Math.min(span(models, 0.02, 0.16), 1 - span(models, 0.86, 0.98)),
      this.reduced ? 0 : -models * Math.PI * 1.6,
      this.dot.group.position,
      this.dot.group.scale.x,
      this.camera,
      (p) => this.toStage(p),
      portrait,
    );
    // Step in brings dot's game to its screen, from just before its words show to just after.
    const watch = this.director.local("watch");
    const game = watch > 0.36 && watch < 0.72;
    if (game !== site.game) setSite({ game });
    const replay = this.director.local("replay");
    this.cards?.update(span(replay, 0.5, 1), (p) => this.toStage(p), portrait);
    // The first beat of Replay winds the recording back as the visitor scrolls.
    const rewind = replay > 0.06 && replay < 0.5 ? 1 - ease.inOut(span(replay, 0.08, 0.46)) : null;
    if (
      rewind === null
        ? site.rewind !== null
        : site.rewind === null || Math.abs(rewind - site.rewind) > 0.002
    )
      setSite({ rewind });
  }

  // From the docked dot to the work on the Theatre, as the app's eyes would turn.
  private heroGaze(): Point | null {
    const focus = heroDot.focus;
    const stage = this.hero.querySelector<HTMLElement>(".stage-box");
    if (!focus || !stage) return null;
    const box = stage.getBoundingClientRect();
    const origin = this.hero.getBoundingClientRect();
    const x = box.left - origin.left + box.width * focus.x;
    const y = box.top - origin.top + box.height * focus.y;
    return gazeTo(x - this.dock.x, y - this.dock.y);
  }
}
