import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { passphraseProblem } from "../settings/dot-copy.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { TextField } from "../ui/TextField.tsx";
import { unlockProblem } from "./keys-api.ts";
import "./keys.css";

export const UNLOCK_PRIVACY =
  "Your passphrase is sealed in this page for the key service on the computer running localDot. Neither localDot nor dot can read it.";

// The passphrase vault's lock, opened from the page. The fields are never React state: they are
// read once on submit, cleared whatever happens, and cleared again when the page is hidden.
export function UnlockKeys({
  setup,
  unlock,
  label,
  actions,
}: {
  // The vault waits for its first passphrase, which is chosen and typed twice.
  setup: boolean;
  unlock(passphrase: string): Promise<unknown>;
  // The form's name for assistive technology.
  label: string;
  // More ways on, after Unlock.
  actions?: ReactNode;
}) {
  const first = useRef<HTMLInputElement | null>(null);
  const again = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const clear = () => {
      if (first.current) first.current.value = "";
      if (again.current) again.current.value = "";
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let passphrase = first.current?.value ?? "";
    const wrong = passphraseProblem(passphrase, setup ? (again.current?.value ?? "") : passphrase);
    if (again.current) again.current.value = "";
    if (wrong) {
      setProblem(wrong);
      return;
    }
    if (first.current) first.current.value = "";
    setBusy(true);
    setProblem("");
    try {
      await unlock(passphrase);
    } catch (err) {
      if (alive.current) {
        setProblem(unlockProblem(err));
        first.current?.focus();
      }
    } finally {
      passphrase = "";
      if (alive.current) setBusy(false);
    }
  };
  return (
    <form className="keys-unlock-form" aria-label={label} autoComplete="on" onSubmit={submit}>
      <Field label={setup ? "New passphrase" : "Passphrase"} {...(setup ? {} : { error: problem })}>
        <TextField
          ref={(node) => {
            first.current = node;
          }}
          type="password"
          autoComplete={setup ? "new-password" : "current-password"}
          autoCapitalize="none"
          spellCheck={false}
          readOnly={busy}
        />
      </Field>
      {setup && (
        <Field label="Type it again" error={problem}>
          <TextField
            ref={(node) => {
              again.current = node;
            }}
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={busy}
          />
        </Field>
      )}
      <div className="keys-unlock-actions">
        <Button type="submit" variant="primary" icon="lock" busy={busy}>
          {setup ? "Save passphrase" : "Unlock"}
        </Button>
        {actions}
      </div>
    </form>
  );
}
