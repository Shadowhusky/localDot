import type { BrowserEngineName } from "../../../../packages/protocol/src/browser-engine.ts";

// The web browser's app icon, as the dock's own icons are drawn: a white tile with the browser's
// mark, three bands around a ring, each band's edge running past the ring as a tangent.
const OUTER = 15;
const INNER = 7;
const reach = Math.sqrt(OUTER * OUTER - INNER * INNER);
const n = (value: number) => Number((24 + value).toFixed(3));
const edge = (degrees: number) => {
  const angle = (degrees * Math.PI) / 180;
  const tx = INNER * Math.cos(angle - Math.PI / 2);
  const ty = INNER * Math.sin(angle - Math.PI / 2);
  return {
    inner: `${n(tx)} ${n(ty)}`,
    outer: `${n(tx + reach * Math.cos(angle))} ${n(ty + reach * Math.sin(angle))}`,
  };
};
const band = (from: number, to: number) => {
  const a = edge(from);
  const b = edge(to);
  return `M${a.inner}L${a.outer}A${OUTER} ${OUTER} 0 0 1 ${b.outer}L${b.inner}A${INNER} ${INNER} 0 0 0 ${a.inner}Z`;
};
const BANDS = [band(-150, -30), band(-30, 90), band(90, 210)];

export function BrowserIcon({ engine }: { engine?: BrowserEngineName }) {
  return (
    <svg
      className="browser-icon"
      data-engine={engine === "chromium" ? "chromium" : "chrome"}
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      <rect className="browser-icon-tile" x="2" y="2" width="44" height="44" rx="10" />
      {BANDS.map((d, index) => (
        <path key={d} className={`browser-icon-band browser-icon-band-${index}`} d={d} />
      ))}
      <circle className="browser-icon-ring" cx="24" cy="24" r={INNER} />
      <circle className="browser-icon-core" cx="24" cy="24" r={INNER * 0.78} />
    </svg>
  );
}
