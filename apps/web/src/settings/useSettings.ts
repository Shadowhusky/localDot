import type { AgentSettingsDocument, PersonaId } from "@localdot/protocol";
import { AutonomyPolicy } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyRecord } from "../keys/keys-api.ts";
import type { ApiClient } from "../lib/api.ts";
import {
  type ModelRole,
  matchingKeys,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import { beside, fastBeside } from "./chooser.ts";
import {
  loadProviderIndex,
  loadSettings,
  type ProviderIndex,
  refreshCatalog,
  SettingsFailure,
  saveSettings,
} from "./settings-api.ts";
import {
  type CheckInKey,
  type CheckInsDraft,
  formOf,
  type PriceDraft,
  pickerKeys,
  type ResearchDraft,
  type SettingsDraft,
  type SpendingDraft,
  sameDraft,
  sameSettingsValue,
  validateForm,
} from "./settings-form.ts";
import { useChatgpt } from "./useChatgpt.ts";
import { useClaudeCode } from "./useClaudeCode.ts";

type Phase = "loading" | "ready" | "refreshing" | "error";
const NO_MODELS: readonly SubscriptionModel[] = [];

export function useSettings(
  api: ApiClient,
  providedModels: readonly SubscriptionModel[] = NO_MODELS,
  accountVisible = true,
) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<AgentSettingsDocument | null>(null);
  const [index, setIndex] = useState<ProviderIndex | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  // Both accounts are read once the user looks over the models they can switch to.
  const [browsing, setBrowsing] = useState(false);
  // Each account is read while it is chosen or saved, so the app knows whether a task can start on
  // it rather than taking a status not yet read for one that says no.
  const chatgpt = useChatgpt(
    api,
    (open && accountVisible && draft?.choices.main?.provider === "chatgpt") ||
      saved?.main?.provider === "chatgpt" ||
      browsing,
  );
  const claudeCode = useClaudeCode(
    api,
    (open && draft?.choices.main?.provider === "claude-code") ||
      saved?.main?.provider === "claude-code" ||
      browsing,
  );
  const subscriptionModels = providedModels.length
    ? providedModels
    : draft?.choices.main?.provider === "claude-code"
      ? claudeCode.models
      : chatgpt.models;
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
    session: 0,
  });
  const reading = useRef<AbortController | null>(null);
  const mutating = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const unresolved = useRef(false);
  const writing = useRef(false);
  const blocked = useRef(false);
  const failed = useRef<"read" | "refresh">("read");
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
          loadProviderIndex(api, abort.signal, loadedFor.current !== api),
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
        failed.current = "read";
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
    current.current.session++;
    if (loadedFor.current !== api) {
      unresolved.current = false;
      setUncertain(false);
    }
    void read(true);
    return () => {
      mounted.current = false;
      current.current.generation++;
      current.current.session++;
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
      failed.current = "read";
      setPhase("error");
      setError("The view was interrupted. Reload saved settings before continuing.");
    };
    // Coming back re-reads what the interruption discarded but keeps the draft, so switching apps
    // to copy a key never costs the user their choices.
    const visible = () => {
      if (document.hidden) return;
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
  const checkingModels = useRef(false);
  const checkModels = useCallback(async () => {
    if (
      !mounted.current ||
      document.hidden ||
      blocked.current ||
      reading.current ||
      mutating.current ||
      checkingModels.current
    )
      return;
    const generation = current.current.generation;
    const abort = new AbortController();
    checkingModels.current = true;
    try {
      const next = await loadProviderIndex(api, abort.signal);
      if (
        !mounted.current ||
        document.hidden ||
        blocked.current ||
        current.current.api !== api ||
        current.current.generation !== generation ||
        reading.current ||
        mutating.current
      )
        return;
      current.current.index = next;
      setIndex(next);
    } catch {
      // Keep the last verified list and all unsaved choices through an outage.
    } finally {
      checkingModels.current = false;
    }
  }, [api]);
  useEffect(() => {
    const timer = window.setInterval(
      () => void checkModels(),
      index?.catalog?.refreshing ? 2000 : 60_000,
    );
    return () => window.clearInterval(timer);
  }, [checkModels, index?.catalog?.refreshing]);
  const show = useCallback(() => {
    const owner = current.current;
    if (document.hidden || blocked.current) return;
    if (owner.open) return;
    owner.open = true;
    owner.generation++;
    owner.session++;
    owner.revision++;
    setOpen(true);
    void read(true);
  }, [read]);
  const close = useCallback(() => {
    const owner = current.current;
    owner.open = false;
    owner.generation++;
    owner.session++;
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
    let models = d.models;
    if (old && value && (old.provider !== value.provider || old.model !== value.model)) {
      const checked = validateForm(
        d,
        current.current.saved ?? {},
        current.current.index,
        subscriptionModels,
      );
      const previous = checked.ok ? checked.document[role] : undefined;
      // Merely visiting another provider must not add the saved choice to history.
      // It is already available for restoration, and duplicating it makes a round trip dirty.
      const known = [
        current.current.saved?.[role],
        ...(models ?? []),
        ...(current.current.saved?.models ?? []),
      ];
      if (previous && !known.some((choice) => sameSettingsValue(choice, previous))) {
        models = [
          ...(models ?? []).filter(
            (model) =>
              model.provider !== previous.provider ||
              model.model !== previous.model ||
              model.key !== previous.key,
          ),
          previous,
        ].slice(-100);
      }
    }
    const main = choices.main;
    if (
      role === "fast" &&
      value &&
      main &&
      old?.provider !== value.provider &&
      beside(main, value)
    ) {
      // The main model's own provider: its key and format, and a model to start from rather than
      // whatever was chosen there last.
      delete prices[role];
      value = fastBeside(
        main,
        current.current.index?.providers.find((row) => row.id === main.provider)?.models ?? [],
        subscriptionModels,
        [...(current.current.saved?.models ?? []), current.current.saved?.fast, ...(models ?? [])],
      );
    } else if (value && old?.provider !== value.provider) {
      delete prices[role];
      const provider = value.provider;
      const remembered = [
        ...(current.current.saved?.models ?? []),
        current.current.saved?.[role],
        ...(models ?? []),
      ].findLast((item) => item?.provider === provider);
      const spec = providerById(provider);
      // Never restore a remembered binding whose key was deleted or rebound.
      if (
        remembered &&
        (!remembered.key ||
          (spec &&
            current.current.index &&
            matchingKeys(spec, pickerKeys(current.current.index)).some(
              (key) => key.id === remembered.key,
            )))
      ) {
        value = remembered;
        const price = formOf({ [role]: remembered }).prices[role];
        if (price) prices[role] = price;
      }
    }
    if (!value) delete choices[role];
    else choices[role] = value;
    if (old?.provider === value?.provider && old?.model !== value?.model) delete prices[role];
    edit({ ...d, choices, prices, ...(models ? { models } : {}) });
  };
  const changePrice = (role: ModelRole, price: PriceDraft) => {
    const d = current.current.draft;
    if (d) edit({ ...d, prices: { ...d.prices, [role]: price } });
  };
  const spending = (next: SpendingDraft) => {
    const d = current.current.draft;
    if (d) edit({ ...d, spending: next });
  };
  const checkIn = (key: CheckInKey, next: CheckInsDraft[CheckInKey]) => {
    const d = current.current.draft;
    if (d) edit({ ...d, checkIns: { ...d.checkIns, [key]: next } });
  };
  const research = (next: ResearchDraft) => {
    const d = current.current.draft;
    if (d) edit({ ...d, research: next });
  };
  const purposeCheck = (on: boolean) => {
    const d = current.current.draft;
    if (d) edit({ ...d, purposeCheck: on });
  };
  const recentActivity = (on: boolean) => {
    const d = current.current.draft;
    if (d) edit({ ...d, recentActivity: on });
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
    if (!validateForm(captured, previous, owner.index, subscriptionModels).ok) return;
    const revision = owner.revision,
      generation = owner.generation;
    const abort = new AbortController();
    mutating.current = abort;
    setBusy(true);
    setError(null);
    let sent = false;
    const sameVisit = () =>
      mounted.current &&
      current.current.api === api &&
      current.current.open &&
      current.current.generation === generation &&
      !blocked.current;
    const live = () =>
      sameVisit() && current.current.revision === revision && current.current.draft === captured;
    try {
      const fresh = await loadProviderIndex(api, abort.signal);
      if (!live() || abort.signal.aborted) return;
      owner.index = fresh;
      setIndex(fresh);
      const checked = validateForm(captured, previous, fresh, subscriptionModels);
      if (!checked.ok) return;
      // Keep the previous saved model when a replacement is actually committed, not
      // when the user merely browses providers and returns to the saved choice, nor when
      // only its options change: the daemon keeps no history of a model still in use.
      for (const role of ["main", "fast", "local"] as const) {
        const old = previous[role];
        const now = checked.document[role];
        if (
          old &&
          (old.provider !== now?.provider || old.model !== now.model || old.key !== now.key)
        ) {
          const models = checked.document.models ?? [];
          if (!models.some((choice) => sameSettingsValue(choice, old)))
            checked.document.models = [...models, old].slice(-100);
        }
      }
      sent = true;
      writing.current = true;
      const next = await saveSettings(api, checked.document, abort.signal);
      if (!sameVisit() || abort.signal.aborted) {
        if (mounted.current && current.current.api === api) {
          unresolved.current = true;
          setUncertain(true);
        }
        return;
      }
      // The server acknowledged this document. A newer edit is still a draft, not an unknown
      // save: retain it and let autosave serialize the next write against this baseline.
      owner.saved = next;
      setSaved(next);
      if (live()) {
        owner.draft = formOf(next);
        setDraft(owner.draft);
      }
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
  const refreshCatalogIndex = async (allowClosed = false) => {
    const owner = current.current;
    if ((!owner.open && !allowClosed) || mutating.current || document.hidden || blocked.current)
      return;
    if (owner.phase === "error" && failed.current === "read") return read(!owner.draft);
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
        failed.current = "refresh";
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
  // Saves another main model outside Settings, checked as Settings checks it. False when it wasn't
  // saved; an unconfirmed save reads the saved settings back.
  const chooseMain = async (choice: RoleChoice): Promise<boolean> => {
    const owner = current.current,
      previous = owner.saved;
    if (
      owner.open ||
      !previous ||
      mutating.current ||
      unresolved.current ||
      document.hidden ||
      blocked.current ||
      owner.api !== api ||
      loadedFor.current !== api
    )
      return false;
    const abort = new AbortController();
    mutating.current = abort;
    setBusy(true);
    let sent = false;
    try {
      const fresh = await loadProviderIndex(api, abort.signal);
      if (!mounted.current || current.current.api !== api) return false;
      owner.index = fresh;
      setIndex(fresh);
      const accountModels =
        choice.provider === "chatgpt"
          ? chatgpt.models
          : choice.provider === "claude-code"
            ? claudeCode.models
            : [];
      const checked = validateForm(
        formOf({ ...previous, main: choice }),
        previous,
        fresh,
        accountModels,
      );
      if (!checked.ok) return false;
      sent = true;
      writing.current = true;
      const next = await saveSettings(api, checked.document, abort.signal);
      if (!mounted.current || current.current.api !== api) return false;
      owner.saved = next;
      setSaved(next);
      return true;
    } catch (failure) {
      if (sent && (!(failure instanceof SettingsFailure) || failure.uncertain) && mounted.current)
        queueMicrotask(() => void read(false, true));
      return false;
    } finally {
      if (mutating.current === abort) {
        mutating.current = null;
        writing.current = false;
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
  // A one-tap choice outside the sheet, such as the permission mode or the user's dot.
  const choose = async (patch: Pick<AgentSettingsDocument, "permissionMode" | "persona">) => {
    const owner = current.current;
    if (!owner.saved || owner.open || mutating.current || unresolved.current || blocked.current)
      return false;
    const abort = new AbortController();
    mutating.current = abort;
    writing.current = true;
    setBusy(true);
    try {
      const next = await saveSettings(api, { ...owner.saved, ...patch }, abort.signal);
      if (!mounted.current || owner.api !== api) return false;
      owner.saved = next;
      setSaved(next);
      return true;
    } catch {
      if (mounted.current) void read(false, true);
      return false;
    } finally {
      if (mutating.current === abort) {
        mutating.current = null;
        writing.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };
  // Switching apps to copy a key bumps generation but not session, so the key still binds.
  const captureKey = (role: ModelRole, provider: string) => ({
    api,
    session: current.current.session,
    revision: current.current.revision,
    role,
    provider,
  });
  const keySaved = async (capture: ReturnType<typeof captureKey>, key: KeyRecord) => {
    const owner = current.current,
      session = owner.session;
    const usable = () =>
      mounted.current &&
      owner.api === api &&
      owner.open &&
      owner.session === session &&
      !document.hidden &&
      !blocked.current &&
      loadedFor.current === api;
    if (capture.api !== api || !usable()) return;
    const before = owner.index?.keys ?? [];
    try {
      const next = await loadProviderIndex(api);
      if (!usable()) return;
      owner.index = next;
      setIndex(next);
      const provider = providerById(capture.provider),
        d = owner.draft;
      if (
        capture.session !== session ||
        capture.revision !== owner.revision ||
        !provider ||
        !d ||
        d.choices[capture.role]?.provider !== capture.provider
      )
        return;
      const newlyBound = matchingKeys(provider, pickerKeys(next)).filter(
        (row) => !before.some((old) => old.id === row.id),
      );
      if (newlyBound.length !== 1 || newlyBound[0]?.id !== key.id) return;
      change(capture.role, { ...(d.choices[capture.role] as RoleChoice), key: key.id });
    } catch {
      if (usable())
        setError(
          "The key was saved, but current model key metadata could not be loaded. Choose its binding after reconnecting.",
        );
    }
  };
  // The page renders many times a second while dot works; the forms change only when edited.
  const validation = useMemo(
    () => (draft && saved ? validateForm(draft, saved, index, subscriptionModels) : null),
    [draft, saved, index, subscriptionModels],
  );
  const accepted = useMemo(
    () => (saved && index ? validateForm(formOf(saved), saved, index, subscriptionModels) : null),
    [saved, index, subscriptionModels],
  );
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
    claudeCode,
    subscriptionModels,
    change,
    changePrice,
    changeAutonomy: (value: unknown) => {
      const parsed = AutonomyPolicy.safeParse(value),
        d = current.current.draft;
      if (parsed.success && d) edit({ ...d, autonomy: parsed.data });
    },
    changePersona: (persona: PersonaId) => {
      const d = current.current.draft;
      if (d) edit({ ...d, persona });
    },
    changeLook: (look: Partial<Pick<SettingsDraft, "name" | "accessory" | "localDots">>) => {
      const d = current.current.draft;
      if (!d) return;
      const next = { ...d, ...look };
      if (!next.accessory) delete next.accessory;
      edit(next);
    },
    spending,
    checkIn,
    research,
    purposeCheck,
    recentActivity,
    save,
    refresh: () => refreshCatalogIndex(),
    refreshModels: () => refreshCatalogIndex(true),
    reload,
    chooseMain,
    choosePermissions: (permissionMode: "custom" | "auto" | "full") => choose({ permissionMode }),
    choosePersona: (persona: PersonaId) => choose({ persona }),
    checkModels,
    browseAccounts: () => {
      setBrowsing(true);
      void checkModels();
    },
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
      (saved?.main?.provider !== "claude-code" || claudeCode.canStart) &&
      accepted?.ok === true &&
      !uncertain &&
      phase === "ready" &&
      loadedFor.current === api,
  };
}
