import { providerById } from "@localdot/providers";
import { useId, useState } from "react";
import { CLAUDE_PLAN_REFUSAL } from "../keys/binding.ts";
import {
  groupOf,
  type ModelRole,
  matchingProviders,
  PROVIDER_GROUPS,
  providerPickable,
} from "./choices.ts";

const CLAUDE_PLAN_SEARCH = /\b(?:claude|pro|max|subscription)\b/i;

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
  const providerLabel = useId();
  const noteId = useId();
  const [search, setSearch] = useState("");
  const shown = [...matchingProviders(search)];
  const selected = providerById(value);
  if (selected && !shown.some((provider) => provider.id === selected.id)) shown.unshift(selected);
  const note =
    selected?.notOffered ??
    selected?.rule ??
    (selected?.id === "anthropic" ? CLAUDE_PLAN_REFUSAL : undefined);
  const searchedReasons = search.trim()
    ? shown.filter((provider) => provider.notOffered && provider !== selected)
    : [];
  const claudePlanSearched = role !== "local" && CLAUDE_PLAN_SEARCH.test(search);
  const chatgptShown =
    role === "main" &&
    (!search.trim() ||
      "chatgpt plan subscription".includes(search.trim().toLowerCase()) ||
      value === "chatgpt");
  const claudePlanShown = role === "main" && (!search.trim() || claudePlanSearched);
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
        <span id={providerLabel}>{role} provider</span>
        <select
          aria-labelledby={providerLabel}
          aria-describedby={note ? noteId : undefined}
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
                    disabled={!providerPickable(role, provider)}
                  >
                    {provider.name}
                    {provider.availableIn ? " — available in a later release" : ""}
                    {provider.notOffered ? " — not available here" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
          {(chatgptShown || value === "chatgpt" || claudePlanShown) && (
            <optgroup label="Subscription">
              {(chatgptShown || value === "chatgpt") && (
                <option value="chatgpt" disabled={role !== "main"}>
                  ChatGPT plan
                </option>
              )}
              {claudePlanShown && (
                <option value="claude-plan" disabled>
                  Claude Pro or Max — not available here
                </option>
              )}
            </optgroup>
          )}
        </select>
      </label>
      {note && (
        <p id={noteId} className="provider-note">
          {note}
        </p>
      )}
      {claudePlanSearched && note !== CLAUDE_PLAN_REFUSAL && (
        <p className="provider-note">{CLAUDE_PLAN_REFUSAL}</p>
      )}
      {searchedReasons.map((provider) => (
        <p key={provider.id} className="provider-note">
          {provider.name}: {provider.notOffered}
        </p>
      ))}
      {role === "local" && <p>Local models use LM Studio or Ollama on this Mac.</p>}
    </div>
  );
}
