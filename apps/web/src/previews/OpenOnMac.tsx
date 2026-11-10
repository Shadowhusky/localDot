import type { PreviewItem, PreviewRequest } from "@localdot/protocol";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { TOUCH, useMediaQuery } from "../ui/media.ts";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { TextField } from "../ui/TextField.tsx";
import { type Previews, requestKey } from "./PreviewsContext.tsx";
import "../ui/previews.css";

const LOWEST = 1024;
const portKey = (app: string) => `localdot.preview-mac-port:${app}`;

// The port an app last opened at on this Mac: its sign-in expects the same one each time.
function remembered(app: string): number | undefined {
  try {
    return Number(localStorage.getItem(portKey(app))) || undefined;
  } catch {
    return undefined;
  }
}

function remember(app: string, port: number): void {
  try {
    localStorage.setItem(portKey(app), String(port));
  } catch {
    /* The next one starts from the server's own port. */
  }
}

const portOf = (text: string) => {
  const port = /^\d{4,5}$/.test(text.trim()) ? Number(text) : 0;
  return port >= LOWEST && port <= 65535 ? port : undefined;
};

// The preview of the server at `target` open on this Mac, if there is one.
export function openOnMac(previews: Previews, target: string): PreviewItem | undefined {
  return previews.status?.previews.find((preview) => preview.local && preview.target === target);
}

export const macAddress = (preview: PreviewItem) => preview.origin.replace(/^https?:\/\//, "");

// Opens an app on this Mac at http://localhost:<port>, the address its sign-in provider has
// registered, rather than at the preview's tailnet address, which such a provider refuses. A phone
// has no way to the Mac's localhost, so it isn't offered there.
export function OpenOnMac({
  previews,
  request,
  target,
  address,
  app,
  port,
}: {
  previews: Previews;
  request: PreviewRequest;
  // The server's address as previews name it, such as http://localhost:5173/.
  target: string;
  // As the row shows it.
  address: string;
  // What names the app from one start to the next: its folder, else its title.
  app: string;
  port: number;
}) {
  const touch = useMediaQuery(TOUCH);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (touch) return null;
  const chosen = portOf(text);
  const asked = { ...request, local: chosen ?? 0 };

  const show = () => {
    const there = openOnMac(previews, target);
    const start =
      (there && Number(new URL(there.origin).port)) ||
      remembered(app) ||
      (port >= LOWEST ? port : 3000);
    setText(String(start));
    setTried(false);
    setOpen(true);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!chosen || !button.current) return;
    remember(app, chosen);
    setOpen(false);
    previews.open({ ...request, local: chosen }, button.current);
  };

  return (
    <>
      <IconButton
        ref={button}
        icon="monitor"
        label={`Open ${address} at a localhost address on this Mac`}
        aria-busy={(chosen !== undefined && previews.pending.has(requestKey(asked))) || undefined}
        {...triggerProps("dialog", open)}
        onClick={() => (open ? setOpen(false) : show())}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="bottom"
        align="end"
        title="Open on this Mac"
        className="preview-mac"
      >
        <p className="preview-notice-text">
          Sign-in services such as WorkOS, Auth0 and Google send you back only to the address
          registered for the app. Open it at that address here, and signing in works.
        </p>
        <form className="preview-mac-form" onSubmit={submit} noValidate>
          <Field
            label="Address on this Mac"
            description="Only on this Mac, where the app shares localhost with your other servers."
            error={tried && !chosen ? "Use a port from 1024 to 65535." : undefined}
          >
            <TextField
              prefix="localhost:"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={5}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </Field>
          <div className="preview-notice-actions">
            <Button type="submit" size="sm" variant="primary">
              {chosen ? `Open at localhost:${chosen}` : "Open"}
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}
