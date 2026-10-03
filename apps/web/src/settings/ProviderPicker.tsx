import { providerById } from "@localdot/providers";
import { useState } from "react";
import {
  groupOf,
  type ModelRole,
  matchingProviders,
  PROVIDER_GROUPS,
  providerAllowed,
} from "./choices.ts";

export function ProviderPicker({
  modelRole: role,
  value,
  disabled,
  onChange,
}: {
  modelRole: ModelRole;
  value: string;
  disabled?: boolean;
  onChange(id: string): void;
}) {
  const [search, setSearch] = useState("");
  const shown = [...matchingProviders(search)];
  const selected = providerById(value);
  if (selected && !shown.some((provider) => provider.id === selected.id)) shown.unshift(selected);
  const chatgptShown =
    role === "main" &&
    (!search.trim() ||
      "chatgpt plan subscription".includes(search.trim().toLowerCase()) ||
      value === "chatgpt");
  return (
    <div className="provider-picker">
      <label>
        <span>Search {role} providers</span>
        <input
          type="search"
          maxLength={128}
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <label>
        <span>{role} provider</span>
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a provider</option>
          {value && value !== "chatgpt" && !selected && (
            <option value={value} disabled>
              {value} — unavailable
            </option>
          )}
          {PROVIDER_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {shown
                .filter((provider) => groupOf(provider) === group)
                .map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={!providerAllowed(role, provider)}
                  >
                    {provider.name}
                    {provider.availableIn ? " — available in a later release" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
          {(chatgptShown || value === "chatgpt") && (
            <optgroup label="Subscription">
              <option value="chatgpt" disabled={role !== "main"}>
                ChatGPT plan
              </option>
            </optgroup>
          )}
        </select>
      </label>
      {role === "local" && <p>Local models use LM Studio or Ollama on this Mac.</p>}
    </div>
  );
}
