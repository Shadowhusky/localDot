import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";

// Your messages at the right and dot's at the left, at the heights and widths messages take.
const BONES = [
  ["user", "s", 56],
  ["dot", "l", 84],
  ["user", "s", 42],
  ["dot", "m", 72],
  ["user", "m", 64],
  ["dot", "l", 88],
  ["user", "s", 48],
  ["dot", "m", 78],
] as const;

// Stands in for the thread's history while it arrives, at the end of the thread where the newest
// messages will land.
export function ThreadSkeleton() {
  return (
    <div className="thread-skeleton" role="status">
      <VisuallyHidden>Loading the conversation</VisuallyHidden>
      {BONES.map(([side, size, width]) => (
        <span
          key={width}
          className="thread-bone"
          data-side={side}
          data-size={size}
          style={{ width: `${width}%` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
