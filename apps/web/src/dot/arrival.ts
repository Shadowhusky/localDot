import { Accessory, Wearable } from "@localdot/protocol";
import { useEffect, useState } from "react";
import { z } from "zod";

const KEY = "localdot.dot-look.v1";
// With nothing remembered and no answer by then, a plain dot stands in: the page is not to be
// without one. It changes, unseen by any hop, when the answer comes.
const HOLD_MS = 3000;
const NO_LOOK: readonly Wearable[] = [];

const Memory = z.object({
  worn: z.array(Wearable).optional(),
  accessory: Accessory.optional(),
  shown: z
    .object({ view: z.string(), task: z.string().nullable(), look: z.array(Wearable) })
    .optional(),
});
type Memory = z.infer<typeof Memory>;

function read(): Memory {
  try {
    return Memory.parse(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function write(change: Memory): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), ...change }));
  } catch {}
}

export function rememberedOwnDot(): { worn: readonly Wearable[]; accessory?: Accessory } {
  const { worn = [], accessory } = read();
  return accessory ? { worn, accessory } : { worn };
}

export function rememberOwnDot(worn: readonly Wearable[], accessory: Accessory | undefined): void {
  write({ worn: [...worn], accessory });
}

// What dot wore on the last visit, if that is what it will wear now: the address may name another
// conversation than the one it was dressed for.
function rememberedLook(view: string, address: string | null): readonly Wearable[] | null {
  const { shown, worn } = read();
  if (address === "new") return worn ?? null;
  if (!shown || shown.view !== view) return null;
  return !address || address === "current" || address === shown.task ? shown.look : null;
}

export interface DotArrivalInput {
  view: string;
  // The conversation the address names, on a screen with one.
  address: string | null;
  // The task on show and what dot wears for it, as far as is known.
  task: string | null;
  look: readonly Wearable[];
  // Everything that decides that has answered.
  known: boolean;
  // Off when last visit's look won't do, as when Replay opens on a recording.
  remember: boolean;
}

export interface DotArrival {
  // What dot wears; null while it stays off the page because that isn't known.
  look: readonly Wearable[] | null;
  settled: boolean;
}

// dot comes on to the page once, in its final look. A reload knows it from the last visit, so dot
// wakes at once; a first visit waits for the answers, however they come in, so no half-dressed dot
// shows on the way. Once they are all in, every later change is a real one.
export function useDotArrival({
  view,
  address,
  task,
  look,
  known,
  remember,
}: DotArrivalInput): DotArrival {
  const [memory] = useState(() => (remember ? rememberedLook(view, address) : null));
  const [settled, setSettled] = useState(known);
  if (known && !settled) setSettled(true);
  const [held, setHeld] = useState(true);
  useEffect(() => {
    if (settled || memory) return;
    const timer = setTimeout(() => setHeld(false), HOLD_MS);
    return () => clearTimeout(timer);
  }, [settled, memory]);
  const words = look.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the look's words say when it changed.
  useEffect(() => {
    if (settled) write({ shown: { view, task, look: [...look] } });
  }, [settled, view, task, words]);
  if (settled || known) return { look, settled: true };
  return { look: memory ?? (held ? null : NO_LOOK), settled: false };
}
