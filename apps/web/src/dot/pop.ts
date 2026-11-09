import { seedDraw, type Wearable } from "@localdot/protocol";
import { afterMotion } from "../ui/finished.ts";
import { crown } from "./render/wearables.ts";

// A deleted conversation's dot goes as a soap bubble does: it shuts its eyes, squashes on its foot,
// stretches up and bursts into a few glossy drops, and a hat left behind hangs in the air before it
// drops. All of it is transform and opacity on a copy of the dot, above the page, so the compositor
// keeps it running through the commit that takes the row away.
const EYES_SHUT = 60;
const BALL_MS = 190;
export const BURST_AT = 145;
const AFTER_BURST = 325;
// When a row may start to close: the ball has gone, and the drops are on their way.
export const CLOSES_AT = 200;
export const POP_MS = BURST_AT + AFTER_BURST;

// A ripple across several, quick enough that the last still ends within a second of the first.
const RIPPLE_GAP = 55;
const RIPPLE_MOST = 420;
// Past this many on show the rest of them only fade. No screen shows more rows than this at once
// but a tall one, where it keeps a long ripple's cost down.
export const MOST_POPS = 20;
const MOST_DROPS = 48;

export function rippleDelays(n: number): number[] {
  const gap = n > 1 ? Math.min(RIPPLE_GAP, RIPPLE_MOST / (n - 1)) : 0;
  return Array.from({ length: n }, (_, index) => Math.round(index * gap));
}

// Eight for one alone; fewer each across a ripple, so the whole stays light.
export const dropsFor = (n: number) => Math.max(3, Math.min(8, Math.floor(MOST_DROPS / n)));

// Past where the ball was, from its middle, as a share of its frame: 37.5% is its foot.
const ball = (rise: number, x: number, y: number) => `translateY(${rise}%) scale(${x}, ${y})`;

