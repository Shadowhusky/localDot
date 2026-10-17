import {
  CLAUDE_PLAN_REFUSAL,
  claudePlanToken,
  type KeyMetadata,
  type SecretBinding,
} from "@localdot/protocol";
import {
  type FormEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../ui/Button.tsx";
import { Combobox } from "../ui/Combobox.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  baseURLHint,
  bindingOf,
  bindingOfRecord,
  type DraftCheck,
  type DraftField,
  destinationOf,
  EMPTY_DRAFT,
  FORMAT_NAMES,
  type HttpFormat,
  type KeyDraft,
  needsBaseURL,
  PROVIDER_GROUPS,
  PROVIDER_NAMES,
  type Provider,
  suggestedId,
  valueHint,
  valueProblem,
} from "./binding.ts";
import { type KeyRecord, lockedVaultError, problemText } from "./keys-api.ts";

export interface KeyFormProps {
  active: boolean;
  // Why no key can be saved now: key protection is off, or it is holding keys back.
  unavailable?: string;
  // A key change is in flight, from this form or from the list.
  busy?: boolean;
  // The labels already saved, so one made up for a new key is new.
  taken?: readonly string[];
  save(
    binding: SecretBinding,
    value: string,
    metadata?: KeyMetadata,
  ): Promise<{ restart: boolean }>;
  intakeRef?: Ref<KeyIntake>;
  fieldRef?: Ref<KeyField>;
  preset?: KeyFormPreset;
  // Whether the key field holds a key, each time that may have changed; never the key.
  onHolding?(holding: boolean): void;
  // Offers Cancel, which clears the form, then calls this.
  onCancel?(): void;
  // A saved key whose value is stored again, under the same name and destination: only the key
  // itself is asked for.
  reenter?: KeyRecord;
}
export type KeyFormPreset =
  | { readonly requestId: number; readonly provider: Provider; readonly baseURL?: string }
  // A web API key with its host and header filled in, such as Jev's.
  | {
      readonly requestId: number;
      readonly web: Pick<KeyDraft, "id" | "hosts" | "header" | "format">;
    };
export interface KeyIntake {
  // A synchronous one-shot DOM handoff, never a secret string prop or deferred queue.
  receive(source: HTMLInputElement, provider?: Provider): boolean;
}
export interface KeyField {
  holdsKey(): boolean;
  focus(): void;
}

type Problem = { field: DraftField | "form"; message: string };

const KINDS = [
  { value: "llm", label: "Model & service" },
  { value: "http", label: "Custom service" },
];

const PROVIDER_PICKS = PROVIDER_GROUPS.map((group) => ({
  label: group.label,
  items: group.providers.map((provider) => ({ value: provider, label: PROVIDER_NAMES[provider] })),
}));

const FORMAT_PICKS = Object.entries(FORMAT_NAMES).map(([value, label]) => ({ value, label }));

// Labels, hosts, addresses and headers go as typed: no capitals, corrections or spelling marks.
const PLAIN = {
  autoComplete: "off",
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

function clipboardReadable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";
}

export const savedLine = (id: string, restart: boolean) =>
  restart ? `Saved ${id}. Restart your computer to use it there.` : `Saved ${id}.`;

