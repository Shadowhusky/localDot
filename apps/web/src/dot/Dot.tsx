import type { Wearable } from "@localdot/protocol";
import { type CSSProperties, useEffect, useRef, useSyncExternalStore } from "react";
import type { DotState } from "./engine/states.ts";
import { Glyph } from "./Glyph.tsx";
import { DotView } from "./render/DotView.ts";
import { lodFor } from "./render/lod.ts";
import "./dot.css";

export interface DotProps {
  // CSS px of the whole frame; the ball is three quarters of it.
  size: number;
  state?: DotState;
  // dot has control: the xenon rim.
  control?: boolean;
  // Defaults to the system preference.
  reducedMotion?: boolean;
  // Fixes how this dot moves; by default each dot moves its own way.
  seed?: number;
  // What it wears; by default the user's dot's outfit.
  wearables?: readonly Wearable[];
  style?: CSSProperties;
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia(REDUCED).matches;

// The live dot. Up to 18 px it is the static glyph; above that, a DotView. Decorative: it always
// sits next to text that says what dot is doing.
export function Dot({ size, ...props }: DotProps) {
  return lodFor(size) === "glyph" ? <Glyph size={size} /> : <LiveDot size={size} {...props} />;
}

function LiveDot({
  size,
  state = "idle",
  control = false,
  reducedMotion,
  seed,
  wearables,
  style,
}: DotProps) {
  const prefersReduced = useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
  const reduced = reducedMotion ?? prefersReduced;
  const host = useRef<HTMLSpanElement>(null);
  const view = useRef<DotView | null>(null);
  const initial = useRef({ size, state, control, reducedMotion: reduced, seed, wearables });
  useEffect(() => {
    if (!host.current) return;
    const v = new DotView(host.current, initial.current);
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => view.current?.setState(state), [state]);
  useEffect(() => view.current?.setControl(control), [control]);
  useEffect(() => view.current?.setReducedMotion(reduced), [reduced]);
  useEffect(() => view.current?.setSize(size), [size]);
  const outfit = wearables?.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the outfit's words say when it changed.
  useEffect(() => view.current?.setWearables(wearables), [outfit]);
  return (
    <span
      ref={host}
      className="dot"
      aria-hidden="true"
      style={{ ...style, "--dot-size": `${size}px` } as CSSProperties}
    />
  );
}
