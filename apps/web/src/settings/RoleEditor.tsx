import { providerById } from "@localdot/providers";
import type { KeyRecord } from "../keys/keys-api.ts";
import {
  type ModelRole,
  matchingKeys,
  type PickerModel,
  type ProviderModels,
  type RoleChoice,
} from "./choices.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ProviderPicker } from "./ProviderPicker.tsx";

const ROLE_HELP: Record<ModelRole, string> = {
  main: "Main carries out the task. A model with tools is required; text-only models can use files and the shell.",
  fast: "Fast is optional, for titles and summaries. A model without tools cannot control the computer.",
  local: "Local is optional, for work served by LM Studio or Ollama on this Mac.",
};
export function RoleEditor({
  modelRole: role,
  value,
  providers,
  keys,
  keyLayer,
  subscriptionModels = [],
  disabled,
  onChange,
  onKeys,
}: {
  modelRole: ModelRole;
  value?: RoleChoice;
  providers: readonly ProviderModels[];
  keys: readonly KeyRecord[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly PickerModel[];
  disabled?: boolean;
  onChange(value: RoleChoice | undefined): void;
  onKeys(role: ModelRole, provider: string, trigger: HTMLButtonElement): void;
}) {
  const provider = value && providerById(value.provider);
  const availableKeys = provider ? matchingKeys(provider, keys) : [];
  const models =
    value?.provider === "chatgpt"
      ? subscriptionModels
      : (providers.find((p) => p.id === value?.provider)?.models ?? []);
  const missingKey = !!value?.key && !availableKeys.some((key) => key.id === value.key);
  return (
    <fieldset className="role-editor" disabled={disabled}>
      <legend>
        {role[0]?.toUpperCase()}
        {role.slice(1)}
      </legend>
      <p>{ROLE_HELP[role]}</p>
      {role !== "main" && (
        <label className="role-enabled">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(event) =>
              onChange(event.target.checked ? { provider: "", model: "" } : undefined)
            }
          />
          Use a {role} model
        </label>
      )}
      {(role === "main" || value) && (
        <>
          <ProviderPicker
            modelRole={role}
            value={value?.provider ?? ""}
            disabled={disabled}
            onChange={(id) => onChange({ provider: id, model: "" })}
          />
          {value?.provider && (
            <ModelPicker
              key={value.provider}
              modelRole={role}
              providerId={value.provider}
              models={models}
              value={value.model}
              disabled={disabled}
              onChange={(model) => onChange({ ...value, model, price: undefined })}
            />
          )}
          {provider && !provider.local && !provider.availableIn && (
            <div className="role-key">
              <label>
                <span>{role} key</span>
                <select
                  value={value?.key ?? ""}
                  disabled={disabled || keyLayer !== "online"}
                  onChange={(event) =>
                    value && onChange({ ...value, key: event.target.value || undefined })
                  }
                >
                  <option value="">Choose a stored key</option>
                  {missingKey && (
                    <option value={value?.key} disabled>
                      {value?.key} — missing or bound to another provider
                    </option>
                  )}
                  {availableKeys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.id}
                      {key.baseURL ? ` · ${key.baseURL}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {keyLayer !== "online" && (
                <p>Key metadata is unavailable. Reconnect before saving this provider.</p>
              )}
              {keyLayer === "online" && !availableKeys.length && (
                <p>Add a key bound to {provider.name}.</p>
              )}
              {provider.client === "azure" || provider.id === "openai-compatible" ? (
                <p>Configure the endpoint under Keys.</p>
              ) : null}
              <button
                type="button"
                disabled={disabled || keyLayer !== "online"}
                onClick={(event) => onKeys(role, provider.id, event.currentTarget)}
              >
                Add key for {role}
              </button>
            </div>
          )}
          {value?.provider === "chatgpt" && (
            <p>The ChatGPT plan uses account sign-in and requires no API key or per-token price.</p>
          )}
        </>
      )}
    </fieldset>
  );
}
