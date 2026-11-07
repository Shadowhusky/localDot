import { clsx } from "clsx";

// A checkbox's look for a row that is itself the checkbox (role="checkbox"), so it holds no input.
export function CheckMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      className={clsx("ui-checkbox", className)}
      data-checked={checked ? "" : undefined}
      aria-hidden="true"
    >
      <svg className="ui-checkbox-mark" viewBox="0 0 16 16" aria-hidden="true">
        <path className="ui-checkbox-check" d="M4 8.25 6.75 11 12 5.25" pathLength={1} />
      </svg>
    </span>
  );
}
