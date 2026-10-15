import type { gsap as GsapApi } from "gsap";
import type { Point2 } from "../scene/quad.ts";
import { BEAT, CUES, M } from "./cues.ts";
import type { Layout } from "./stage.ts";

// How long before its beat a demo starts gliding in (film/index.html starts its clip then too).
const GLIDE = 0.25;

// GSAP comes with the composition (HyperFrames seeks its timeline); only its types are imported.
declare const gsap: typeof GsapApi;
type Timeline = ReturnType<typeof gsap.timeline>;

// Where Breakout's paddle is in each frame of the work clip (film/paddle.py), as fractions of the
// recording's width and height.
export interface Paddle {
  from: number;
  fps: number;
  y: number;
  x: number[];
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector) as HTMLElement;
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

// Words come in on the beat, a word to each eighth note, their line after them, and leave just
// before the next scene's.
function words(tl: Timeline, selector: string, from: number, to: number, lineAt?: number): void {
  const el = $(selector);
  const parts = $$(`${selector} [data-word]`);
  const lines = $$(`${selector} [data-line]`);
  tl.set(el, { autoAlpha: 1 }, from);
  if (parts.length)
    tl.fromTo(
      parts,
      { autoAlpha: 0, y: 46, scale: 1.14, filter: "blur(12px)" },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
        duration: 0.4,
        ease: "back.out(1.7)",
        stagger: BEAT / 2,
      },
      from,
    );
  if (lines.length)
    tl.fromTo(
      lines,
      { autoAlpha: 0, y: 24 },
      { autoAlpha: 1, y: 0, duration: 0.45, ease: "power3.out", stagger: 0.1 },
      lineAt ?? from + parts.length * (BEAT / 2) + 0.05,
    );
  tl.to(el, { autoAlpha: 0, y: -18, duration: 0.25, ease: "power2.in" }, to - 0.25);
  tl.set(el, { y: 0 }, to);
}

// A press: the cursor dips and a ring spreads from its tip.
function press(tl: Timeline, at: number): void {
  tl.to("#cursor", { scale: 0.82, duration: 0.07, ease: "power2.out" }, at - 0.07);
  tl.to("#cursor", { scale: 1, duration: 0.18, ease: "back.out(3)" }, at);
  tl.fromTo(
    "#ripple",
    { autoAlpha: 0.6, scale: 0.2 },
    { autoAlpha: 0, scale: 1.6, duration: 0.45, ease: "power2.out", immediateRender: false },
    at,
  );
}

function centre(el: HTMLElement): Point2 {
  const r = el.getBoundingClientRect();
  const root = $("#root").getBoundingClientRect();
  return [r.left - root.left + r.width / 2, r.top - root.top + r.height / 2];
}

// The cursor's path: where it is at each moment, eased between.
function travel(tl: Timeline, path: readonly [number, Point2][]): void {
  const [first] = path;
  if (!first) return;
  tl.set("#cursor-wrap", { x: first[1][0], y: first[1][1] }, first[0]);
  for (let i = 1; i < path.length; i++) {
    const [from] = path[i - 1] as [number, Point2];
    const [at, [x, y]] = path[i] as [number, Point2];
    tl.to("#cursor-wrap", { x, y, duration: at - from, ease: "power2.inOut" }, from);
  }
}

// An outfit change: a soft flash behind dot as it faces away, and sparkles that twinkle out from it.
function burst(tl: Timeline, at: number): void {
  tl.fromTo(
    "#burst-glow",
    { autoAlpha: 0, scale: 0.6 },
    { autoAlpha: 1, scale: 1, duration: 0.16, ease: "power2.out", immediateRender: false },
    at - 0.08,
  );
  tl.to("#burst-glow", { autoAlpha: 0, scale: 1.3, duration: 0.55, ease: "power2.in" }, at + 0.08);
  const sparks = $$("#burst .spark");
  for (const [i, spark] of sparks.entries()) {
    const angle = ((i + 0.5) / sparks.length) * Math.PI * 2 + at * 1.7;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const reach = 235 + (i % 3) * 50;
    const delay = (i % 4) * 0.035;
    tl.fromTo(
      spark,
      { autoAlpha: 0, x: cos * 150, y: sin * 150, scale: 0, rotation: -40 },
      {
        autoAlpha: 1,
        x: cos * reach,
        y: sin * reach,
        scale: [1, 0.55, 0.8][i % 3],
        rotation: 15,
        duration: 0.34,
        ease: "power3.out",
        immediateRender: false,
      },
      at + delay,
    );
    tl.to(
      spark,
      { autoAlpha: 0, scale: 0, rotation: 70, duration: 0.28, ease: "power2.in" },
      at + delay + 0.34,
    );
  }
}

