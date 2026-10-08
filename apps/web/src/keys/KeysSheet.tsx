import {
  type ReactNode,
  type Ref,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Sheet } from "../ui/Sheet.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { KeyForm, type KeyFormPreset, type KeyIntake } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import type { KeyRecord } from "./keys-api.ts";
import { Protection } from "./Protection.tsx";
import type { KeysController } from "./useKeys.ts";
import "./keys.css";

export const KEYS_TITLE = "Keys";
export const KEYS_DESCRIPTION =
  "Your keys stay on this Mac. Apps in your computer get temporary access without seeing the real keys.";

const HELD = "Keys are held until the audit log works again";

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
  // A phone's sheet covers the page and its Stop, so it carries one, with what Stop reports.
  stop?: { readonly label: string; readonly enabled: boolean; run(): void };
  taskControls?: ReactNode;
}

function Section({
  title,
  children,
  ref,
}: {
  title: string;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  const id = useId();
  return (
    <section ref={ref} className="keys-section" aria-labelledby={id}>
      <h3 id={id} className="keys-section-title">
        {title}
      </h3>
      {children}
    </section>
  );
}

// Protection, the saved keys and the form that adds one: the Keys sheet's content, on its own
// sheet from the top bar or slid over Settings.
export function KeysPanel({
  active,
  keys,
  intakeRef,
  preset,
  onSaved,
  uses,
  onHolding,
  stop,
  taskControls,
}: KeysPanelProps) {
  const phone = useMediaQuery(PHONE);
  const [fresh, setFresh] = useState<{ id: string; at: number } | null>(null);
  const saves = useRef(0);
  const owner = useRef({ active, preset, onSaved, generation: 0 });
  const form = useRef<HTMLElement>(null);
  // Asked for a key for a provider, Keys starts at the form, past protection and the list.
  useLayoutEffect(() => {
    if (preset) form.current?.scrollIntoView?.({ block: "start" });
  }, [preset]);
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
  const health = keys.health;
  const offline = health?.online === false;
  const held = health?.online === true && health.audit?.ok === false;
  // Only the first list waits with a placeholder: a reload keeps the list it had.
  const loading =
    !health ||
    (health.online && keys.metadataReady === false && keys.keys.length === 0 && !keys.loadError);
  const unavailable = !health
    ? "Checking key protection"
    : offline
      ? "Key protection is off"
      : held
        ? HELD
        : undefined;
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

  return (
    <div id="keys-sheet" className="keys-body">
      {phone && (
        // What Stop reports stays after Stop itself has gone.
        <div className="keys-stop">
          {stop && (
            <div className="keys-inline">
              <p className="keys-note">Your computer</p>
              <Button
                icon="square"
                disabledReason={stop.enabled ? undefined : "Not available right now"}
                onClick={() => stop.run()}
              >
                {stop.label}
              </Button>
            </div>
          )}
          {active && taskControls}
        </div>
      )}
      <Section title="Protection">
        <Protection health={health} />
      </Section>
      <Section title="Your keys">
        {offline ? (
          <p className="keys-note">Your keys show here once key protection is back on.</p>
        ) : (
          <>
            {held && <p className="keys-note">{HELD}.</p>}
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
                  unavailable={held ? HELD : undefined}
                  busy={keys.busy}
                  uses={uses}
                  fresh={fresh}
                  remove={keys.remove}
                />
              </div>
            )}
          </>
        )}
      </Section>
      <Section ref={form} title="Add a key">
        <KeyForm
          intakeRef={intakeRef}
          active={active}
          unavailable={unavailable}
          busy={keys.busy}
          taken={keys.keys.map((key) => key.id)}
          preset={preset}
          onHolding={onHolding}
          save={save}
        />
      </Section>
    </div>
  );
}

export interface KeysSheetProps extends Omit<KeysPanelProps, "active" | "onHolding"> {
  open: boolean;
  onClose(): void;
}

// Keys on a sheet of its own, from the top bar or a key moved out of a message. Closing with a key
// typed asks first.
export function KeysSheet({ open, onClose, ...panel }: KeysSheetProps) {
  const [holding, setHolding] = useState(false);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      dirty={holding}
      title={KEYS_TITLE}
      description={KEYS_DESCRIPTION}
      closeLabel="Close keys"
    >
      <KeysPanel {...panel} active={open} onHolding={setHolding} />
    </Sheet>
  );
}
