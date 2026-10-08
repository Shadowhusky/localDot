import { CLAUDE_PLAN_REFUSAL, claudePlanToken, type SecretBinding } from "@localdot/protocol";
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
import {
  bindingOf,
  type DraftField,
  EMPTY_DRAFT,
  FORMAT_NAMES,
  type HttpFormat,
  type KeyDraft,
  needsBaseURL,
  PROVIDER_NAMES,
  type Provider,
  valueHint,
  valueProblem,
} from "./binding.ts";
import { problemText } from "./keys-api.ts";

export interface KeyFormProps {
  active: boolean;
  disabled: boolean;
  save(binding: SecretBinding, value: string): Promise<{ restart: boolean }>;
  intakeRef?: Ref<KeyIntake>;
  fieldRef?: Ref<KeyField>;
  preset?: KeyFormPreset;
}
export interface KeyFormPreset {
  readonly requestId: number;
  readonly provider: Provider;
  readonly baseURL?: string;
}
export interface KeyIntake {
  // A synchronous one-shot DOM handoff, never a secret string prop or deferred queue.
  receive(source: HTMLInputElement, provider?: Provider): boolean;
}
export interface KeyField {
  holdsKey(): boolean;
  focus(): void;
}

type Problem = { field: DraftField | "form"; message: string };

