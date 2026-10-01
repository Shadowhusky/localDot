import {
  type AgentStateName,
  AvatarController,
  EventDriver,
  MascotRenderer,
  type ReactionKind,
} from "@localdot/avatar";
import { SpineRenderer } from "@localdot/avatar-spine";
import { loadPack } from "./packs.ts";
import { SAMPLE_SCREEN, SAMPLE_SESSION, sampleTrack } from "./samples.ts";

const STATES: AgentStateName[] = [
  "idle",
  "thinking",
  "acting",
  "observing",
  "waiting_user",
  "paused",
  "error",
  "done",
];
const REACTIONS: ReactionKind[] = ["nod", "wince", "cheer", "hmph", "surprise", "blush"];

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const avatarEl = byId<HTMLElement>("avatar");
const desktopEl = byId<HTMLElement>("desktop");
const focusEl = byId<HTMLElement>("focus");
const statusEl = byId<HTMLElement>("status");

const headCenter = () => {
  const r = avatarEl.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height * 0.44 };
};
const toPage = (p: { x: number; y: number }) => {
  const r = desktopEl.getBoundingClientRect();
  return {
    x: r.left + (p.x / SAMPLE_SCREEN.w) * r.width,
    y: r.top + (p.y / SAMPLE_SCREEN.h) * r.height,
  };
};

const query = new URLSearchParams(location.search);
const useSpine = query.get("renderer") === "spine";
avatarEl.dataset.renderer = useSpine ? "spine" : "mascot";
const renderer = useSpine
  ? new SpineRenderer(await loadPack(query.get("pack") === "dev" ? "dev" : "toy"))
  : new MascotRenderer();
await renderer.mount(avatarEl);
const controller = new AvatarController({
  seed: 7,
  headCenter: headCenter(),
  reach: 700,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
});
const driver = new EventDriver(controller, toPage);
addEventListener("resize", () => controller.setHeadCenter(headCenter()));

desktopEl.addEventListener("pointermove", (e) =>
  driver.attention.set("pointer", { x: e.clientX, y: e.clientY }, performance.now()),
);
desktopEl.addEventListener("pointerleave", () => driver.attention.clear("pointer"));

const addButtons = (containerId: string, labels: string[], onPress: (label: string) => void) => {
  const container = byId<HTMLElement>(containerId);
  for (const label of labels) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("pointerdown", () => onPress(label));
    container.appendChild(button);
  }
};
addButtons("states", STATES, (s) => controller.setState(s as AgentStateName));
addButtons("reactions", REACTIONS, (r) => controller.react(r as ReactionKind));
byId<HTMLElement>("speak").addEventListener("pointerdown", () =>
  controller.speak(sampleTrack(performance.now())),
);
byId<HTMLInputElement>("reduced").addEventListener("change", (e) =>
  controller.setReducedMotion((e.target as HTMLInputElement).checked),
);

let replayTimers: number[] = [];
byId<HTMLElement>("replay").addEventListener("pointerdown", () => {
  for (const id of replayTimers) clearTimeout(id);
  replayTimers = SAMPLE_SESSION.map(({ atMs, event }) =>
    window.setTimeout(() => {
      driver.handle(event);
      statusEl.textContent = event.type;
    }, atMs),
  );
});

let last = performance.now();
const tick = () => {
  const now = performance.now();
  driver.update();
  const focus = driver.attention.resolve(now);
  const showFocus = focus.point && (focus.source === "target" || focus.source === "changed");
  focusEl.style.opacity = showFocus ? "1" : "0";
  if (focus.point) {
    const r = desktopEl.getBoundingClientRect();
    focusEl.style.left = `${focus.point.x - r.left}px`;
    focusEl.style.top = `${focus.point.y - r.top}px`;
  }
  renderer.apply(controller.frame(), now - last);
  last = now;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
