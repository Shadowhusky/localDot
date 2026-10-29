import type { KeyMetadata } from "@localdot/protocol";
import {
  type Ref,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { GroupHead, GroupNote } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Skeleton } from "../ui/Skeleton.tsx";
import {
  type KeyField,
  KeyForm,
  type KeyFormPreset,
  type KeyIntake,
  savedLine,
} from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import { KeyMetadataEditor } from "./KeyMetadataEditor.tsx";
import { type KeydHealth, type KeyRecord, keyHome, vaultLocked } from "./keys-api.ts";
import { Protection } from "./Protection.tsx";
import { UNLOCK_PRIVACY, UnlockKeys } from "./UnlockKeys.tsx";
import type { KeysController } from "./useKeys.ts";
import "./keys.css";

export const keysDescription = (health: KeydHealth | null) =>
  `dot finds keys by name and purpose. Provider and custom API keys can be used when a task needs them; general keys are encrypted storage. The values stay ${keyHome(health)}. Service API charges follow the provider’s limits.`;

const HELD = "Keys are held until the audit log works again";
const LOCKED = "Saved keys are locked until you unlock them";

// What a passphrase vault is, said where it asks for its passphrase.
export const LOCKED_TEXT =
  "Your saved keys and passwords are kept in a file only your passphrase opens. They lock each time the computer running localDot restarts, and dot can't use them until you unlock them. Sites already signed in keep working.";
export const SETUP_TEXT =
  "The computer running localDot has no keyring, so your keys and passwords go in a file only this passphrase opens. You'll enter it after each restart; if you forget it, you'll add your keys again.";

export interface KeysPanelProps {
  active: boolean;
  keys: KeysController;
  intakeRef?: Ref<KeyIntake>;
  preset?: KeyFormPreset;
  // Asked from elsewhere (a task that stopped on it) to enter a saved key's value again.
  reenter?: { readonly requestId: number; readonly id: string };
  onSaved?(key: KeyRecord, requestId: number): void;
  // How many times this task has used each key.
  uses?: Readonly<Record<string, number>>;
  // Whether a typed key would be lost on leaving.
  onHolding?(holding: boolean): void;
  // Brings the form to the top of whatever scrolls the panel.
  reveal?(element: HTMLElement): void;
}

