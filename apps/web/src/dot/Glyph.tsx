// The static dot, hinted to the 16 px grid, for 14–18 px places such as the brand and author lines.
// The body takes the surrounding text colour. It always sits next to text naming dot, so it is
// hidden from assistive technology. Without a size it fills its box.
export function Glyph({ size }: { size?: number }) {
  return (
    <svg
      className="dot-glyph"
      viewBox="0 0 16 16"
      width={size ?? "100%"}
      height={size ?? "100%"}
      aria-hidden="true"
    >
      <circle className="dot-glyph-body" cx="8" cy="8" r="6.75" />
      <rect className="dot-glyph-eye" x="6" y="5.5" width="2" height="2.75" rx="1" />
      <rect className="dot-glyph-eye" x="9.5" y="5.5" width="2" height="2.75" rx="1" />
    </svg>
  );
}
