import type { PreviewItem, PreviewRequest } from "@localdot/protocol";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
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

// Opens an app on this Mac at http://localhost:<port>, the address its own sign-in or settings
// expect, rather than at the preview's tailnet address. A phone has no way to the Mac's localhost,
// so the card doesn't offer it there.
export function LocalAddress({
  previews,
  request,
  target,
  app,
  port,
  open,
  onClose,
  anchor,
}: {
  previews: Previews;
  request: PreviewRequest;
  // The server's address as previews name it, such as http://localhost:5173/.
  target: string;
  // What names the app from one start to the next: its folder, else its title.
  app: string;
  port: number;
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const there = openOnMac(previews, target);
      const start =
        (there && Number(new URL(there.origin).port)) ||
        remembered(app) ||
        (port >= LOWEST ? port : 3000);
      setText(String(start));
      setTried(false);
    }
  }
  const chosen = portOf(text);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!chosen || !anchor.current) return;
    remember(app, chosen);
    onClose();
    previews.open({ ...request, local: chosen }, anchor.current);
  };

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      side="bottom"
      align="end"
      title={t`Open at a localhost address`}
      className="preview-mac"
    >
      <p className="preview-notice-text">
        {t`Some apps only work at their own localhost address, such as one whose sign-in sends you back there. This opens the app at that address on this Mac.`}
      </p>
      <form className="preview-mac-form" onSubmit={submit} noValidate>
        <Field
          label={t`Address on this Mac`}
          error={tried && !chosen ? t`Use a port from 1024 to 65535.` : undefined}
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
            {chosen ? t`Open at localhost:${chosen}` : t`Open`}
          </Button>
        </div>
      </form>
    </Popover>
  );
}

// What a preview's row offers: Open, the one thing most presses want, and a menu for the rest.
export function PreviewActions({
  previews,
  request,
  target,
  address,
  app,
  port,
  opener,
}: {
  previews: Previews;
  request: PreviewRequest;
  target: string;
  // As the row shows it.
  address: string;
  app: string;
  port: number;
  // The Open button, for a row that opens on a press anywhere in it.
  opener?: RefObject<HTMLButtonElement | null>;
}) {
  const touch = useMediaQuery(TOUCH);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [local, setLocal] = useState(false);
  return (
    <>
      <IconButton
        ref={more}
        icon="more-horizontal"
        label={t`More for ${address}`}
        aria-busy={previews.pending.has(`copy ${requestKey(request)}`) || undefined}
        {...triggerProps("menu", menu)}
        onClick={() => setMenu((was) => !was)}
      />
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={more}
        side="bottom"
        align="end"
        label={t`More for ${address}`}
      >
        <MenuItem icon="copy" onSelect={() => more.current && previews.copy(request, more.current)}>
          {t`Copy link`}
        </MenuItem>
        {!touch && (
          <MenuItem icon="monitor" onSelect={() => setLocal(true)}>
            {t`Open at a localhost address…`}
          </MenuItem>
        )}
      </Menu>
      <LocalAddress
        previews={previews}
        request={request}
        target={target}
        app={app}
        port={port}
        open={local}
        onClose={() => setLocal(false)}
        anchor={more}
      />
      <Button
        ref={opener}
        size="sm"
        aria-label={t`Open preview of ${address}`}
        busy={previews.pending.has(requestKey(request))}
        onClick={(event) => previews.open(request, event.currentTarget)}
      >
        {t`Open`}
      </Button>
    </>
  );
}
