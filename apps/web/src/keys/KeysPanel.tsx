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
import { KeyForm, type KeyFormPreset, type KeyIntake } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import { type KeydHealth, type KeyRecord, keyHome, vaultLocked } from "./keys-api.ts";
import { Protection } from "./Protection.tsx";
import type { KeysController } from "./useKeys.ts";
import "./keys.css";

export const keysDescription = (health: KeydHealth | null) =>
  `Your keys stay ${keyHome(health)}. Apps on your computer get stand-in keys and never see the real ones.`;

const HELD = "Keys are held until the audit log works again";
const LOCKED = "Saved keys are locked until you unlock them on the computer running localDot";

export interface KeysPanelProps {
  active: boolean;
  keys: KeysController;
  intakeRef?: Ref<KeyIntake>;
  preset?: KeyFormPreset;
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
  onSaved,
  uses,
  onHolding,
  reveal,
}: KeysPanelProps) {
  const phone = useMediaQuery(PHONE);
  const [fresh, setFresh] = useState<{ id: string; at: number } | null>(null);
  const [adding, setAdding] = useState(!!preset);
  const saves = useRef(0);
  const owner = useRef({ active, preset, onSaved, generation: 0 });
  const form = useRef<HTMLElement>(null);
  const intake = useRef<KeyIntake>(null);
  const revealing = useRef(reveal);
  revealing.current = reveal;
  const toReveal = useRef(!!preset);
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
    setAdding(true);
  }, [preset]);
  useLayoutEffect(() => {
    if (!toReveal.current || !form.current) return;
    toReveal.current = false;
    revealing.current?.(form.current);
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
        flushSync(() => setAdding(true));
        const taken = intake.current?.receive(source, provider) ?? false;
        source.value = "";
        return taken;
      },
    }),
    [],
  );
  const save = useCallback(
    async (binding: Parameters<KeysController["save"]>[0], value: string) => {
      const generation = owner.current.generation,
        request = owner.current.preset?.requestId;
      const result = await keys.save(binding, value);
      setFresh({ id: binding.id, at: ++saves.current });
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
  const add = (wide: boolean) => (
    <Button
      size={wide ? "xxl" : "sm"}
      icon="key-round"
      className={wide ? "keys-add-wide" : undefined}
      disabledReason={unavailable}
      onClick={() => {
        toReveal.current = true;
        flushSync(() => setAdding(true));
        form.current
          ?.querySelector<HTMLElement>("[role=combobox], input")
          ?.focus({ preventScroll: true });
      }}
    >
      {wide ? "Add a key" : "Add key"}
    </Button>
  );

  return (
    <div id="keys-sheet" className="keys-body">
      <p className="settings-lede">{keysDescription(health)}</p>
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
                />
              </div>
            )}
            {held && <GroupNote>{HELD}.</GroupNote>}
          </>
        )}
      </section>
      {formShown ? (
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
              onCancel={keys.keys.length ? () => setAdding(false) : undefined}
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
