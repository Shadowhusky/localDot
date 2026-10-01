// The flat circle with two short eye strokes, pushed up and toward the stage. It always sits next
// to text that names dot, so it is hidden from assistive technology.
export function Mascot() {
  return (
    <svg className="mascot" viewBox="0 0 64 64" aria-hidden="true">
      <circle className="body" cx="32" cy="32" r="24" />
      <rect className="eye" x="40" y="19" width="4.6" height="9.5" rx="2.3" />
      <rect className="eye" x="49.4" y="20" width="4.3" height="8.5" rx="2.15" />
    </svg>
  );
}
