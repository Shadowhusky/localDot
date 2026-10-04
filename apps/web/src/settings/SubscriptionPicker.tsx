import { useId, useState } from "react";
import type { SubscriptionModel } from "./choices.ts";

export function SubscriptionPicker({
  models,
  value,
  disabled,
  onChange,
}: {
  models: readonly SubscriptionModel[];
  value: string;
  disabled?: boolean;
  onChange(id: string): void;
}) {
  const id = useId(),
    [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const selected = models.find((model) => model.id === value);
  const shown = models.filter(
    (model) => model.id === value || `${model.name} ${model.id}`.toLowerCase().includes(query),
  );
  return (
    <div className="subscription-picker">
      <label>
        <span>Search main account models</span>
        <input
          type="search"
          maxLength={128}
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <label>
        <span id={id}>main model</span>
        <select
          aria-labelledby={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose an account model</option>
          {value && !selected && (
            <option value={value} disabled>
              {value} — not currently reported by this account
            </option>
          )}
          {shown.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} · {model.id}
            </option>
          ))}
        </select>
      </label>
      {!models.length && <p>Sign in and check the account to load its reported models.</p>}
    </div>
  );
}
