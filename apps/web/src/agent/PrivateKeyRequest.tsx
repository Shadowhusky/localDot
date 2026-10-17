import { sameCredential } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import { problemText } from "../keys/keys-api.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { TextField } from "../ui/TextField.tsx";
import type { AskFormProps } from "./AskForm.tsx";
import { useAskState } from "./ask-draft.ts";

export function PrivateKeyRequest({ draft, answer, saveKey, reason }: AskFormProps) {
  const field = draft.fields[0],
    request = field?.credential;
  const input = useRef<HTMLInputElement>(null),
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
      <p role="alert">This key request is incomplete. Ask dot to check its service settings.</p>
    );
  const binding = request.binding;
  return (
    <form
      aria-label="Save a service key"
      className="private-key-request keys-form"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        if (locked.current || reason || !saveKey || state.sending) return;
        locked.current = true;
        setSaving(true);
        setError("");
        let value = input.current?.value.trim() ?? "";
        if (input.current) input.current.value = "";
        try {
          if (!saved) {
            if (!value) throw new Error("Enter an API key.");
            const result = await saveKey(binding, value, request.metadata);
            value = "";
            if (!alive.current) return;
            if (!result.key || !sameCredential(result.key, binding))
              throw new Error("The saved key could not be verified.");
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
          : binding.hosts.join(", ")}
      </p>
      {request.metadata.description && <p>{request.metadata.description}</p>}
      <p>
        dot can use this key for the service above when needed. It is saved privately in Keys; its
        value never enters the conversation.
      </p>
      {!saved && (
        <Field label="API key">
          <TextField
            ref={input}
            className="keys-secret"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={8192}
            readOnly={saving || !!reason}
            aria-label="API key"
          />
        </Field>
      )}
      {(error || state.failed) && <p role="alert">{error || state.failed}</p>}
      <div className="keys-actions">
        <Button
          variant="quiet"
          disabledReason={saving ? "Saving key" : state.sending ? "Continuing task" : reason}
          onClick={() => {
            if (input.current) input.current.value = "";
            void draft.decline(answer);
          }}
        >
          Not now
        </Button>
        <Button
          type="submit"
          busy={saving}
          disabledReason={
            reason ??
            (state.sending ? "Continuing task" : undefined) ??
            (!saveKey ? "Key protection is unavailable" : undefined)
          }
        >
          {saved ? "Continue" : "Save and continue"}
        </Button>
      </div>
    </form>
  );
}
