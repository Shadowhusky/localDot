import { isOpenRouterRouterId, providerById } from "@localdot/providers";
import { useState } from "react";
import {
  customModelAllowed,
  type ModelRole,
  modelAllowed,
  modelIdProblem,
  type PickerModel,
} from "./choices.ts";

export function ModelPicker({
  modelRole: role,
  providerId,
  models,
  value,
  disabled,
  onChange,
}: {
  modelRole: ModelRole;
  providerId: string;
  models: readonly PickerModel[];
  value: string;
  disabled?: boolean;
  onChange(id: string): void;
}) {
  const [search, setSearch] = useState("");
  const provider = providerById(providerId);
  const custom = !!provider && customModelAllowed(provider);
  const selected = models.find((model) => model.id === value);
  const query = search.trim().toLowerCase();
  const matching = models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(query),
  );
  const shown = matching.slice(0, 200);
  if (selected && !shown.some((model) => model.id === value)) shown.unshift(selected);
  const blocked = (model: PickerModel) =>
    !modelAllowed(role, model) || isOpenRouterRouterId(providerId, model.id);
  return (
    <div className="model-picker">
      <label>
        <span>Search {role} models</span>
        <input
          type="search"
          maxLength={128}
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <label>
        <span>{role} model</span>
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a model</option>
          {value && !selected && (
            <option value={value} disabled>
              {value}
              {custom ? " — custom ID" : " — unavailable in this catalog"}
            </option>
          )}
          {shown.map((model) => (
            <option key={model.id} value={model.id} disabled={blocked(model)}>
              {model.name} · {model.id}
              {blocked(model) ? " — unavailable for this role" : ""}
            </option>
          ))}
        </select>
      </label>
      {selected && <p className="model-capability">{selected.note}</p>}
      {selected && isOpenRouterRouterId(providerId, selected.id) && (
        <p>Choose a specific model. Router IDs cannot reserve a known model price.</p>
      )}
      {matching.length > 200 && (
        <p>Showing the first 200 matches. Narrow the search to see more.</p>
      )}
      {!models.length && (
        <p>
          {providerId === "chatgpt"
            ? "Account models are unavailable. Set up the ChatGPT plan to see them."
            : "No models are available in the current catalog."}
        </p>
      )}
      {custom ? (
        <label>
          <span>{role} custom model ID</span>
          <input
            value={value}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={!!value && !!modelIdProblem(value)}
          />
          {value && modelIdProblem(value) && <span role="alert">{modelIdProblem(value)}</span>}
        </label>
      ) : (
        !models.length &&
        providerId !== "chatgpt" && <p>Refresh the catalog before choosing a model.</p>
      )}
    </div>
  );
}
