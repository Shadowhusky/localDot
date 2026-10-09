import { clsx } from "clsx";
import { Dot } from "./Dot.tsx";

// A whole surface loading: dot thinking above one line that says what is coming, centred in the
// room the content will take.
export function DotLoader({ label, className }: { label: string; className?: string }) {
  return (
    <div className={clsx("dot-loader", className)} role="status">
      <Dot size={48} state="thinking" />
      <p className="dot-loader-label">{label}</p>
    </div>
  );
}
