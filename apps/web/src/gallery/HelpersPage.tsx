import type { Wearable } from "@localdot/protocol";
import { type CSSProperties, useEffect, useRef } from "react";
import { DotView } from "../dot/render/DotView.ts";
import "../dot/dot.css";

const SIZES = [28, 48, 72, 96, 144, 240];
const CREWS = [1, 2, 3, 4, 6, 9];
const OUTFITS: { label: string; wearables: readonly Wearable[] }[] = [
  { label: "bare", wearables: [] },
  { label: "wide", wearables: ["headphones", "mustache"] },
  { label: "tall", wearables: ["mortarboard", "round-glasses"] },
];

// The sub-agents as DotView draws them: they come out at once, and on the page's clock the first
// finishes well at 2.4 s and the second fails at 3.2 s.
function Crew({
  size,
  count,
  wearables,
  reducedMotion,
}: {
  size: number;
  count: number;
  wearables: readonly Wearable[];
  reducedMotion: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const view = new DotView(host.current, {
      size,
      state: "thinking",
      control: false,
      reducedMotion,
      seed: 1,
      wearables,
    });
    const crew = Array.from({ length: count }, (_, at) => ({ id: `h${at}` }));
    view.setTool("delegating");
    view.setHelpers(crew);
    const timers = [
      setTimeout(
        () => view.setHelpers(crew.map((h, at) => (at === 0 ? { ...h, ok: true } : h))),
        2400,
      ),
      setTimeout(
        () =>
          view.setHelpers(
            crew.flatMap((h, at) => (at === 0 ? [] : at === 1 ? [{ ...h, ok: false }] : [h])),
          ),
        3200,
      ),
      setTimeout(() => view.setHelpers(crew.slice(2)), 4000),
    ];
    return () => {
      for (const timer of timers) clearTimeout(timer);
      view.destroy();
    };
  }, [size, count, wearables, reducedMotion]);
  return <span ref={host} className="dot" style={{ "--dot-size": `${size}px` } as CSSProperties} />;
}

// Each size of dot with each number of sub-agents, for the eye and for the harness's frames.
export function HelpersPage() {
  const reduced = location.search.includes("reduced");
  return (
    <div className="gallery-helpers">
      {OUTFITS.map(({ label, wearables }) => (
        <section key={label} data-outfit={label}>
          <h2>{label}</h2>
          {CREWS.map((count) => (
            <div key={count} className="gallery-helpers-row">
              <span>{count}</span>
              {SIZES.map((size) => (
                <Crew
                  key={size}
                  size={size}
                  count={count}
                  wearables={wearables}
                  reducedMotion={reduced}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
