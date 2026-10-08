import type { AgentSettingsDocument } from "@localdot/protocol";
import { AutonomyPolicy } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyRecord } from "../keys/keys-api.ts";
import type { ApiClient } from "../lib/api.ts";
import {
  type ModelRole,
  matchingKeys,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import {
  loadProviderIndex,
  loadSettings,
  type ProviderIndex,
  refreshCatalog,
  SettingsFailure,
  saveSettings,
} from "./settings-api.ts";
import {
  formOf,
  type PriceDraft,
  pickerKeys,
  type SettingsDraft,
  sameDraft,
  validateForm,
} from "./settings-form.ts";
import { useChatgpt } from "./useChatgpt.ts";

type Phase = "loading" | "ready" | "refreshing" | "error";
export function useSettings(
  api: ApiClient,
  providedModels: readonly SubscriptionModel[] = [],
  accountVisible = true,
) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<AgentSettingsDocument | null>(null);
  const [index, setIndex] = useState<ProviderIndex | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const chatgpt = useChatgpt(
    api,
    open && accountVisible && draft?.choices.main?.provider === "chatgpt",
  );
  const subscriptionModels = providedModels.length ? providedModels : chatgpt.models;
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef({
    api,
    open: false,
    saved,
    index,
    draft,
    phase,
    revision: 0,
    generation: 0,
  });
  const reading = useRef<AbortController | null>(null);
  const mutating = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const unresolved = useRef(false);
  const writing = useRef(false);
  const blocked = useRef(false);
  const loadedFor = useRef<ApiClient | null>(null);
  useLayoutEffect(() => {
    Object.assign(current.current, { api, saved, index, draft, phase });
  }, [api, saved, index, draft, phase]);
  const read = useCallback(
    async (reset: boolean, reconcile = false) => {
      const owner = current.current;
      const generation = owner.generation,
        revision = owner.revision;
      reading.current?.abort();
      const abort = new AbortController();
      reading.current = abort;
      setPhase("loading");
      setError(null);
      if (reset) {
        owner.draft = null;
        setDraft(null);
      }
      try {
        const [nextSaved, nextIndex] = await Promise.all([
          loadSettings(api, abort.signal),
          loadProviderIndex(api, abort.signal),
        ]);
        if (
          !mounted.current ||
          abort.signal.aborted ||
          current.current.api !== api ||
          current.current.generation !== generation ||
          reading.current !== abort
        )
          return;
        owner.saved = nextSaved;
        owner.index = nextIndex;
        loadedFor.current = api;
        setSaved(nextSaved);
        setIndex(nextIndex);
        if (reset && owner.revision === revision) {
          owner.draft = formOf(nextSaved);
          setDraft(owner.draft);
        }
        if (reconcile && !mutating.current) {
          unresolved.current = false;
          setUncertain(false);
        }
        setPhase("ready");
        if (unresolved.current)
          setError(
            "A previous save is unverified. Reload saved settings explicitly before another save.",
          );
      } catch {
        if (
          !mounted.current ||
          abort.signal.aborted ||
          current.current.api !== api ||
          current.current.generation !== generation ||
          reading.current !== abort
        )
          return;
        setPhase("error");
        setError(
          owner.draft
            ? "Settings could not be loaded. Your edits are kept. Choose Try again."
            : "Settings could not be loaded. Check that localDot is running, then choose Try again.",
        );
      } finally {
        if (reading.current === abort) reading.current = null;
      }
    },
    [api],
  );
  useEffect(() => {
    mounted.current = true;
    current.current.api = api;
    current.current.generation++;
    if (loadedFor.current !== api) {
      unresolved.current = false;
      setUncertain(false);
    }
    void read(true);
    return () => {
      mounted.current = false;
      current.current.generation++;
      reading.current?.abort();
      mutating.current?.abort();
    };
  }, [api, read]);
  useEffect(() => {
    const suspend = () => {
      blocked.current = true;
      current.current.generation++;
      reading.current?.abort();
      if (writing.current) {
        unresolved.current = true;
        setUncertain(true);
      }
      mutating.current?.abort();
      setPhase("error");
      setError("The view was interrupted. Reload saved settings before continuing.");
    };
    // Coming back re-reads what the interruption discarded but keeps the draft, so switching apps
    // to copy a key never costs the user their choices.
    const visible = () => {
      if (document.hidden) return suspend();
      if (!blocked.current) return;
      blocked.current = false;
      if (mounted.current) void read(current.current.open && !current.current.draft);
    };
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [read]);
  const show = useCallback(() => {
    const owner = current.current;
    if (document.hidden || blocked.current) return;
    if (owner.open) return;
    owner.open = true;
    owner.generation++;
    owner.revision++;
    setOpen(true);
    void read(true);
  }, [read]);
  const close = useCallback(() => {
    const owner = current.current;
    owner.open = false;
    owner.generation++;
    owner.revision++;
    reading.current?.abort();
    if (writing.current) {
      unresolved.current = true;
      setUncertain(true);
    }
    mutating.current?.abort();
    owner.draft = null;
    setDraft(null);
    setError(null);
    setOpen(false);
  }, []);
  const edit = (next: SettingsDraft) => {
    const owner = current.current;
    if (!owner.open || !owner.draft || document.hidden || blocked.current) return;
    owner.revision++;
    owner.draft = next;
    setDraft(next);
    setError(null);
  };
  const change = (role: ModelRole, value: RoleChoice | undefined) => {
    const d = current.current.draft;
    if (!d) return;
    const choices = { ...d.choices },
      prices = { ...d.prices };
    const old = choices[role];
    if (!value) delete choices[role];
    else choices[role] = value;
    if (old?.provider !== value?.provider || old?.model !== value?.model) delete prices[role];
    edit({ ...d, choices, prices });
  };
  const changePrice = (role: ModelRole, price: PriceDraft) => {
    const d = current.current.draft;
    if (d) edit({ ...d, prices: { ...d.prices, [role]: price } });
  };
  const budget = (value: string, useDefault: boolean) => {
    const d = current.current.draft;
    if (d) edit({ ...d, budget: value, defaultBudget: useDefault });
  };
  const save = async () => {
    const owner = current.current,
      captured = owner.draft,
      previous = owner.saved;
    if (
      !owner.open ||
      chatgpt.isMutating() ||
      !captured ||
      !previous ||
      mutating.current ||
      unresolved.current ||
      document.hidden ||
      blocked.current ||
      owner.api !== api ||
      loadedFor.current !== api
    )
      return;
    const initial = validateForm(captured, previous, owner.index, subscriptionModels);
    if (!initial.ok) {
      setError(initial.problems.join(" "));
      return;
    }
    const revision = owner.revision,
      generation = owner.generation;
    const abort = new AbortController();
    mutating.current = abort;
    setBusy(true);
    setError(null);
    let sent = false;
    const live = () =>
      mounted.current &&
      current.current.api === api &&
      current.current.open &&
      current.current.generation === generation &&
      current.current.revision === revision &&
      current.current.draft === captured &&
      !document.hidden &&
      !blocked.current;
    try {
      const fresh = await loadProviderIndex(api, abort.signal);
      if (!live() || abort.signal.aborted) return;
      owner.index = fresh;
      setIndex(fresh);
      const checked = validateForm(captured, previous, fresh, subscriptionModels);
      if (!checked.ok) {
        setError(checked.problems.join(" "));
        return;
      }
      sent = true;
      writing.current = true;
      const next = await saveSettings(api, checked.document, abort.signal);
      if (!live() || abort.signal.aborted) {
        if (mounted.current && current.current.api === api) {
          unresolved.current = true;
          setUncertain(true);
        }
        return;
      }
      owner.saved = next;
      owner.draft = formOf(next);
      setSaved(next);
      setDraft(owner.draft);
      setError(null);
      setPhase("ready");
    } catch (failure) {
      const unknown = sent && (!(failure instanceof SettingsFailure) || failure.uncertain);
      if (unknown && current.current.api === api) {
        unresolved.current = true;
        if (mounted.current) setUncertain(true);
      }
      if (live())
        setError(
          unknown
            ? new SettingsFailure(true).message
            : "These settings could not be saved. Your edits are kept; check the choices and try again.",
        );
    } finally {
      if (mutating.current === abort) {
        mutating.current = null;
        writing.current = false;
        if (mounted.current) setBusy(false);
      }
      abort.abort();
    }
  };
  const refresh = async () => {
    const owner = current.current;
    if (!owner.open || mutating.current || document.hidden || blocked.current) return;
    if (owner.phase === "error") return read(!owner.draft);
    if (unresolved.current) return;
    const generation = owner.generation,
      revision = owner.revision;
    const abort = new AbortController();
    mutating.current = abort;
    setBusy(true);
    setPhase("refreshing");
    setError(null);
    try {
      await refreshCatalog(api, abort.signal);
      const next = await loadProviderIndex(api, abort.signal);
      if (
        mounted.current &&
        !abort.signal.aborted &&
        current.current.api === api &&
        owner.generation === generation
      ) {
        owner.index = next;
        setIndex(next);
        setPhase("ready");
        if (owner.revision !== revision)
          setError("Catalog refreshed. Review your current choices before saving.");
      }
    } catch {
      if (
        mounted.current &&
        !abort.signal.aborted &&
        current.current.api === api &&
        owner.generation === generation
      ) {
        setPhase("error");
        setError("The catalog could not be refreshed. Your choices are retained.");
      }
    } finally {
      if (mutating.current === abort) {
        mutating.current = null;
        if (mounted.current) setBusy(false);
      }
      abort.abort();
    }
  };
  const reload = () => {
    if (!mutating.current && !document.hidden && !blocked.current) {
      current.current.revision++;
      void read(true, true);
    }
  };
  const captureKey = (role: ModelRole, provider: string) => ({
    api,
    generation: current.current.generation,
    revision: current.current.revision,
    role,
    provider,
  });
  const keySaved = async (capture: ReturnType<typeof captureKey>, key: KeyRecord) => {
    const owner = current.current;
    if (
      capture.api !== api ||
      owner.api !== api ||
      !owner.open ||
      capture.generation !== owner.generation ||
      capture.revision !== owner.revision ||
      document.hidden ||
      blocked.current ||
      loadedFor.current !== api
    )
      return;
    const before = owner.index?.keys ?? [];
    try {
      const next = await loadProviderIndex(api);
      if (
        !mounted.current ||
        owner.api !== api ||
        !owner.open ||
        capture.generation !== owner.generation ||
        capture.revision !== owner.revision ||
        document.hidden ||
        blocked.current ||
        loadedFor.current !== api
      )
        return;
      owner.index = next;
      setIndex(next);
      const provider = providerById(capture.provider),
        d = owner.draft;
      if (!provider || !d || d.choices[capture.role]?.provider !== capture.provider) return;
      const newlyBound = matchingKeys(provider, pickerKeys(next)).filter(
        (row) => !before.some((old) => old.id === row.id),
      );
      if (newlyBound.length !== 1 || newlyBound[0]?.id !== key.id) return;
      change(capture.role, { ...(d.choices[capture.role] as RoleChoice), key: key.id });
    } catch {
      if (
        mounted.current &&
        owner.api === api &&
        owner.open &&
        capture.generation === owner.generation &&
        capture.revision === owner.revision &&
        !blocked.current &&
        !document.hidden
      )
        setError(
          "The key was saved, but current model key metadata could not be loaded. Choose its binding after reconnecting.",
        );
    }
  };
  const validation = draft && saved ? validateForm(draft, saved, index, subscriptionModels) : null;
  const accepted =
    saved && index ? validateForm(formOf(saved), saved, index, subscriptionModels) : null;
  return {
    open,
    show,
    close,
    saved,
    index,
    draft,
    phase,
    error,
    uncertain,
    busy: busy || !!chatgpt.busy,
    chatgpt,
    subscriptionModels,
    change,
    changePrice,
    changeAutonomy: (value: unknown) => {
      const parsed = AutonomyPolicy.safeParse(value),
        d = current.current.draft;
      if (parsed.success && d) edit({ ...d, autonomy: parsed.data });
    },
    budget,
    save,
    refresh,
    reload,
    captureKey,
    keySaved,
    dirty: !!draft && !!saved && !sameDraft(draft, formOf(saved)),
    validation: validation && !validation.ok ? validation.problems : null,
    saveEnabled:
      validation?.ok === true &&
      !busy &&
      !chatgpt.busy &&
      !uncertain &&
      phase === "ready" &&
      loadedFor.current === api,
    mainReady:
      (saved?.main?.provider !== "chatgpt" ||
        (chatgpt.canStart && chatgpt.models.some((model) => model.id === saved.main?.model))) &&
      accepted?.ok === true &&
      !uncertain &&
      phase === "ready" &&
      loadedFor.current === api,
  };
}
