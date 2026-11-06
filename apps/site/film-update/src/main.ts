import { WIDE } from "./camera.ts";
import { TALL } from "./camera-tall.ts";
import { COPY, type Title } from "./copy.ts";
import { CUES } from "./cues.ts";
import type { Layout, Takes, Touch } from "./layout.ts";
import { UpdateStage } from "./stage.ts";
import { buildStory } from "./story.ts";

// The film's 3D layer and its timeline, for the HyperFrames composition in index.html, which registers
// the timeline this builds. The runtime seeks it and sends `hf-seek` with each frame's time, which the
// 3D layer and the screens' places draw.
declare global {
  interface Window {
    __hfThreeTime?: number;
    __hyperframes?: { getVariables?: () => Record<string, unknown> };
  }
}

// The windows of the several-at-once scene after Studio's, in the order they arrive, as the takes are named.
const WORKERS = [
  "landlord",
  "invoice",
  "flights",
  "photos",
  "sheet",
  "dinner",
  "plumber",
  "downloads",
];

// The 9:16 cut, in its own page; Chinese only.
const isTall = () => document.documentElement.dataset.format === "tall";
// The film's language, the render's `lang` variable: `--variables '{"lang":"zh"}'`.
const filmLang = (): keyof typeof COPY =>
  window.__hyperframes?.getVariables?.().lang === "zh" || isTall() ? "zh" : "en";

// A title's phrases. Chinese ones join without a space unless Latin text meets them.
function title(id: string, { chunks }: Title): void {
  const block = document.getElementById(`w-${id}`) as HTMLElement;
  (block.querySelector("h1, h2") as HTMLElement).replaceChildren(
    ...chunks.map((chunk, i) => {
      const part = document.createElement("span");
      part.dataset.word = "";
      const next = chunks[i + 1];
      if (next !== undefined && !/[\w.,!?]$/.test(chunk) && !/^\w/.test(next))
        part.classList.add("joined");
      part.textContent = chunk;
      return part;
    }),
  );
}

function write(lang: keyof typeof COPY): void {
  const copy = COPY[lang];
  if (lang === "zh") document.documentElement.lang = "zh-Hans";
  for (const id of [
    "hello",
    "chat",
    "auto",
    "watch",
    "preview",
    "open",
    "studio",
    "several",
  ] as const)
    title(id, copy[id]);
  (document.getElementById("end-line") as HTMLElement).textContent = copy.endLine;
}

let stage: UpdateStage | null = null;

// A four-pointed twinkle with curved sides.
const SPARKLE =
  "M12 0C12.9 7.2 16.8 11.1 24 12C16.8 12.9 12.9 16.8 12 24C11.1 16.8 7.2 12.9 0 12C7.2 11.1 11.1 7.2 12 0Z";

const json = async <T>(path: string) => (await (await fetch(path)).json()) as T;
const el = (id: string) => document.getElementById(id) as HTMLElement;

// The timeline comes back in an object: a GSAP timeline is itself a thenable that settles when it has
// played through, so a promise resolved with it would wait on a paused film for ever.
export async function film(): Promise<{ timeline: unknown }> {
  const tag = isTall() ? "-tall" : "";
  const touches = Object.values(
    await json<Record<string, Touch[]>>(`assets/capture/phone-touches${tag}.json`),
  ).flat();
  const takes = await json<Takes>(`assets/capture/phone-rects${tag}.json`);
  write(filmLang());
  const layout: Layout = isTall() ? TALL : WIDE;
  const spark = () => {
    const made = document.createElement("span");
    made.className = "spark";
    made.innerHTML = `<svg viewBox="0 0 24 24"><path d="${SPARKLE}"/></svg>`;
    el("sparks").append(made);
    return made;
  };
  await document.fonts.ready;
  const next = new UpdateStage(
    el("stage") as HTMLCanvasElement,
    {
      canvas: el("stage") as HTMLCanvasElement,
      world: el("world"),
      chat: el("chat"),
      windows: [el("room"), ...WORKERS.map((name) => el(`win-${name}`))],
      touch: el("touch"),
      ask: el("s-ask"),
      held: el("s-held"),
      heldStage: el("s-held-stage"),
      card: el("s-card"),
      tab: el("s-tab"),
      grow: el("grow"),
      shrink: el("shrink"),
      spot: document.getElementById("spot") as unknown as SVGSVGElement,
      spark,
    },
    touches,
    takes,
    layout,
  );
  await next.ready();
  const timeline = buildStory(CUES.length);
  stage = next;
  stage.renderAt(window.__hfThreeTime ?? 0);
  return { timeline };
}

window.addEventListener("hf-seek", (event) =>
  stage?.renderAt((event as CustomEvent<{ time: number }>).detail.time),
);
