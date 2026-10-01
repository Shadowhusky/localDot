import { AvatarController } from "@localdot/avatar";
import { SpineRenderer } from "@localdot/avatar-spine";
import { CLIPS, type ClipName } from "./clips.ts";
import { loadPack } from "./packs.ts";

const FPS = 30;
const query = new URLSearchParams(location.search);
const clip = CLIPS[(query.get("clip") as ClipName) ?? "blink"] ?? CLIPS.blink;
const el = document.getElementById("avatar") as HTMLElement;
const renderer = new SpineRenderer(
  await loadPack(query.get("pack") === "dev" ? "dev" : "toy", true),
);
await renderer.mount(el);

let now = 0;
// Clips aim attention relative to the head, so the head sits at the origin.
const controller = new AvatarController(
  { seed: clip.seed, headCenter: { x: 0, y: 0 }, reach: 700 },
  () => now,
);
const frames: string[] = [];
const pending = [...clip.steps];
for (let frame = 0; (frame * 1000) / FPS < clip.durationMs; frame++) {
  now = (frame * 1000) / FPS;
  while (pending[0] && pending[0].atMs <= now) pending.shift()?.act(controller, now);
  renderer.apply(controller.frame(), 1000 / FPS);
  renderer.step(1 / FPS);
  frames.push(renderer.snapshot());
}
Object.assign(window, { __frames: frames, __recordDone: true });