// Protection, the saved keys and, once asked for, the form that adds one: Settings' Keys section.
export function KeysPanel({
  active,
  keys,
  intakeRef,
  preset,
  reenter,
  onSaved,
  uses,
  onHolding,
  reveal,
}: KeysPanelProps) {
  const phone = useMediaQuery(PHONE);
  const [editing, setEditing] = useState<KeyRecord | null>(null);
  const [fresh, setFresh] = useState<{ id: string; at: number } | null>(null);
  const [adding, setAdding] = useState(!!preset);
  const [reentering, setReentering] = useState<string | null>(reenter?.id ?? null);
  // A save whose form then folds away (the first key, a key entered again) says so under the list.
  const [saved, setSaved] = useState<{ id: string; line: string } | null>(null);
  const field = useRef<KeyField>(null);
  const saves = useRef(0);
  const owner = useRef({ active, preset, onSaved, generation: 0 });
  const form = useRef<HTMLElement>(null);
  const editor = useRef<HTMLElement>(null);
  const editToReveal = useRef(false);
  const intake = useRef<KeyIntake>(null);
  const revealing = useRef(reveal);
  revealing.current = reveal;
  const toReveal = useRef(!!preset || !!reenter);
  const health = keys.health;
  const offline = health?.online === false;
  const held = health?.online === true && health.audit?.ok === false;
  const locked = vaultLocked(health);
  // Only the first list waits with a placeholder: a reload keeps the list it had.
  const loading =
    !health ||
    (health.online && keys.metadataReady === false && keys.keys.length === 0 && !keys.loadError);
  // With no key saved yet, the form is what the section is for.
  const formShown = adding || (!loading && keys.keys.length === 0);
  const unavailable = !health
    ? "Checking key protection"
    : offline
      ? "Key protection is off"
      : held
        ? HELD
        : locked
          ? LOCKED
          : undefined;

  // Asked for a key for a provider, Keys opens the form and brings it into view.
  useLayoutEffect(() => {
    if (!preset) return;
    toReveal.current = true;
    setReentering(null);
    setAdding(true);
  }, [preset]);
  useLayoutEffect(() => {
    if (!reenter) return;
    toReveal.current = true;
    setReentering(reenter.id);
  }, [reenter]);
  // A key changed outside localDot is never entered again under its changed destination.
  const again = reentering
    ? keys.keys.find((key) => key.id === reentering && !key.rebound)
    : undefined;
  const formOpen = formShown || !!again;
  useLayoutEffect(() => {
    if (formOpen) setSaved(null);
  }, [formOpen]);
  const savedNote =
    !formOpen && saved && keys.keys.some((key) => key.id === saved.id) ? saved.line : null;
  useLayoutEffect(() => {
    if (!toReveal.current || !form.current) return;
    toReveal.current = false;
    revealing.current?.(form.current);
  });
  useLayoutEffect(() => {
    if (!editToReveal.current || !editor.current) return;
    editToReveal.current = false;
    revealing.current?.(editor.current);
  });
  useLayoutEffect(
    () => () => {
      owner.current.active = false;
      owner.current.generation++;
    },
    [],
  );
  useLayoutEffect(() => {
    if (owner.current.active !== active || owner.current.preset !== preset)
      owner.current.generation++;
    Object.assign(owner.current, { active, preset, onSaved });
  }, [active, preset, onSaved]);
  // A key handed over from elsewhere opens the form first, so there is a field to take it.
  useImperativeHandle(
    intakeRef,
    () => ({
      receive(source, provider) {
        toReveal.current = true;
        flushSync(() => {
          setReentering(null);
          setAdding(true);
        });
        const taken = intake.current?.receive(source, provider) ?? false;
        source.value = "";
        return taken;
      },
    }),
    [],
  );
  const save = useCallback(
    async (
      binding: Parameters<KeysController["save"]>[0],
      value: string,
      metadata?: KeyMetadata,
    ) => {
      const generation = owner.current.generation,
        request = owner.current.preset?.requestId;
      const result = await keys.save(binding, value, ...(metadata ? [metadata] : []));
      setFresh({ id: binding.id, at: ++saves.current });
      if (owner.current.active && owner.current.generation === generation)
        setSaved({ id: binding.id, line: savedLine(binding.id, result.restart) });
      if (
        result.key &&
        request !== undefined &&
        owner.current.active &&
        owner.current.generation === generation &&
        owner.current.preset?.requestId === request
      )
        owner.current.onSaved?.(result.key, request);
      return result;
    },
    [keys.save],
  );
  // Stored again, the key leaves its form and lights up in the list.
  const saveAgain = useCallback(
    async (
      binding: Parameters<KeysController["save"]>[0],
      value: string,
      metadata?: KeyMetadata,
    ) => {
      const result = await save(binding, value, ...(metadata ? [metadata] : []));
      setReentering((now) => (now === binding.id ? null : now));
      return result;
    },
    [save],
  );
  const startReentry = (key: KeyRecord) => {
    toReveal.current = true;
    flushSync(() => setReentering(key.id));
    field.current?.focus();
  };
  const add = (wide: boolean) => (
    <Button
      size={wide ? "xxl" : "sm"}
      icon="key-round"
      className={wide ? "keys-add-wide" : undefined}
      disabledReason={unavailable}
      onClick={() => {
        toReveal.current = true;
        flushSync(() => {
          setReentering(null);
          setAdding(true);
        });
        form.current
          ?.querySelector<HTMLElement>("[role=combobox], input")
          ?.focus({ preventScroll: true });
      }}
    >
      {wide ? "Add a key" : "Add key"}
    </Button>
  );

  const setup = health?.vault?.state === "setup";
  return (
    <div id="keys-sheet" className="keys-body">
      <p className="settings-lede">{keysDescription(health)}</p>
      {locked && keys.unlock && (
        <section className="keys-section" aria-labelledby="keys-unlock-title">
          <GroupHead
            id="keys-unlock-title"
            title={setup ? "Choose a passphrase" : "Unlock your saved keys"}
          />
          <Card id="keys-unlock" className="keys-unlock">
            <p className="keys-unlock-text">{setup ? SETUP_TEXT : LOCKED_TEXT}</p>
            <UnlockKeys
              setup={setup}
              unlock={keys.unlock}
              label={setup ? "Choose a passphrase" : "Unlock saved keys"}
            />
            <p className="keys-unlock-note">{UNLOCK_PRIVACY}</p>
          </Card>
        </section>
      )}
      <Protection health={health} />
      <section className="keys-section" aria-labelledby="keys-yours">
        <GroupHead id="keys-yours" title="Your keys" aside={!phone && !formShown && add(false)} />
        {offline ? (
          <GroupNote>Your keys show here once key protection is back on.</GroupNote>
        ) : (
          <>
            {keys.loadError && (
              <p className="keys-note" data-alert="" role="alert">
                <Icon name="circle-alert" size={12} />
                <span>{keys.loadError}</span>
              </p>
            )}
            {loading ? (
              <Skeleton loading shape="block" width="100%" height="calc(var(--spacing) * 13)" />
            ) : (
              <div className="keys-saved" data-held={held ? "" : undefined}>
                <KeyList
                  active={active}
                  keys={keys.keys}
                  unavailable={held ? HELD : locked ? LOCKED : undefined}
                  busy={keys.busy}
                  uses={uses}
                  fresh={fresh}
                  remove={keys.remove}
                  reenter={startReentry}
                  edit={
                    keys.updateMetadata
                      ? (key) => {
                          if (editing?.id === key.id && editor.current) {
                            revealing.current?.(editor.current);
                            return;
                          }
                          editToReveal.current = true;
                          setEditing(key);
                        }
                      : undefined
                  }
                />
              </div>
            )}
            {savedNote && <GroupNote role="status">{savedNote}</GroupNote>}
            {held && <GroupNote>{HELD}.</GroupNote>}
          </>
        )}
      </section>
      {editing && keys.updateMetadata && (
        <section
          ref={editor}
          className="keys-section"
          aria-label={`Edit ${editing.metadata?.label || editing.id}`}
        >
          <KeyMetadataEditor
            key={editing.id}
            record={editing}
            save={keys.updateMetadata}
            close={() => setEditing(null)}
          />
        </section>
      )}
      {again ? (
        <section ref={form} className="keys-section" aria-labelledby="keys-reenter">
          <GroupHead id="keys-reenter" title={`Re-enter ${again.id}`} />
          <Card>
            <KeyForm
              key={again.id}
              fieldRef={field}
              active={active}
              unavailable={unavailable}
              busy={keys.busy}
              reenter={again}
              onHolding={onHolding}
              onCancel={() => setReentering(null)}
              save={saveAgain}
            />
          </Card>
        </section>
      ) : formShown ? (
        <section ref={form} className="keys-section" aria-labelledby="keys-add">
          <GroupHead id="keys-add" title="Add a key" />
          <Card>
            <KeyForm
              intakeRef={intake}
              active={active}
              unavailable={unavailable}
              busy={keys.busy}
              taken={keys.keys.map((key) => key.id)}
              preset={preset}
              onHolding={onHolding}
              onCancel={
                keys.keys.length
                  ? () => {
                      setAdding(false);
                      setSaved(null);
                    }
                  : undefined
              }
              save={save}
            />
          </Card>
        </section>
      ) : (
        phone && add(true)
      )}
    </div>
  );
}
