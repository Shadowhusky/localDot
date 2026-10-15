import { RING, roles } from "../story/content.ts";
import { COPY, type Copy } from "./copy.ts";
import { CUES } from "./cues.ts";
import { FilmStage, type Layout } from "./stage.ts";
import { buildStory, type Paddle } from "./story.ts";

// The film's 3D layer and its timeline, for the HyperFrames composition in film/index.html, which
// registers the timeline this builds. The runtime seeks it and sends `hf-seek` with each frame's
// time, which the 3D layer draws.
declare global {
  interface Window {
    __hfThreeTime?: number;
    __hyperframes?: { getVariables?: () => Record<string, unknown> };
  }
}

// The film's language, the render's `lang` variable: `--variables '{"lang":"zh"}'`.
const filmLang = (): keyof typeof COPY =>
  window.__hyperframes?.getVariables?.().lang === "zh" ? "zh" : "en";

// A title's chunks, each its own word to come in on the beat. Chinese chunks join without a space
// unless Latin text meets them, and a Chinese comma ending one closes up, as display type sets it.
function title(id: string, { chunks, line }: Copy["hello"]): void {
  const block = document.getElementById(`w-${id}`) as HTMLElement;
  (block.querySelector("h1, h2") as HTMLElement).replaceChildren(
    ...chunks.map((chunk, i) => {
      const word = document.createElement("span");
      word.dataset.word = "";
      const next = chunks[i + 1];
      if (next !== undefined && !/[\w.,!?]$/.test(chunk) && !/^\w/.test(next))
        word.classList.add("joined");
      const close = /[，、]$/.test(chunk);
      word.textContent = close ? chunk.slice(0, -1) : chunk;
      if (close) {
        const mark = document.createElement("span");
        mark.className = "zh-punct";
        mark.textContent = chunk.slice(-1);
        word.append(mark);
      }
      return word;
    }),
  );
  const said = block.querySelector("p[data-line]");
  if (said && line) said.textContent = line;
}

// Every word the film shows, in its language.
function write(lang: keyof typeof COPY): Copy {
  const copy = COPY[lang];
  if (lang === "zh") document.documentElement.lang = "zh-Hans";
  for (const id of [
    "hello",
    "watch",
    "step",
    "models",
    "jobs",
    "rewind",
    "share",
    "yours",
  ] as const)
    title(id, copy[id]);
  (document.getElementById("take") as HTMLElement).textContent = copy.take;
  const saved = document.getElementById("saved") as HTMLElement;
  saved.textContent = copy.saved;
  (document.getElementById("save") as HTMLElement).replaceChildren(copy.save, saved);
  for (const [i, label] of document.querySelectorAll("#cards .card > span").entries())
    label.textContent = copy.cards[i] ?? label.textContent;
  (document.getElementById("end-line") as HTMLElement).textContent = copy.endLine;
  (document.getElementById("end-credit") as HTMLElement).textContent = copy.credit;
  return copy;
}

let stage: FilmStage | null = null;

// A four-pointed twinkle with curved sides.
const SPARKLE =
  "M12 0C12.9 7.2 16.8 11.1 24 12C16.8 12.9 12.9 16.8 12 24C11.1 16.8 7.2 12.9 0 12C7.2 11.1 11.1 7.2 12 0Z";

// The timeline comes back in an object: a GSAP timeline is itself a thenable that settles when it has
// played through, so a promise resolved with it would wait on a paused film for ever.
export async function film(): Promise<{ timeline: unknown }> {
  const layout = (await (await fetch("assets/app/layout.json")).json()) as Layout;
  const paddle = (await (await fetch("assets/paddle.json")).json()) as Paddle;
  const copy = write(filmLang());
  const ring = document.getElementById("ring") as HTMLElement;
  ring.replaceChildren(
    ...RING.map((name) => {
      const item = document.createElement("li");
      item.textContent = copy.ring[name] ?? name;
      return item;
    }),
  );
  const known = roles();
  (document.getElementById("roles") as HTMLElement).replaceChildren(
    ...CUES.outfits.map(({ persona }, i) => {
      const role = known.find((r) => r.id === persona);
      const item = document.createElement("div");
      item.id = `role-${i}`;
      item.className = "role";
      const name = document.createElement("strong");
      name.textContent = copy.roles[persona]?.name ?? role?.name ?? persona;
      const motto = document.createElement("span");
      motto.textContent = `“${copy.roles[persona]?.motto ?? role?.motto ?? ""}”`;
      item.append(name, motto);
      return item;
    }),
  );
  // dot's line under the Theatre, then each demo's name in turn.
  const lines = document.getElementById("lines") as HTMLElement;
  lines.replaceChildren(
    ...[
      copy.line ?? layout.line.text,
      ...(copy.montage ?? CUES.montage.map(({ line }) => line)),
    ].map((text, i) => {
      const item = document.createElement("div");
      item.className = i ? "line name" : "line";
      // dot passes in front of its own line as it docks.
      item.dataset.layoutAllowOcclusion = "";
      if (!i) item.textContent = text;
      // A demo's name comes and goes a word at a time.
      else
        item.append(
          ...text.split(" ").map((word) => {
            const span = document.createElement("span");
            span.textContent = word;
            return span;
          }),
        );
      return item;
    }),
  );
  Object.assign(lines.style, {
    left: `${layout.line.x}px`,
    top: `${layout.line.y + layout.line.h / 2 - 45}px`,
    width: `${layout.line.w}px`,
  });
  (document.getElementById("burst") as HTMLElement).append(
    ...Array.from({ length: 9 }, () => {
      const spark = document.createElement("span");
      spark.className = "spark";
      spark.innerHTML = `<svg viewBox="0 0 24 24"><path d="${SPARKLE}"/></svg>`;
      return spark;
    }),
  );
  const theatre = document.getElementById("theatre") as HTMLElement;
  const { x, y, w, h } = layout.theatre;
  Object.assign(theatre.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
  const app = document.getElementById("app") as HTMLElement;
  Object.assign(app.style, { width: `${layout.size.w}px`, height: `${layout.size.h}px` });
  await document.fonts.ready;
  const next = new FilmStage(
    document.getElementById("stage") as HTMLCanvasElement,
    app,
    ring,
    document.getElementById("studio") as HTMLElement,
    layout,
  );
  await next.ready();
  const timeline = buildStory((px, py, t) => next.appPoint(px, py, t), layout, paddle);
  stage = next;
  stage.renderAt(window.__hfThreeTime ?? 0);
  return { timeline };
}

window.addEventListener("hf-seek", (event) =>
  stage?.renderAt((event as CustomEvent<{ time: number }>).detail.time),
);
