import { sameCredential } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { valueProblem } from "../keys/binding.ts";
import { problemText } from "../keys/keys-api.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import { TextField } from "../ui/TextField.tsx";
import { type AskFormProps, DotWroteThis } from "./AskForm.tsx";
import { useAskState } from "./ask-draft.ts";

export function PrivateKeyRequest({ draft, answer, saveKey, reason }: AskFormProps) {
  const field = draft.fields[0],
    request = field?.credential;
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null),
    alive = useRef(true),
    locked = useRef(false);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const state = useAskState(draft);
  const saved = field && state.draft.values[field.id] === true;
  useEffect(() => {
    alive.current = true;
    const element = input.current;
    const clear = () => {
      if (element) element.value = "";
    };
    const hidden = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      clear();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (reason && input.current) input.current.value = "";
  }, [reason]);
  if (!request || !field)
    return (
      <p role="alert">{t`This key request is incomplete. Ask dot to check its service settings.`}</p>
    );
  const binding = request.binding;
  return (
    <form
      aria-label={t`Save a service key`}
      className="private-key-request keys-form"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        if (locked.current || reason || !saveKey || state.sending) return;
        locked.current = true;
        setSaving(true);
        setError("");
        let value = input.current?.value ?? "";
        if (binding.kind !== "secret") value = value.trim();
        if (input.current) input.current.value = "";
        try {
          if (!saved) {
            if (!value)
              throw new Error(
                binding.kind === "secret" ? t`Enter a key or secret.` : t`Enter an API key.`,
              );
            const bad = valueProblem(value, binding.kind, {
              ...(binding.kind === "llm" ? { provider: binding.provider } : {}),
              ...(binding.kind === "http" ? { format: binding.format } : {}),
            });
            if (bad) throw new Error(bad);
            const result = await saveKey(binding, value, request.metadata);
            value = "";
            if (!alive.current) return;
            if (!result.key || !sameCredential(result.key, binding))
              throw new Error(t`The saved key could not be verified.`);
            draft.set(field.id, true);
          }
          if (alive.current) await draft.submit(answer);
        } catch (err) {
          if (alive.current) setError(problemText(err));
        } finally {
          value = "";
          locked.current = false;
          if (alive.current) setSaving(false);
        }
      }}
    >
      <p className="private-key-title">{request.metadata.label || binding.id}</p>
      <p className="private-key-destination">
        {binding.kind === "llm"
          ? `${request.metadata.service || binding.provider}${binding.baseURL ? ` · ${binding.baseURL}` : ""}`
          : binding.kind === "http"
            ? binding.hosts.join(", ")
            : t`General key`}
      </p>
      {request.metadata.description && <p>{request.metadata.description}</p>}
      <p>
        {binding.kind === "secret"
          ? t`Saved encrypted in Keys. dot can find its name and purpose, but cannot read its value or send it to a service.`
          : t`dot can use this key for the service above when needed. It is saved privately in Keys; its value never enters the conversation.`}
      </p>
      {!saved && (
        <Field label={binding.kind === "secret" ? t`Key or secret` : t`API key`}>
          {binding.kind === "secret" ? (
            <TextArea
              ref={(node) => {
                input.current = node;
              }}
              className="keys-secret"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={8192}
              readOnly={saving || !!reason}
            />
          ) : (
            <TextField
              ref={(node) => {
                input.current = node;
              }}
              className="keys-secret"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={8192}
              readOnly={saving || !!reason}
              aria-label={t`API key`}
            />
          )}
        </Field>
      )}
      <DotWroteThis />
      {(error || state.failed) && <p role="alert">{error || state.failed}</p>}
      <div className="keys-actions">
        <Button
          variant="quiet"
          disabledReason={saving ? t`Saving key` : state.sending ? t`Continuing task` : reason}
          onClick={() => {
            if (input.current) input.current.value = "";
            void draft.decline(answer);
          }}
        >
          {t`Not now`}
        </Button>
        <Button
          type="submit"
          busy={saving}
          disabledReason={
            reason ??
            (state.sending ? t`Continuing task` : undefined) ??
            (!saveKey ? t`Key protection is unavailable` : undefined)
          }
        >
          {saved ? t`Continue` : t`Save and continue`}
        </Button>
      </div>
    </form>
  );
}
