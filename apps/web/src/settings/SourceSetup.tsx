import { type ProviderSpec, providerById } from "@localdot/providers";
import { useMemo } from "react";
import { t } from "../i18n/index.ts";
import type { Provider } from "../keys/binding.ts";
import { KeyForm, type KeyFormPreset } from "../keys/KeyForm.tsx";
import { keysUnavailable, LOCKED_TEXT, SETUP_TEXT } from "../keys/KeysPanel.tsx";
import { vaultLocked } from "../keys/keys-api.ts";
import { UNLOCK_PRIVACY, UnlockKeys } from "../keys/UnlockKeys.tsx";
import type { KeysController } from "../keys/useKeys.ts";
import { hostOf, KEY_PAGES } from "../onboarding/wizard.ts";
import { ChatgptPanel } from "./ChatgptPanel.tsx";
import { ClaudeCodePanel } from "./ClaudeCodePanel.tsx";
import { CHATGPT } from "./chooser.ts";
import type { ModelSource } from "./model-library.ts";
import type { ChatgptControls } from "./useChatgpt.ts";
import type { ClaudeCodeControls } from "./useClaudeCode.ts";

export interface SetupControls {
  keyStore: Pick<KeysController, "save" | "busy" | "health" | "keys" | "unlock">;
  plans: { chatgpt: ChatgptControls; claudeCode: ClaudeCodeControls };
}

// A provider set up where its models are added: a key saved through the key layer as Keys saves
// one, a plan through its own sign-in, an endpoint by its address and key.
export function SourceSetup({
  source,
  format,
  active,
  controls,
  onKeySaved,
}: {
  source: ModelSource;
  // An endpoint's API format, which names the kind of key it takes.
  format: string;
  active: boolean;
  controls: SetupControls;
  onKeySaved(id: string): void;
}) {
  if (source.setup === "plan")
    return (
      <div className="settings-setup">
        <p className="settings-lede">{t`Its models are listed here once it's ready.`}</p>
        {source.provider === CHATGPT ? (
          <ChatgptPanel account={controls.plans.chatgpt} />
        ) : (
          <ClaudeCodePanel claude={controls.plans.claudeCode} titled={false} />
        )}
      </div>
    );
  const endpoint = source.setup === "endpoint";
  const spec = providerById(endpoint ? format : source.provider);
  if (!spec) return null;
  // A new kind of key starts a new form; an endpoint's formats that share a key keep what was typed.
  return (
    <KeySetup
      key={endpoint ? spec.keyd : spec.id}
      spec={spec}
      endpoint={endpoint}
      active={active}
      keyStore={controls.keyStore}
      onKeySaved={onKeySaved}
    />
  );
}

function KeySetup({
  spec,
  endpoint,
  active,
  keyStore,
  onKeySaved,
}: {
  spec: ProviderSpec;
  endpoint: boolean;
  active: boolean;
  keyStore: SetupControls["keyStore"];
  onKeySaved(id: string): void;
}) {
  const provider = spec.keyd as Provider;
  const { baseURL } = spec;
  // The form starts again on a new preset, so there is one for each provider.
  const preset = useMemo<KeyFormPreset>(
    () => ({ requestId: 0, provider, ...(baseURL ? { baseURL } : {}) }),
    [provider, baseURL],
  );
  const page = KEY_PAGES[spec.id];
  const { health, unlock } = keyStore;
  const setup = health?.vault?.state === "setup";
  return (
    <div className="settings-setup">
      <p className="settings-lede">
        {endpoint
          ? t`Your server's https address, and a key for it. It goes straight to your key layer and isn't shown again.`
          : spec.plan
            ? t`Paste your ${spec.name} key. It goes straight to your key layer and isn't shown again.`
            : t`Paste an API key from ${spec.name}. It goes straight to your key layer and isn't shown again.`}
      </p>
      {spec.rule && <p className="settings-note">{spec.rule}</p>}
      {page ? (
        <p className="settings-setup-link">
          <a href={page} target="_blank" rel="noopener noreferrer">
            {t`Get a key from ${spec.name}`}
          </a>
          <span className="settings-setup-host">{hostOf(page)}</span>
        </p>
      ) : (
        !endpoint && (
          <p className="settings-note">
            {t`Make one in your ${spec.name} account, then paste it here.`}
          </p>
        )
      )}
      {vaultLocked(health) && unlock && (
        <>
          <p className="settings-note">{setup ? SETUP_TEXT : LOCKED_TEXT}</p>
          <UnlockKeys
            setup={setup}
            unlock={unlock}
            label={setup ? t`Choose a passphrase` : t`Unlock saved keys`}
          />
          <p className="settings-note">{UNLOCK_PRIVACY}</p>
        </>
      )}
      <KeyForm
        keyOnly
        active={active}
        preset={preset}
        unavailable={keysUnavailable(health)}
        busy={keyStore.busy}
        taken={keyStore.keys.map((key) => key.id)}
        save={async (binding, value, metadata) => {
          const saved = await keyStore.save(binding, value, ...(metadata ? [metadata] : []));
          onKeySaved(binding.id);
          return saved;
        }}
      />
    </div>
  );
}