// The key itself lives only in the key field's DOM value (never in React state): it is read
// on submit, the field is cleared at once, and the page sends keyd's sealed copy.
export function KeyForm({ active, disabled, save, intakeRef, fieldRef, preset }: KeyFormProps) {
  const labels = useId();
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current++;
    };
  }, []);
  useLayoutEffect(() => {
    if (previousActive.current !== active) {
      lifetime.current++;
      previousActive.current = active;
    }
  }, [active]);
  useLayoutEffect(() => {
    if (!preset || !Object.hasOwn(PROVIDER_NAMES, preset.provider)) return;
    if (valueRef.current) valueRef.current.value = "";
    revision.current++;
    setDraft({
      ...EMPTY_DRAFT,
      kind: "llm",
      provider: preset.provider,
      baseURL: preset.baseURL ?? "",
    });
    setProblem(null);
    setSaved(null);
    setTried(false);
  }, [preset]);
  useLayoutEffect(() => {
    if ((!active || disabled) && valueRef.current) valueRef.current.value = "";
    intakeAllowed.current = active && !disabled;
    intakeBlocked.current = !active || document.hidden;
  }, [active, disabled]);
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
  const check = bindingOf(draft);
  const hint = valueHint(draft);
  const shown: Problem | null = problem ?? (tried && !check.ok ? check : null);
  const set = (patch: Partial<KeyDraft>) => {
    revision.current++;
    setDraft((d) => ({ ...d, ...patch }));
    setProblem(null);
    setSaved(null);
  };
  const errorFor = (field: DraftField) =>
    shown?.field === field ? (
      // A plan refusal wipes the field as it appears, so it is announced. A fresh node per
      // message is read even when it replaces another error.
      <p
        key={shown.message}
        className="field-error"
        id={`key-${field}-error`}
        role={shown.message === CLAUDE_PLAN_REFUSAL ? "alert" : undefined}
      >
        {shown.message}
      </p>
    ) : null;
  const invalid = (field: DraftField) =>
    shown?.field === field
      ? { "aria-invalid": true, "aria-describedby": `key-${field}-error` }
      : {};

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const input = valueRef.current;
    if (!input) return;
    if (!intakeAllowed.current || savingRef.current || intakeBlocked.current || document.hidden) {
      input.value = "";
      return;
    }
    setTried(true);
    setSaved(null);
    const value = input.value.trim();
    // Clear before any callback, including one that throws synchronously.
    input.value = "";
    // Refused for itself first: fixing another field would not make a plan token usable.
    if (claudePlanToken(value)) {
      setProblem({ field: "value", message: CLAUDE_PLAN_REFUSAL });
      return;
    }
    if (!check.ok) {
      setProblem({
        ...check,
        message: `${check.message} Paste the key again after correcting it.`,
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
    setBusy(true);
    try {
      const { restart } = await save(check.binding, value);
      if (!current()) return;
      const id = check.binding.id;
      setDraft((d) => ({ ...d, id: "", baseURL: "", hosts: "" }));
      setTried(false);
      setSaved(restart ? `Saved ${id}. Restart your computer to use it there.` : `Saved ${id}.`);
    } catch (err) {
      if (!current()) return;
      setProblem({ field: "form", message: `${problemText(err)} Paste the key again to retry.` });
    } finally {
      savingRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <form
      className="key-form"
      onSubmit={submit}
      noValidate
      aria-label="Add a key"
      aria-busy={busy}
      autoComplete="off"
    >
      <h3>Add a key</h3>
      <fieldset className="key-fields" disabled={!active || disabled || busy}>
        <legend className="sr-only">Key details</legend>
        <fieldset className="kinds">
          <legend className="sr-only">Kind of key</legend>
          <button
            type="button"
            className="kind"
            aria-pressed={draft.kind === "llm"}
            onClick={() => set({ kind: "llm" })}
          >
            Model provider
          </button>
          <button
            type="button"
            className="kind"
            aria-pressed={draft.kind === "http"}
            onClick={() => set({ kind: "http" })}
          >
            Web API
          </button>
        </fieldset>
        <label>
          <span>Name</span>
          <input
            value={draft.id}
            onChange={(e) => set({ id: e.target.value })}
            placeholder={draft.kind === "llm" ? "anthropic" : "weather"}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            {...invalid("id")}
          />
        </label>
        {errorFor("id")}
        {draft.kind === "llm" ? (
          <>
            <label>
              <span id={`${labels}-provider`}>Provider</span>
              <select
                aria-labelledby={`${labels}-provider`}
                value={draft.provider}
                onChange={(e) => set({ provider: e.target.value as Provider })}
              >
                {Object.entries(PROVIDER_NAMES).map(([p, name]) => (
                  <option key={p} value={p}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {needsBaseURL(draft.provider) && (
              <>
                <label>
                  <span>Base URL</span>
                  <input
                    value={draft.baseURL}
                    onChange={(e) => set({ baseURL: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    inputMode="url"
                    {...invalid("baseURL")}
                  />
                </label>
                {errorFor("baseURL")}
              </>
            )}
          </>
        ) : (
          <>
            <label>
              <span>Hosts</span>
              <input
                value={draft.hosts}
                onChange={(e) => set({ hosts: e.target.value })}
                placeholder="api.example.com"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                {...invalid("hosts")}
              />
            </label>
            {errorFor("hosts")}
            <div className="pair">
              <label>
                <span>Header</span>
                <input
                  value={draft.header}
                  onChange={(e) => set({ header: e.target.value })}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  {...invalid("header")}
                />
              </label>
              <label>
                <span id={`${labels}-format`}>Sent as</span>
                <select
                  aria-labelledby={`${labels}-format`}
                  value={draft.format}
                  onChange={(e) => set({ format: e.target.value as HttpFormat })}
                >
                  {Object.entries(FORMAT_NAMES).map(([f, name]) => (
                    <option key={f} value={f}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {errorFor("header")}
          </>
        )}
        <label>
          <span>Key</span>
          {/* A text field drawn as dots: Chrome offers to save a password field's value to the
            user's synced password manager, autocomplete="off" or not. */}
          <input
            ref={valueRef}
            type="text"
            className="secret"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            onChange={(e) => {
              if (claudePlanToken(e.currentTarget.value)) {
                e.currentTarget.value = "";
                setProblem({ field: "value", message: CLAUDE_PLAN_REFUSAL });
              } else if (problem?.field === "value") setProblem(null);
            }}
            aria-invalid={shown?.field === "value" || undefined}
            aria-describedby={
              [shown?.field === "value" && "key-value-error", hint && "key-value-hint"]
                .filter(Boolean)
                .join(" ") || undefined
            }
          />
        </label>
        {hint && (
          <p className="field-hint" id="key-value-hint">
            Starts with <code>{hint}</code>
          </p>
        )}
        {errorFor("value")}
        {shown?.field === "form" && (
          <p className="field-error" role="alert">
            {shown.message}
          </p>
        )}
        <button type="submit" className="save" disabled={!active || disabled || busy}>
          {busy ? "Saving…" : "Save key"}
        </button>
      </fieldset>
      {saved && (
        <p className="keys-note" role="status">
          {saved}
        </p>
      )}
    </form>
  );
}
