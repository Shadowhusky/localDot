import { type Accessory, outfit, type PersonaId, type Wearable } from "@localdot/protocol";
import type { DemoTimeline } from "./demo.ts";

// The tasks the site offers, in the order the empty chat suggests them. Each was done for real by
// the dot named here; its bundle is under /demos/<id>/.
export interface DemoEntry {
  id: string;
  // The suggestion's words.
  ask: string;
  persona: PersonaId;
  // What sets this task's dot apart. The app's tasks draw from a bigger wardrobe, but dot has to wear
  // this in 3D as well, and only these have a model.
  accessory: Accessory;
  // The stretch of its recording, in seconds, where dot plays a game the visitor can take over.
  play?: { from: number; to: number };
}

export const DEMOS: readonly DemoEntry[] = [
  {
    id: "breakout",
    ask: "Make a Breakout game where you're the ball",
    persona: "coder",
    accessory: "sunglasses",
    play: { from: 16.2, to: 32.7 },
  },
  {
    id: "kyoto",
    ask: "Plan three autumn days in Kyoto",
    persona: "research",
    accessory: "star-pin",
  },
  { id: "spending", ask: "Make sense of my bank export", persona: "finance", accessory: "bow" },
  {
    id: "poster",
    ask: "Design a poster for a jazz night",
    persona: "design",
    accessory: "star-pin",
  },
  {
    id: "teaser",
    ask: "Cut a Reels teaser from a short film",
    persona: "video",
    accessory: "sunglasses",
  },
];

// A task's dot, as the app dresses one so a list of them can be told apart.
export const lookOf = (entry: DemoEntry): Wearable[] => outfit(entry.persona, entry.accessory);

const loaded = new Map<string, Promise<DemoTimeline>>();

export function loadDemo(id: string): Promise<DemoTimeline> {
  let pending = loaded.get(id);
  if (!pending) {
    pending = fetch(`/demos/${id}/timeline.json`).then((response) => {
      if (!response.ok) throw new Error(`Demo ${id} is unavailable (${response.status}).`);
      return response.json() as Promise<DemoTimeline>;
    });
    pending.catch(() => loaded.delete(id));
    loaded.set(id, pending);
  }
  return pending;
}
