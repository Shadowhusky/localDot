import { createRoot } from "react-dom/client";
import { HeroApp } from "./hero/HeroApp.tsx";
import { LANG, pickLang, translatePage } from "./i18n.ts";
import { CHAPTERS } from "./story/chapters.ts";
import { PROVIDER_COUNT } from "./story/content.ts";
import { wireControls } from "./story/controls.ts";
import { Director } from "./story/director.ts";
import { wireFilm } from "./story/film.ts";
import { type Place, placeAt, places } from "./story/places.ts";
import "./site.css";

// The page's words in its language before anything else reads them.
translatePage({ n: PROVIDER_COUNT });
const toggle = document.querySelector<HTMLButtonElement>('[data-act="lang"]');
if (toggle && LANG === "zh") toggle.setAttribute("aria-label", "Read in English");
toggle?.addEventListener("click", () => pickLang(LANG === "zh" ? "en" : "zh"));

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const story = document.getElementById("story") as HTMLElement;
const stage = document.getElementById("stage") as HTMLElement;
const hero = document.getElementById("hero") as HTMLElement;
const canvas = document.getElementById("scene") as HTMLCanvasElement;
const director = new Director(CHAPTERS, { reduced });

// The story is as long as its chapters, plus the screen the stage itself fills.
story.style.height = `${(director.screens + 1) * 100}lvh`;
const measure = () => director.measure(story.offsetTop, stage.offsetHeight || innerHeight);
measure();
addEventListener("resize", measure);

// The address names the place the story is at, so a reload, or a link someone shares, opens there;
// the browser does not restore the scroll itself, which would play the story down to it.
history.scrollRestoration = "manual";
const PLACES = places(document, CHAPTERS);
const placeNamed = (name: string) =>
  PLACES.find((p) => p.name === name) ?? PLACES.find((p) => p.chapter === name);
let named: string | null = null;
const markPlace = () => {
  const name = placeAt(PLACES, director.raw)?.name ?? null;
  if (name === named) return;
  named = name;
  const hash = name ? `#${name}` : "";
  history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
};
addEventListener(
  "scroll",
  () => {
    director.scroll(scrollY);
    markPlace();
  },
  { passive: true },
);
// A place opens at once, where its words show whole.
const land = (place: Place) => {
  scrollTo({ top: director.scrollFor(place.at), behavior: "auto" });
  director.scroll(scrollY);
  director.snap();
  markPlace();
};
const opening = placeNamed(decodeURIComponent(location.hash.slice(1)));
if (opening) {
  land(opening);
  // Until the visitor moves, the place holds as the page finishes loading.
  let moved = false;
  for (const event of ["wheel", "touchstart", "keydown", "pointerdown"])
    addEventListener(event, () => (moved = true), { once: true, passive: true });
  addEventListener("load", () => {
    if (!moved && Math.abs(scrollY - director.scrollFor(opening.at)) > 2) land(opening);
  });
} else director.scroll(scrollY);

// A mark at each chapter's start.
const marks = story.querySelector(".marks");
for (const chapter of CHAPTERS) {
  const mark = document.createElement("div");
  mark.className = "mark";
  mark.dataset.chapter = chapter.name;
  mark.dataset.from = String(chapter.from);
  mark.dataset.to = String(chapter.to);
  mark.style.top = `${chapter.from * 100}lvh`;
  marks?.append(mark);
}

// A place close by is scrolled to. One further off is cut to: the stage fades out, the page jumps
// and the story lands there at once, so the whole story never plays past on the way. A chapter's
// name goes to its first place.
const go = (name: string) => {
  const place = placeNamed(name);
  if (!place) return;
  const top = director.scrollFor(place.at);
  if (reduced || Math.abs(top - scrollY) < 1.5 * innerHeight) {
    scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    return;
  }
  const out = stage.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 180,
    easing: "ease-in",
    fill: "forwards",
  });
  out.finished.then(() => {
    land(place);
    stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
    out.cancel();
  });
};
addEventListener("hashchange", () => {
  const name = decodeURIComponent(location.hash.slice(1));
  if (name !== named) go(name);
});

createRoot(hero).render(<HeroApp onGo={go} />);
for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-go]"))
  link.addEventListener("click", (event) => {
    event.preventDefault();
    go(link.dataset.go ?? "");
  });
document.querySelector(".site-nav-brand")?.addEventListener("click", (event) => {
  event.preventDefault();
  scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
});
wireControls(stage);
wireFilm(document.querySelector(".film-sheet") as HTMLDialogElement);

// The 3D layer comes after the app is up; without WebGL the app keeps its own dot.
const supportsGl = (() => {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
})();
// Without WebGL the story reads as plain sections, as it does without JavaScript.
if (!supportsGl) document.documentElement.classList.add("no-gl");
if (supportsGl) {
  requestAnimationFrame(() =>
    import("./scene/world.ts").then(({ World }) => {
      const world = new World(canvas, stage, hero, director, reduced);
      world.onFirstFrame(() => {
        document.documentElement.dataset.gl = "";
      });
      if (import.meta.env.DEV) Object.assign(window, { world });
    }),
  );
}
