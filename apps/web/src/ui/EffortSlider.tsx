import { useId } from "react";

// A native discrete slider: keyboard arrows, Home/End, touch and screen-reader values all
// describe the same supported steps. The first step is always the provider default.
export function EffortSlider({
  label = "Reasoning effort",
  value,
  items,
  onChange,
}: {
  label?: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange(value: string): void;
}) {
  const id = useId();
  const index = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );
  return (
    <div className="model-effort-slider">
      <div className="model-effort-heading">
        <label htmlFor={id}>{label}</label>
        <span className="model-effort-value">{value ? items[index]?.label : "Default"}</span>
      </div>
      <div className="model-effort-track">
        <input
          id={id}
          type="range"
          aria-label={label}
          aria-valuetext={items[index]?.label}
          min={0}
          max={items.length - 1}
          step={1}
          value={index}
          onChange={(event) => {
            const item = items[Number(event.target.value)];
            if (item) onChange(item.value);
          }}
        />
        <div className="model-effort-dots" aria-hidden="true">
          {items.map((item, step) => (
            <span key={item.value} data-passed={step <= index || undefined} />
          ))}
        </div>
      </div>
    </div>
  );
}