export function buildStory(
  appPoint: (px: number, py: number, t: number) => Point2,
  layout: Layout,
  paddle: Paddle,
): Timeline {
  const tl = gsap.timeline({ paused: true });
  // Where the buttons are, before their words come in from below.
  const take = centre($("#take"));
  const save = centre($("#save"));

  // Each line comes in as its title lands, so there is time to read it.
  words(tl, "#w-hello", M.hello, M.watch - 0.1, M.own);
  words(tl, "#w-watch", M.watch, M.montage - 0.05, M.watch + 0.45);
  words(tl, "#w-step", M.step, M.models - 0.1, M.step + 0.55);
  words(tl, "#w-models", M.models + 0.3, M.jobs - 0.45, M.models + 0.7);
  words(tl, "#w-jobs", M.jobs, M.rewind);
  words(tl, "#w-rewind", M.replay + 0.1, M.share, M.replay + 0.4);
  words(tl, "#w-share", M.share, M.yours - 0.1, M.share + 0.5);
  words(tl, "#w-yours", M.yours + 0.1, M.end, M.yours + 0.5);

  // The montage: the next demo glides in over the last, which falls back and dims, halfway across on
  // the beat; dot's line under the Theatre names it, word by word, once the last name has gone.
  const [base, ...names] = $$("#lines .line");
  // The names come and go as the titles do: each word rises out of a blur.
  const leave = (line: HTMLElement | undefined, at: number) => {
    if (!line) return;
    tl.to(
      line.children.length ? [...line.children] : [line],
      { autoAlpha: 0, y: -14, filter: "blur(8px)", duration: 0.22, ease: "power2.in" },
      at - 0.26,
    );
  };
  const arrive = (line: HTMLElement | undefined, at: number) => {
    if (!line) return;
    const parts = line.children.length ? [...line.children] : [line];
    tl.set(line, { autoAlpha: 1 }, at);
    // Each word waits unseen for its turn.
    tl.set(parts, { autoAlpha: 0 }, at);
    tl.fromTo(
      parts,
      { autoAlpha: 0, y: 26, scale: 1.12, filter: "blur(12px)" },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
        duration: 0.4,
        ease: "back.out(1.7)",
        stagger: 0.07,
        immediateRender: false,
      },
      at,
    );
  };
  for (const [i, cut] of CUES.montage.entries()) {
    leave(i ? names[i - 1] : base, cut.at);
    arrive(names[i], cut.at);
    if (i === 0) continue;
    tl.fromTo(
      `#v-cut-${i}`,
      { xPercent: 100 },
      { xPercent: 0, duration: 0.5, ease: "power3.inOut", immediateRender: false },
      cut.at - GLIDE,
    );
    tl.fromTo(
      `#v-cut-${i - 1}`,
      { xPercent: 0, scale: 1, filter: "brightness(1)" },
      {
        xPercent: -24,
        scale: 0.94,
        filter: "brightness(0.45)",
        duration: 0.5,
        ease: "power3.inOut",
        immediateRender: false,
      },
      cut.at - GLIDE,
    );
  }
  leave(names.at(-1), M.step);
  arrive(base, M.step);

  // A dot for every job: each one's name and line as it lands, and sparks as it changes.
  for (const [i, { at }] of CUES.outfits.entries()) {
    const until = CUES.outfits[i + 1]?.at ?? M.lineup;
    burst(tl, at);
    tl.fromTo(
      `#role-${i}`,
      { autoAlpha: 0, x: -40 },
      { autoAlpha: 1, x: 0, duration: 0.32, ease: "power3.out" },
      at + 0.05,
    );
    tl.to(`#role-${i}`, { autoAlpha: 0, x: 24, duration: 0.16, ease: "power2.in" }, until - 0.08);
  }

  // Take control, then the visitor plays: the cursor rides the paddle as the recording moves it, and
  // goes up to Hand back.
  const point = (u: number, v: number, at: number) =>
    appPoint(layout.theatre.x + u * layout.theatre.w, layout.theatre.y + v * layout.theatre.h, at);
  const hand = layout.handBack
    ? appPoint(
        layout.handBack.x + layout.handBack.w / 2,
        layout.handBack.y + layout.handBack.h / 2,
        M.handBack,
      )
    : point(0.5, -0.06, M.handBack);
  const paddleAt = (t: number): Point2 => {
    const i = Math.round((t - M.step) * paddle.fps);
    const x = paddle.x[Math.max(0, Math.min(paddle.x.length - 1, i))] ?? 0.5;
    return point(x, paddle.y + 0.045, M.take);
  };
  const ride: [number, Point2][] = [];
  for (let t = M.take + 0.35; t <= M.handBack - 0.45; t += 1 / 15) ride.push([t, paddleAt(t)]);
  const [first] = ride;
  const last = ride.at(-1);
  if (first && last) {
    tl.set("#cursor-wrap", { autoAlpha: 1 }, M.step + 0.3);
    travel(tl, [[M.step + 0.3, [1500, 1180]], [M.take - 0.08, take], [M.take + 0.05, take], first]);
    for (let i = 1; i < ride.length; i++) {
      const [from] = ride[i - 1] as [number, Point2];
      const [at, [x, y]] = ride[i] as [number, Point2];
      tl.to("#cursor-wrap", { x, y, duration: at - from, ease: "none" }, from);
    }
    travel(tl, [
      last,
      [M.handBack - 0.08, hand],
      [M.handBack + 0.05, hand],
      [M.models - 0.2, [1720, 1180]],
    ]);
  }
  for (const at of [M.take, M.handBack]) press(tl, at);
  tl.set("#cursor-wrap", { autoAlpha: 0 }, M.models - 0.2);
  tl.to("#take", { scale: 0.94, duration: 0.07, ease: "power2.out" }, M.take - 0.07);
  tl.to("#take", { scale: 1, duration: 0.2, ease: "back.out(3)" }, M.take);

  // Share the good part, one thing at a time: the title, then Save. Its click sends the clip out of
  // the Theatre as the app behind dims; it lands with the shutter and deals itself into its three
  // looks on the next beats, each lower and further back, so the bottom of every look, where they
  // differ, shows.
  const from = point(0.5, 0.5, M.save);
  tl.fromTo(
    "#app",
    { filter: "brightness(1)" },
    { filter: "brightness(0.38)", duration: 0.45, ease: "power2.out", immediateRender: false },
    M.save,
  );
  const cards = $$("#cards .card");
  const lead = centre(cards[0] as HTMLElement);
  for (const [i, card] of cards.entries()) {
    const [x, y] = centre(card);
    tl.fromTo(
      card,
      { autoAlpha: 0, x: from[0] - x, y: from[1] - y, scale: 0.35 },
      {
        autoAlpha: 1,
        x: lead[0] - x,
        y: lead[1] - y,
        scale: 1,
        duration: M.saved - M.save,
        ease: "power3.out",
      },
      M.save,
    );
    if (i > 0)
      tl.to(card, { x: 0, y: 0, duration: 0.5, ease: "back.out(1.6)" }, M.saved + (i - 1) * BEAT);
    tl.fromTo(
      card.querySelector("span"),
      { autoAlpha: 0, y: 10 },
      { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out" },
      M.saved + i * (BEAT / 2) + (i ? 0.2 : 0),
    );
  }
  // Save: the cursor settles on the button, presses it, stays while it fills to Saved, then fades.
  tl.set("#cursor-wrap", { autoAlpha: 1 }, M.save - 0.75);
  travel(tl, [
    [M.save - 0.75, [1760, 1180]],
    [M.save - 0.15, save],
  ]);
  press(tl, M.save);
  tl.to("#cursor-wrap", { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, M.saved + 0.25);
  tl.set("#saved", { autoAlpha: 1, clipPath: "inset(0% 100% 0% 0%)" }, M.save + 0.05);
  tl.to(
    "#saved",
    { clipPath: "inset(0% 0% 0% 0%)", duration: M.saved - M.save - 0.05, ease: "power2.inOut" },
    M.save + 0.05,
  );
  tl.to("#cards", { autoAlpha: 0, duration: 0.3 }, M.yours - 0.35);

  // The rewind's mark over the picture.
  tl.fromTo(
    "#rewind",
    { autoAlpha: 0, scale: 0.8 },
    { autoAlpha: 1, scale: 1, duration: 0.1 },
    M.rewind,
  );
  tl.to("#rewind", { autoAlpha: 0, duration: 0.12 }, M.replay - 0.05);

  // The end: the name beside dot on the last hit, where to get it, and black.
  tl.fromTo(
    "#end-name",
    { autoAlpha: 0, x: 70, scale: 0.94 },
    { autoAlpha: 1, x: 0, scale: 1, duration: 0.5, ease: "back.out(1.6)" },
    M.hit,
  );
  for (const [i, id] of ["#end-url", "#end-line", "#end-credit"].entries())
    tl.fromTo(
      id,
      { autoAlpha: 0, y: 14 },
      { autoAlpha: 1, y: 0, duration: 0.4, ease: "power3.out" },
      M.hit + 0.4 + i * 0.35,
    );
  tl.fromTo(
    "#fade",
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: 0.6, ease: "power1.in" },
    CUES.length - 0.7,
  );
  return tl;
}