// The key itself lives only in the key field's DOM value (never in React state): it is read
// on submit, the field is cleared at once, and the page sends keyd's sealed copy.
export function KeyForm({
  active,
  unavailable,
  busy = false,
  taken = [],
  save,
  intakeRef,
  fieldRef,
  preset,
  onHolding,
  onCancel,
  reenter,
}: KeyFormProps) {
  const statusId = useId();
  const [metadata, setMetadata] = useState<KeyMetadata>({});
  // Side by side, Header and Sent as each keep a line for an error, so the pair stays level.
  const paired = !useMediaQuery(PHONE);
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const intakeBlocked = useRef(false);
  const intakeAllowed = useRef(false);
  const revision = useRef(0);
  const lifetime = useRef(0);
  const mounted = useRef(false);
  const previousActive = useRef(active);
  const holding = useRef(onHolding);
  holding.current = onHolding;
  const locked = Boolean(unavailable) || busy;
  const report = () => holding.current?.(!!valueRef.current?.value);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current++;
      holding.current?.(false);
    };
  }, []);
  useLayoutEffect(() => {
    if (previousActive.current !== active) {
      lifetime.current++;
      previousActive.current = active;
    }
  }, [active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new preset resets the form
  useLayoutEffect(() => {
    if (!preset) return;
    if ("provider" in preset && !Object.hasOwn(PROVIDER_NAMES, preset.provider)) return;
    if (valueRef.current) valueRef.current.value = "";
    report();
    revision.current++;
    setDraft(
      "web" in preset
        ? { ...EMPTY_DRAFT, ...preset.web, kind: "http" }
        : {
            ...EMPTY_DRAFT,
            kind: "llm",
            provider: preset.provider,
            baseURL: preset.baseURL ?? "",
          },
    );
    setProblem(null);
    setSaved(null);
    setTried(false);
  }, [preset]);
  // A key typed stays through another key's change, read-only meanwhile; closing or an outage clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: report reads refs only
  useLayoutEffect(() => {
    if ((!active || unavailable) && valueRef.current?.value) {
      valueRef.current.value = "";
      report();
    }
    intakeAllowed.current = active && !locked;
    intakeBlocked.current = !active || document.hidden;
  }, [active, unavailable, locked]);
  useImperativeHandle(
    intakeRef,
    () => ({
      receive(source, provider) {
        const target = valueRef.current;
        let value = source.value;
        let received = false;
        source.value = "";
        try {
          if (target) target.value = "";
          if (
            !target?.isConnected ||
            !intakeAllowed.current ||
            savingRef.current ||
            intakeBlocked.current ||
            document.hidden ||
            valueProblem(value)
          )
            return false;
          if (provider && !Object.hasOwn(PROVIDER_NAMES, provider)) return false;
          if (provider) {
            revision.current++;
            setDraft((draft) => ({ ...draft, kind: "llm", provider, baseURL: "" }));
          }
          setProblem(null);
          setSaved(null);
          target.value = value;
          target.focus();
          // Focus handlers may synchronously close or hide the form during the handoff.
          if (
            !intakeAllowed.current ||
            intakeBlocked.current ||
            document.hidden ||
            !target.isConnected ||
            target.value !== value
          )
            return false;
          received = true;
          return true;
        } finally {
          value = "";
          source.value = "";
          if (!received && target) target.value = "";
          holding.current?.(!!target?.value);
        }
      },
    }),
    [],
  );
  useImperativeHandle(
    fieldRef,
    () => ({
      holdsKey: () => !!valueRef.current?.value,
      focus: () => valueRef.current?.focus(),
    }),
    [],
  );
  useEffect(() => {
    const input = valueRef.current;
    const clear = () => {
      if (input) input.value = "";
      intakeBlocked.current = true;
      lifetime.current++;
      holding.current?.(false);
    };
    const onVisibility = () => {
      if (document.hidden) clear();
      else intakeBlocked.current = false;
    };
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", onVisibility);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", onVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const label = draft.id.trim() || suggestedId(draft, taken);
  const again = reenter && bindingOfRecord(reenter);
  const check: DraftCheck = !reenter
    ? bindingOf({ ...draft, id: label })
    : again
      ? { ok: true, binding: again }
      : {
          ok: false,
          field: "value",
          message: "This key can't be entered again here. Remove it, then add it again.",
        };
  const hint = reenter
    ? valueHint({ ...draft, kind: reenter.kind, provider: reenter.provider as Provider })
    : valueHint(draft);
  const urlHint = draft.kind === "llm" ? baseURLHint(draft.provider) : undefined;
  const shown: Problem | null = problem ?? (tried && !check.ok ? check : null);
  const set = (patch: Partial<KeyDraft>) => {
    revision.current++;
    setDraft((d) => ({ ...d, ...patch }));
    setProblem(null);
    setSaved(null);
  };
  // A plan refusal wipes the field as it appears, so it is announced. A fresh node per message is
  // read even when it replaces another error.
  const errorFor = (field: DraftField) =>
    shown?.field === field ? (
      <span key={shown.message} role={shown.message === CLAUDE_PLAN_REFUSAL ? "alert" : undefined}>
        {shown.message}
      </span>
    ) : undefined;

  const paste = async () => {
    const target = valueRef.current;
    if (!target || !intakeAllowed.current || savingRef.current || intakeBlocked.current) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setProblem({
        field: "value",
        message: "The browser kept what you copied to itself. Paste into the field instead.",
      });
      return;
    }
    try {
      const value = text.trim();
      if (
        !value ||
        !target.isConnected ||
        !intakeAllowed.current ||
        savingRef.current ||
        intakeBlocked.current ||
        document.hidden
      )
        return;
      setSaved(null);
      if (claudePlanToken(value)) {
        target.value = "";
        setProblem({ field: "value", message: CLAUDE_PLAN_REFUSAL });
        return;
      }
      target.value = value;
      setProblem((now) => (now?.field === "value" ? null : now));
      target.focus();
    } finally {
      text = "";
      report();
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = valueRef.current;
    if (!input) return;
    if (!intakeAllowed.current || savingRef.current || intakeBlocked.current || document.hidden) {
      input.value = "";
      report();
      return;
    }
    setTried(true);
    setSaved(null);
    const value = input.value.trim();
    // Clear before any callback, including one that throws synchronously.
    input.value = "";
    report();
    // Refused for itself first: fixing another field would not make a plan token usable.
    if (claudePlanToken(value)) {
      setProblem({ field: "value", message: CLAUDE_PLAN_REFUSAL });
      return;
    }
    if (!check.ok) {
      setProblem({
        ...check,
        message: value
          ? `${check.message} Paste the key again after correcting it.`
          : check.message,
      });
      return;
    }
    const bad = valueProblem(value);
    if (bad) {
      setProblem({ field: "value", message: bad });
      return;
    }
    savingRef.current = true;
    const capturedRevision = revision.current,
      capturedLifetime = lifetime.current;
    const current = () =>
      mounted.current &&
      active &&
      !intakeBlocked.current &&
      !document.hidden &&
      revision.current === capturedRevision &&
      lifetime.current === capturedLifetime;
    setSaving(true);
    try {
      const details = reenter?.metadata ?? metadata;
      const { restart } = await save(
        check.binding,
        value,
        ...(Object.values(details).some(Boolean) ? [details] : []),
      );
      if (!current()) return;
      const id = check.binding.id;
      setDraft((d) => ({ ...d, id: "", baseURL: "", hosts: "" }));
      setTried(false);
      setMetadata({});
      setSaved(savedLine(id, restart));
    } catch (err) {
      if (!current()) return;
      setProblem({
        field: "form",
        message: lockedVaultError(err)
          ? `${problemText(err)}, then paste the key again.`
          : `${problemText(err)} Paste the key again to retry.`,
      });
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const readOnly = locked || saving;
  const typed = draft.id.trim();
  return (
    <form
      className="keys-form"
      onSubmit={submit}
      noValidate
      aria-label={reenter ? `Re-enter ${reenter.id}` : "Add a key"}
      aria-busy={saving}
      autoComplete="off"
    >
      {reenter ? (
        <p className="keys-reenter-note">
          <Icon name="lock" size={14} />
          <span>
            Sent only to <span className="keys-reenter-to">{destinationOf(reenter)}</span>, as
            before. Its name and everything that uses it stay the same.
          </span>
        </p>
      ) : (
        <>
          <Field label="Name" description="A clear label helps dot choose the right key.">
            <TextField
              value={metadata.label ?? ""}
              readOnly={readOnly}
              maxLength={80}
              placeholder="e.g. Studio production"
              onChange={(e) => setMetadata({ ...metadata, label: e.target.value })}
            />
          </Field>
          <SegmentedControl
            aria-label="Kind of key"
            items={KINDS}
            value={draft.kind}
            onValueChange={(kind) => set({ kind: kind as KeyDraft["kind"] })}
          />
          {draft.kind === "llm" ? (
            <>
              <Field label="Provider">
                <Combobox
                  value={draft.provider}
                  groups={PROVIDER_PICKS}
                  searchPlaceholder="Search providers"
                  onValueChange={(provider) => set({ provider: provider as Provider })}
                />
              </Field>
              {needsBaseURL(draft.provider) && (
                <Field label="Base URL" description={urlHint} error={errorFor("baseURL")}>
                  <TextField
                    {...PLAIN}
                    value={draft.baseURL}
                    readOnly={readOnly}
                    inputMode="url"
                    enterKeyHint="next"
                    placeholder={
                      draft.provider === "anthropic-compatible"
                        ? "e.g. https://api.example.com/anthropic"
                        : "e.g. https://api.example.com/v1"
                    }
                    onChange={(e) => set({ baseURL: e.target.value })}
                  />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field
                label="Hosts"
                description="The key goes to these hosts only. Separate several with commas."
                error={errorFor("hosts")}
              >
                <TextField
                  {...PLAIN}
                  value={draft.hosts}
                  readOnly={readOnly}
                  inputMode="url"
                  enterKeyHint="next"
                  placeholder="e.g. api.example.com"
                  onChange={(e) => set({ hosts: e.target.value })}
                />
              </Field>
              <div className="keys-pair">
                <Field label="Header" error={errorFor("header")} validates={paired}>
                  <TextField
                    {...PLAIN}
                    value={draft.header}
                    readOnly={readOnly}
                    enterKeyHint="next"
                    placeholder="e.g. Authorization"
                    onChange={(e) => set({ header: e.target.value })}
                  />
                </Field>
                <Field label="Sent as" validates={paired}>
                  <Select
                    value={draft.format}
                    items={FORMAT_PICKS}
                    onValueChange={(format) => set({ format: format as HttpFormat })}
                  />
                </Field>
              </div>
            </>
          )}
          <Field
            label="Service (optional)"
            description="Any service or provider, including one not listed above."
          >
            <TextField
              value={metadata.service ?? ""}
              readOnly={readOnly}
              maxLength={80}
              placeholder="e.g. My company API"
              onChange={(e) => setMetadata({ ...metadata, service: e.target.value })}
            />
          </Field>
          <Field
            label="Use for (optional)"
            description="Tell dot what this key can do. Describe its purpose or account; never paste secrets here."
          >
            <TextField
              value={metadata.description ?? ""}
              readOnly={readOnly}
              maxLength={600}
              placeholder="e.g. Search our catalog and read product details"
              onChange={(e) => setMetadata({ ...metadata, description: e.target.value })}
            />
          </Field>
          <Field
            label="Key ID (optional)"
            description={
              typed && taken.includes(typed)
                ? "Saving replaces the key with this ID."
                : "A short name for tools and scripts. Leave blank to create one."
            }
            error={errorFor("id")}
          >
            <TextField
              {...PLAIN}
              value={draft.id}
              readOnly={readOnly}
              enterKeyHint="next"
              placeholder={label}
              onChange={(e) => set({ id: e.target.value })}
            />
          </Field>
        </>
      )}
      <Field
        label="Key"
        description={
          hint ? (
            <>
              Starts with <code className="keys-code">{hint}</code>
            </>
          ) : undefined
        }
        error={errorFor("value")}
        disabledReason={unavailable}
      >
        {/* A text field drawn as dots: Chrome offers to save a password field's value to the
          user's synced password manager, autocomplete="off" or not. */}
        <TextField
          ref={valueRef}
          {...PLAIN}
          className="keys-secret"
          readOnly={saving || busy}
          enterKeyHint="done"
          data-1p-ignore="true"
          data-lpignore="true"
          suffix={
            clipboardReadable() ? (
              <IconButton
                icon="clipboard-paste"
                label="Paste key"
                size={24}
                disabledReason={unavailable}
                onClick={() => void paste()}
              />
            ) : undefined
          }
          onFocus={() => {
            // Problems with the label or where the key goes show before the key is pasted.
            if (!check.ok && check.field !== "value") setTried(true);
          }}
          onChange={(e) => {
            if (claudePlanToken(e.currentTarget.value)) {
              e.currentTarget.value = "";
              setProblem({ field: "value", message: CLAUDE_PLAN_REFUSAL });
            } else if (problem?.field === "value") setProblem(null);
            report();
          }}
        />
      </Field>
      <div className="keys-form-actions">
        <div id={statusId} className="keys-form-status">
          {shown?.field === "form" ? (
            <p className="keys-form-error" role="alert">
              <Icon name="circle-alert" size={12} />
              <span>{shown.message}</span>
            </p>
          ) : (
            saved && <p role="status">{saved}</p>
          )}
        </div>
        {onCancel && (
          <Button
            variant="quiet"
            disabledReason={saving ? "Wait for the key to save" : undefined}
            onClick={() => {
              if (valueRef.current) valueRef.current.value = "";
              report();
              revision.current++;
              setDraft(EMPTY_DRAFT);
              setProblem(null);
              setSaved(null);
              setTried(false);
              onCancel();
            }}
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          busy={saving}
          disabledReason={
            saving
              ? undefined
              : (unavailable ?? (busy ? "Wait for the other key change to finish" : undefined))
          }
          aria-describedby={statusId}
        >
          Save key
        </Button>
      </div>
    </form>
  );
}
