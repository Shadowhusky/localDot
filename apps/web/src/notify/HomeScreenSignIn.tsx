import { type FormEvent, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { TextField } from "../ui/TextField.tsx";
import { codeFromPasted } from "./home-screen-link.ts";

const NOT_A_LINK =
  "That isn't a localDot sign-in link for this address. Create a fresh link in the browser where you’re signed in.";
const EXPIRED =
  "That link has expired or was already used. Create a fresh link in the browser where you’re signed in.";

// The Home Screen app has its own storage, so it signs in from a one-use link copied from a signed-in browser.
// The code goes to the app's existing exchange through the address fragment and nowhere else.
export function HomeScreenSignIn({
  rejected = false,
  origin = window.location.origin,
  go = (code: string) => {
    window.location.hash = `code=${code}`;
  },
}: {
  rejected?: boolean;
  origin?: string;
  go?: (code: string) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(rejected ? EXPIRED : null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    const code = codeFromPasted(text, origin);
    if (!code) {
      setError(NOT_A_LINK);
      return;
    }
    setError(null);
    setText("");
    go(code);
  };
  return (
    <form className="sign-in-form" aria-label="Sign in this app" noValidate onSubmit={submit}>
      <Field label="Sign-in link" error={error ?? undefined}>
        <TextField
          value={text}
          placeholder="Paste a fresh sign-in link"
          onChange={(event) => setText(event.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          enterKeyHint="go"
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabledReason={text.trim() ? undefined : "Paste the link first."}
      >
        Sign in
      </Button>
    </form>
  );
}
