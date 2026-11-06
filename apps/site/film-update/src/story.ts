import type { gsap as GsapApi } from "gsap";
import { M } from "./cues.ts";

// GSAP comes with the composition (HyperFrames seeks its timeline); only its types are imported.
declare const gsap: typeof GsapApi;
type Timeline = ReturnType<typeof gsap.timeline>;

// Everything here starts on a beat and settles on one: half a second, soft both ways.
const SOFT = { duration: 0.5, ease: "sine.inOut" };

// A title comes in whole, a soft fade and a small rise, and has gone before anything else is to be read.
function title(tl: Timeline, selector: string, from: number, to: number): void {
  tl.fromTo(selector, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, ...SOFT }, from);
  tl.to(selector, { autoAlpha: 0, ...SOFT }, to - SOFT.duration);
}

export function buildStory(length: number): Timeline {
  const tl = gsap.timeline({ paused: true });

  // Each scene's comes in on the beat its words are needed, as the one before still finishes. The
  // preview's two lines read as one: the second joins below the first as the card opens.
  title(tl, "#w-hello", M.land, M.chat);
  title(tl, "#w-chat", M.chat, M.choice);
  title(tl, "#w-auto", M.choice, M.watch);
  title(tl, "#w-watch", M.watch, M.preview);
  title(tl, "#w-preview", M.preview, M.desk);
  title(tl, "#w-open", M.open, M.desk);
  title(tl, "#w-studio", M.studio, M.several);
  title(tl, "#w-several", M.several, M.away);

  // The end: the name lands beside dot on the last hit, then where to get it, and black.
  tl.set("#end-name", { autoAlpha: 1 }, M.hit);
  tl.fromTo("#end-name", { scale: 1.08 }, { scale: 1, duration: 0.3, ease: "power2.out" }, M.hit);
  tl.fromTo("#end-url", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, ...SOFT }, M.hit + 0.5);
  tl.fromTo("#end-line", { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, ...SOFT }, M.hit + 1);
  tl.fromTo(
    "#fade",
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: 0.5, ease: "sine.inOut" },
    length - 0.5,
  );
  return tl;
}