export const BALL_FRAMES: Keyframe[] = [
  { offset: 0, transform: ball(0, 1, 1), opacity: 1, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
  {
    offset: 0.47,
    transform: ball(7.5, 1.16, 0.8),
    opacity: 1,
    easing: "cubic-bezier(0.6, 0, 0.9, 0.4)",
  },
  { offset: BURST_AT / BALL_MS, transform: ball(-7, 0.9, 1.19), opacity: 1, easing: "ease-out" },
  { offset: 1, transform: ball(-4, 1.42, 1.42), opacity: 0 },
];

export interface Drop {
  // CSS px across.
  size: number;
  spark: boolean;
  frames: Keyframe[];
}

const ARC = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

// Where each drop goes from the middle of a dot `size` px across: out, slowed by the air, while it
// falls a little and shrinks. Each conversation bursts its own way, and the same way every time.
export function burstDrops(seed: string, size: number, count: number): Drop[] {
  return Array.from({ length: count }, (_, index) => {
    const draw = (what: string) => seedDraw(seed, `pop ${index} ${what}`);
    const angle = ((index + draw("angle") * 0.7) / count) * 2 * Math.PI - Math.PI / 2;
    const reach = size * (0.55 + 0.6 * draw("reach"));
    const fall = size * (0.28 + 0.22 * draw("fall"));
    const spark = count >= 4 && index % 4 === 1;
    const across = Math.max(3, Math.round(size * (spark ? 0.2 : 0.09 + 0.09 * draw("size"))));
    const spin = spark ? (draw("spin") - 0.5) * 240 : 0;
    return {
      size: across,
      spark,
      frames: ARC.map((t) => {
        const out = 1 - (1 - t) ** 2.4;
        const x = Math.cos(angle) * reach * out;
        const y = Math.sin(angle) * reach * out + fall * t * t;
        const scale = spark ? Math.sin(Math.PI * Math.min(1, t + 0.25)) + 0.1 : 1 - 0.5 * t;
        return {
          offset: t,
          transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(spin * t).toFixed(1)}deg) scale(${scale.toFixed(2)})`,
          opacity: t < 0.6 ? 1 : (1 - t) / 0.4,
        };
      }),
    };
  });
}

// What dot wears keeps to the ball until the burst. Then what sits above the head is tossed up,
// hangs and drops as it fades; the rest, with nothing to hold it, falls.
export function wornFrames(seed: string, name: Wearable, size: number): Keyframe[] {
  const draw = (what: string) => seedDraw(seed, `pop ${name} ${what}`);
  const side = draw("side") < 0.5 ? -1 : 1;
  const place = (x: number, y: number, turn: number, sx = 1, sy = 1) =>
    `translate(${(x * size).toFixed(1)}px, ${(y * size).toFixed(1)}px) rotate(${turn.toFixed(1)}deg) scale(${sx}, ${sy})`;
  const riding: Keyframe[] = [
    { offset: 0, transform: place(0, 0, 0), opacity: 1, easing: "cubic-bezier(0.2, 0.8, 0.3, 1)" },
    {
      offset: (0.47 * BALL_MS) / POP_MS,
      transform: place(0, 0.075, 0, 1.16, 0.8),
      opacity: 1,
      easing: "cubic-bezier(0.6, 0, 0.9, 0.4)",
    },
  ];
  const free = BURST_AT / POP_MS;
  const span = 1 - free;
  const drift = side * (0.06 + 0.1 * draw("drift"));
  const turn = side * (10 + 16 * draw("turn"));
  if (crown([name]) > 0)
    return [
      ...riding,
      {
        offset: free,
        transform: place(0, -0.07, 0, 0.9, 1.19),
        opacity: 1,
        easing: "cubic-bezier(0.15, 0.7, 0.3, 1)",
      },
      {
        offset: free + span * 0.46,
        transform: place(drift, -0.62 - 0.14 * draw("toss"), turn * 0.6),
        opacity: 1,
        easing: "cubic-bezier(0.5, 0, 0.9, 0.6)",
      },
      { offset: free + span * 0.68, transform: place(drift * 1.3, -0.56, turn * 0.8), opacity: 1 },
      { offset: 1, transform: place(drift * 1.8, -0.12, turn * 1.3), opacity: 0 },
    ];
  return [
    ...riding,
    {
      offset: free,
      transform: place(0, -0.07, 0, 0.9, 1.19),
      opacity: 1,
      easing: "cubic-bezier(0.5, 0, 0.9, 0.5)",
    },
    { offset: free + span * 0.7, transform: place(drift, 0.42, turn), opacity: 0 },
    { offset: 1, transform: place(drift, 0.42, turn), opacity: 0 },
  ];
}

function part(className: string, parent: HTMLElement): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  parent.append(element);
  return element;
}

export interface PoppingDot {
  // The dot on the page: its plates and eyes are copied, never drawn again.
  avatar: HTMLElement;
  seed: string;
  delay: number;
}

// Plays each dot's burst in one layer over the page, taken away when the last is done. `under` is an
// open layer that must stay on top of it. Reads where they all are before writing anything.
export function popDots(dots: readonly PoppingDot[], under: Element | null = null): void {
  if (dots.length === 0) return;
  const boxes = dots.map(({ avatar }) => avatar.getBoundingClientRect());
  const layer = document.createElement("div");
  layer.className = "dot-pop-layer";
  layer.setAttribute("aria-hidden", "true");
  const drops = dropsFor(dots.length);
  const plays = dots.map(({ avatar, seed, delay }, index) => {
    const box = boxes[index] as DOMRect;
    const size = box.width;
    const root = part("dot-pop", layer);
    root.style.left = `${box.left}px`;
    root.style.top = `${box.top}px`;
    root.style.width = `${size}px`;
    root.style.height = `${size}px`;
    const body = part("dot-pop-ball", root);
    const copy = avatar.cloneNode(true) as HTMLElement;
    body.append(copy);
    const worn = [...copy.querySelectorAll<HTMLElement>(".dot-wear")].map((plate) => {
      const carrier = part("dot-pop-worn", root);
      carrier.append(plate);
      return { carrier, name: plate.dataset.wear as Wearable };
    });
    const ring = part("dot-pop-ring", root);
    const bits = burstDrops(seed, size, drops).map((drop) => {
      const bit = part("dot-pop-bit", root);
      if (drop.spark) bit.dataset.spark = "";
      bit.style.width = `${drop.size}px`;
      bit.style.height = `${drop.size}px`;
      bit.style.margin = `${-drop.size / 2}px`;
      return { bit, frames: drop.frames };
    });
    return () => {
      body.animate(BALL_FRAMES, { duration: BALL_MS, delay, fill: "forwards" });
      copy
        .querySelector(".dot-face")
        ?.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0.12)" }], {
          duration: EYES_SHUT,
          delay,
          easing: "ease-in",
          fill: "forwards",
        });
      for (const { carrier, name } of worn)
        carrier.animate(wornFrames(seed, name, size), {
          duration: POP_MS,
          delay,
          fill: "forwards",
        });
      ring.animate(
        [
          { transform: "scale(0.5)", opacity: 0.6 },
          { transform: "scale(1.5)", opacity: 0 },
        ],
        { duration: 200, delay: delay + BURST_AT, easing: "ease-out", fill: "both" },
      );
      for (const { bit, frames } of bits)
        bit.animate(frames, { duration: AFTER_BURST, delay: delay + BURST_AT, fill: "both" });
    };
  });
  document.body.insertBefore(layer, under);
  for (const play of plays) play();
  afterMotion([layer], () => layer.remove());
}
