import { type LocalDotLink, outfit } from "@localdot/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Dot } from "../dot/Dot.tsx";
import {
  deviceOnly,
  localDotHost,
  localDotLink,
  localDotNameProblem,
  localDotOrigin,
  localDotProblem,
  signInLink,
} from "../shell/local-dots.ts";
import type { OtherLocalDot } from "../shell/localdot-handoff.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { TextField } from "../ui/TextField.tsx";

// This browser signs in there in a new tab; the switcher later opens the same origin.
const signIn = (link: string | null) => {
  if (link) window.open(link, "_blank", "noopener");
};

function onEnter(save: () => void, cancel?: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape" && cancel) {
      // Handled here, so the Settings sheet stays open.
      event.preventDefault();
      cancel();
    }
  };
}

const LIST_MAX = 12;

// Why one this browser came from can't join the list every device shares, or undefined when it can.
function keepReason(url: string, links: readonly LocalDotLink[]): string | undefined {
  if (deviceOnly(url)) return "Its address works only on this device";
  if (links.length >= LIST_MAX) return "The list is full";
}

// What that localDot's dot wears there, once this browser has come from it.
const Look = ({ entry }: { entry?: OtherLocalDot }) => (
  <Dot size={24} wearables={outfit(entry?.persona, entry?.accessory)} />
);

// The user's other localDots, which the localDot menu opens: each by name at its own address. Those
// this browser has come from but the list doesn't have yet follow, to keep or forget.
export function OtherLocalDots({
  links,
  onChange,
  known = [],
  onForget = () => {},
}: {
  links: readonly LocalDotLink[];
  onChange(links: LocalDotLink[]): void;
  known?: readonly OtherLocalDot[];
  onForget?(url: string): void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [tried, setTried] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (returnTo) editButtons.current.get(returnTo)?.focus();
  }, [returnTo]);
  const problem = localDotProblem(address, links, window.location.origin);
  const nameProblem = localDotNameProblem(name);
  const add = () => {
    setTried(true);
    const link = localDotLink(name, address);
    const pasted = signInLink(address);
    // A fresh sign-in link for one already listed only signs in again.
    if (pasted && links.some((other) => other.url === localDotOrigin(address))) {
      signIn(pasted);
    } else {
      if (problem || nameProblem || !link) return;
      onChange([...links, link]);
      signIn(pasted);
    }
    setName("");
    setAddress("");
    setTried(false);
  };
  const close = (url: string) => {
    setEditing(null);
    setReturnTo(url);
  };
  return (
    <div>
      <GroupHead title="Your other localDots" />
      <Group>
        {links.map((link) =>
          link.url === editing ? (
            <LocalDotEditor
              key={link.url}
              link={link}
              links={links}
              onCancel={() => close(link.url)}
              onSave={(next) => {
                onChange(links.map((other) => (other.url === link.url ? next : other)));
                if (next.url !== link.url) onForget(link.url);
                close(next.url);
              }}
            />
          ) : (
            <GroupRow
              key={link.url}
              leading={<Look entry={known.find((entry) => entry.url === link.url)} />}
              label={link.name}
              detail={localDotHost(link.url)}
              trailing={
                <>
                  <Button
                    ref={(button) => {
                      if (button) editButtons.current.set(link.url, button);
                    }}
                    variant="quiet"
                    size="sm"
                    aria-label={`Edit ${link.name}`}
                    onClick={() => {
                      setReturnTo(null);
                      setEditing(link.url);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Remove ${link.name}`}
                    onClick={() => {
                      onChange(links.filter((other) => other.url !== link.url));
                      onForget(link.url);
                    }}
                  >
                    Remove
                  </Button>
                </>
              }
            />
          ),
        )}
        {known
          .filter((entry) => entry.browserOnly && !links.some((link) => link.url === entry.url))
          .map((entry) => (
            <GroupRow
              key={entry.url}
              leading={<Look entry={entry} />}
              label={entry.name}
              detail={`${localDotHost(entry.url)} · Only in this browser`}
              trailing={
                <>
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Keep ${entry.name} in the list`}
                    disabledReason={keepReason(entry.url, links)}
                    onClick={() => onChange([...links, { name: entry.name, url: entry.url }])}
                  >
                    Keep
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Forget ${entry.name}`}
                    onClick={() => onForget(entry.url)}
                  >
                    Forget
                  </Button>
                </>
              }
            />
          ))}
        {!editing && (
          <>
            <Field
              label="Name"
              inline
              className="ui-group-row"
              error={tried ? (nameProblem ?? undefined) : undefined}
            >
              <TextField
                size="sm"
                value={name}
                maxLength={40}
                placeholder="Office PC"
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={onEnter(add)}
              />
            </Field>
            <Field
              label="Address"
              inline
              className="ui-group-row"
              error={tried && address ? (problem ?? undefined) : undefined}
            >
              <TextField
                size="sm"
                value={address}
                maxLength={512}
                placeholder="office-pc.example.ts.net:4750"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="url"
                onChange={(event) => setAddress(event.target.value)}
                onKeyDown={onEnter(add)}
              />
            </Field>
            <GroupRow
              label="Add this localDot"
              trailing={
                <Button
                  size="sm"
                  disabledReason={address ? undefined : "Enter its address"}
                  onClick={add}
                >
                  Add
                </Button>
              }
            />
          </>
        )}
      </Group>
      <GroupNote>
        Switch to one from the localDot menu at the top left. Paste a sign-in link from that
        computer to sign this browser in there as you add it. A localDot you switch here from is
        listed in this browser too.
      </GroupNote>
    </div>
  );
}

// One entry's name and address, changed in place.
function LocalDotEditor({
  link,
  links,
  onSave,
  onCancel,
}: {
  link: LocalDotLink;
  links: readonly LocalDotLink[];
  onSave(link: LocalDotLink): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(link.name);
  const [address, setAddress] = useState(link.url);
  const [tried, setTried] = useState(false);
  const problem = localDotProblem(address, links, window.location.origin, link.url);
  const nameProblem = localDotNameProblem(name);
  const save = () => {
    setTried(true);
    const next = localDotLink(name, address);
    if (problem || nameProblem || !next) return;
    onSave(next);
    signIn(signInLink(address));
  };
  const keys = onEnter(save, onCancel);
  return (
    <>
      <Field
        label="Name"
        inline
        className="ui-group-row"
        error={tried ? (nameProblem ?? undefined) : undefined}
      >
        <TextField
          size="sm"
          value={name}
          maxLength={40}
          placeholder={localDotLink("", link.url)?.name}
          autoComplete="off"
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={keys}
        />
      </Field>
      <Field
        label="Address"
        inline
        className="ui-group-row"
        description="Changing the address means signing in again there."
        error={tried ? (problem ?? undefined) : undefined}
      >
        <TextField
          size="sm"
          value={address}
          maxLength={512}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="url"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={keys}
        />
      </Field>
      <GroupRow
        label={`Editing ${link.name}`}
        trailing={
          <>
            <Button variant="quiet" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={save}>
              Save
            </Button>
          </>
        }
      />
    </>
  );
}
