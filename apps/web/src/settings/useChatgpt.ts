import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  ChatgptFailure,
  type ChatgptLoginMaterial,
  type ChatgptResponse,
  type ChatgptSummary,
  cancelChatgpt,
  chatgptSummary,
  checkChatgpt,
  installChatgpt,
  loginChatgpt,
  logoutChatgpt,
  readChatgpt,
  refreshChatgpt,
} from "./chatgpt-api.ts";

type Action =
  | "install"
  | "check"
  | "login"
  | "cancel_install"
  | "cancel_login"
  | "logout"
  | "refresh";
type Command = { action: Action; abort: AbortController; epoch: number };
const LOGIN_MS = 10 * 60 * 1000;
const INSTALL_MS = 15 * 60 * 1000;
const away = () => document.hidden || navigator.onLine === false;
// Installed, with this Mac's safety check still to finish: the daemon runs it by itself.
const preparing = (status: Pick<ChatgptSummary, "available" | "install" | "sandbox">) =>
  status.available &&
  status.install.state === "ready" &&
  (status.sandbox === "unchecked" || status.sandbox === "checking");
export function useChatgpt(api: ApiClient, visible: boolean) {
  const [summary, setSummary] = useState<ChatgptSummary | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [blocked, setBlocked] = useState(away);
  const [expired, setExpired] = useState(false);
  const [installWatching, setInstallWatching] = useState(false);
  const watchingInstall = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [poll, setPoll] = useState({ failures: 0 });
  const [materialReady, setMaterialReady] = useState(false);
  const code = useRef<HTMLInputElement>(null);
  const link = useRef<HTMLInputElement>(null);
  // Ref detachment happens before parent effect cleanup. Erase the retiring DOM nodes there.
  const attachCode = useCallback((node: HTMLInputElement | null) => {
    if (code.current && code.current !== node) code.current.value = "";
    code.current = node;
  }, []);
  const attachLink = useCallback((node: HTMLInputElement | null) => {
    if (link.current && link.current !== node) link.current.value = "";
    link.current = node;
  }, []);
  const mounted = useRef(false);
  const owner = useRef({ api, visible, blocked: away(), epoch: 0, loginId: null as string | null });
  const reading = useRef<AbortController | null>(null);
  const command = useRef<Command | null>(null);
  const currentStatus = useRef<ChatgptSummary | null>(null);
  const known = useRef(false);
  const pendingKind = useRef<"install" | "login" | null>(null);
  const failures = useRef(0);
  const loginDeadline = useRef<{ id: string; at: number } | null>(null);
  const installDeadline = useRef<number | null>(null);
  const clearMaterial = useCallback(() => {
    if (code.current) code.current.value = "";
    if (link.current) link.current.value = "";
    setMaterialReady(false);
  }, []);
  const usable = useCallback(
    () =>
      mounted.current &&
      owner.current.api === api &&
      owner.current.visible &&
      !owner.current.blocked &&
      !away(),
    [api],
  );
  const unverify = useCallback(() => {
    known.current = false;
    setVerified(false);
  }, []);
  const retire = useCallback(() => {
    owner.current.epoch++;
    reading.current?.abort();
    reading.current = null;
    if (command.current) {
      command.current.abort.abort();
      command.current = null;
      unverify();
      setUncertain(true);
      setError(
        "The view closed before the action was verified. Check account status before continuing.",
      );
    }
    clearMaterial();
    setBusy(null);
    setChecking(false);
    setNotice(null);
  }, [clearMaterial, unverify]);
  const materialCurrent = useCallback(() => {
    const deadline = loginDeadline.current;
    if (!deadline) return false;
    if (Date.now() < deadline.at) return true;
    clearMaterial();
    setExpired(true);
    unverify();
    setError("This sign-in attempt has expired. Cancel or check account status.");
    return false;
  }, [clearMaterial, unverify]);
  const paint = useCallback(
    (material: ChatgptLoginMaterial) => {
      if (!usable()) return;
      if (owner.current.loginId && owner.current.loginId !== material.loginId) {
        clearMaterial();
        throw new ChatgptFailure(false);
      }
      owner.current.loginId = material.loginId;
      if (loginDeadline.current?.id !== material.loginId)
        loginDeadline.current = {
          id: material.loginId,
          at: Math.min(material.startedAt + LOGIN_MS, Date.now() + LOGIN_MS),
        };
      if (!materialCurrent()) return;
      setExpired(false);
      if (code.current) code.current.value = material.userCode;
      if (link.current) link.current.value = material.verificationUrl;
      setMaterialReady(!!code.current && !!link.current);
    },
    [usable, clearMaterial, materialCurrent],
  );
  const apply = useCallback(
    (response: ChatgptResponse) => {
      if (!usable()) return;
      if (response.login) paint(response.login);
      else clearMaterial();
      if (response.state === "signing_in" && !loginDeadline.current)
        loginDeadline.current = { id: "pending", at: Date.now() + LOGIN_MS };
      if (response.state !== "signing_in") {
        owner.current.loginId = null;
        loginDeadline.current = null;
        setExpired(false);
      }
      if (preparing(response)) {
        watchingInstall.current = false;
        setInstallWatching(false);
        installDeadline.current ??= Date.now() + INSTALL_MS;
      } else if (["ready", "failed"].includes(response.install.state)) {
        watchingInstall.current = false;
        setInstallWatching(false);
        installDeadline.current = null;
      } else if (
        watchingInstall.current ||
        ["downloading", "verifying"].includes(response.install.state)
      ) {
        installDeadline.current ??= Date.now() + INSTALL_MS;
      }
      const next = chatgptSummary(response);
      currentStatus.current = next;
      setSummary(next);
      known.current = true;
      setVerified(true);
      setUncertain(false);
      if (!watchingInstall.current) pendingKind.current = null;
    },
    [usable, paint, clearMaterial],
  );
  const read = useCallback(
    async (explicit = false, parent?: Command) => {
      if (!usable() || (command.current && command.current !== parent)) return;
      if (explicit) {
        owner.current.epoch++;
        if (parent) parent.epoch = owner.current.epoch;
        owner.current.loginId = null;
        clearMaterial();
      }
      const epoch = owner.current.epoch;
      reading.current?.abort();
      const abort = new AbortController();
      reading.current = abort;
      setChecking(true);
      try {
        const response = await readChatgpt(api, abort.signal);
        if (
          !usable() ||
          abort.signal.aborted ||
          epoch !== owner.current.epoch ||
          reading.current !== abort
        )
          return;
        setError(null);
        failures.current = 0;
        if (
          parent?.action === "cancel_install" &&
          command.current === parent &&
          response.install.state === "not_installed"
        ) {
          watchingInstall.current = false;
          setInstallWatching(false);
          installDeadline.current = null;
          pendingKind.current = null;
        }
        apply(response);
      } catch (failure) {
        if (
          !usable() ||
          abort.signal.aborted ||
          epoch !== owner.current.epoch ||
          reading.current !== abort
        )
          return;
        unverify();
        clearMaterial();
        failures.current++;
        setError(
          failure instanceof ChatgptFailure ? failure.message : new ChatgptFailure(false).message,
        );
      } finally {
        if (reading.current === abort) {
          reading.current = null;
          setChecking(false);
          setPoll({ failures: failures.current });
        }
        abort.abort();
      }
    },
    [api, usable, apply, unverify, clearMaterial],
  );
  useLayoutEffect(() => {
    const changed = owner.current.api !== api;
    retire();
    Object.assign(owner.current, { api, visible, blocked: away() });
    setBlocked(away());
    if (changed) {
      watchingInstall.current = false;
      setInstallWatching(false);
      currentStatus.current = null;
      known.current = false;
      pendingKind.current = null;
      owner.current.loginId = null;
      loginDeadline.current = null;
      installDeadline.current = null;
      setSummary(null);
      setVerified(false);
      setUncertain(false);
      setError(null);
      setExpired(false);
    }
  }, [api, visible, retire]);
  useEffect(() => {
    mounted.current = true;
    if (visible && !away()) void read();
    return () => {
      mounted.current = false;
      retire();
    };
  }, [visible, read, retire]);
  useEffect(() => {
    const suspend = () => {
      owner.current.blocked = true;
      setBlocked(true);
      retire();
    };
    const restore = () => {
      owner.current.blocked = away();
      setBlocked(away());
      if (owner.current.visible && !away()) void read();
    };
    const visibility = () => {
      if (document.hidden) suspend();
      else restore();
    };
    window.addEventListener("offline", suspend);
    window.addEventListener("online", restore);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("offline", suspend);
      window.removeEventListener("online", restore);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [read, retire]);
  useEffect(() => {
    const deadline = loginDeadline.current;
    if (!visible || blocked || expired || summary?.state !== "signing_in" || !deadline || !usable())
      return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (
        !usable() ||
        loginDeadline.current !== deadline ||
        currentStatus.current?.state !== "signing_in"
      )
        return;
      const remaining = deadline.at - Date.now();
      if (remaining > 0) timer = setTimeout(expire, remaining);
      else materialCurrent();
    };
    timer = setTimeout(expire, Math.max(0, deadline.at - Date.now()));
    return () => clearTimeout(timer);
  }, [visible, blocked, expired, summary, usable, materialCurrent]);
  useEffect(() => {
    if (!visible || blocked || busy || checking || !summary || expired || !usable()) return;
    const installing =
      installWatching ||
      ["downloading", "verifying"].includes(summary.install.state) ||
      preparing(summary);
    if (!installing && summary.state !== "signing_in") return;
    const until = installing
      ? (installDeadline.current ?? Date.now() + INSTALL_MS)
      : (loginDeadline.current?.at ?? Date.now() + LOGIN_MS);
    if (Date.now() >= until) {
      clearMaterial();
      setExpired(true);
      unverify();
      setError("This attempt exceeded its waiting time. Cancel or check account status.");
      return;
    }
    const delay = Math.min(8000, 1000 * 2 ** Math.min(poll.failures, 3), until - Date.now());
    const timer = setTimeout(() => {
      void read();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    visible,
    blocked,
    busy,
    checking,
    summary,
    expired,
    installWatching,
    poll,
    usable,
    read,
    clearMaterial,
    unverify,
  ]);
  const run = async (action: Action) => {
    if (!usable()) return;
    const cancelling = action === "cancel_install" || action === "cancel_login";
    if (command.current && (!cancelling || command.current.action.startsWith("cancel_"))) return;
    const status = currentStatus.current;
    const ready = known.current && status?.available && status.install.state === "ready";
    const checked = ready && status?.sandbox === "passed";
    if (
      action === "install" &&
      (watchingInstall.current ||
        !known.current ||
        !status?.available ||
        !["not_installed", "failed"].includes(status.install.state) ||
        (status.install.state === "failed" && status.install.code === "unsupported_platform"))
    )
      return;
    if (action === "check" && (!ready || !["unchecked", "failed"].includes(status?.sandbox ?? "")))
      return;
    if (
      action === "login" &&
      (!checked || !["signed_out", "expired"].includes(status?.state ?? ""))
    )
      return;
    if (["refresh", "logout"].includes(action) && (!checked || status?.state === "signing_in"))
      return;
    if (cancelling) {
      const kind = action === "cancel_install" ? "install" : "login";
      const active =
        kind === "install"
          ? ["downloading", "verifying"].includes(status?.install.state ?? "")
          : status?.state === "signing_in";
      if (!active && pendingKind.current !== kind) return;
    }
    reading.current?.abort();
    reading.current = null;
    command.current?.abort.abort();
    owner.current.epoch++;
    const operation = { action, abort: new AbortController(), epoch: owner.current.epoch };
    command.current = operation;
    unverify();
    setBusy(action);
    setError(null);
    setNotice(null);
    if (action === "install" || action === "login") pendingKind.current = action;
    if (action === "install") {
      watchingInstall.current = true;
      setInstallWatching(true);
      setExpired(false);
      installDeadline.current = Date.now() + INSTALL_MS;
    }
    clearMaterial();
    const live = () =>
      usable() &&
      !operation.abort.signal.aborted &&
      command.current === operation &&
      owner.current.epoch === operation.epoch;
    try {
      if (action === "install") {
        const install = await installChatgpt(api, operation.abort.signal);
        if (!live() || !status) return;
        const next = { ...status, install };
        currentStatus.current = next;
        setSummary(next);
        if (["downloading", "verifying"].includes(install.state))
          installDeadline.current = Date.now() + INSTALL_MS;
        await read(false, operation);
      } else if (action === "check") {
        const sandbox = await checkChatgpt(api, operation.abort.signal);
        if (!live() || !status) return;
        const next = { ...status, sandbox };
        currentStatus.current = next;
        setSummary(next);
        installDeadline.current = Date.now() + INSTALL_MS;
        await read(false, operation);
      } else if (action === "login") {
        const material = await loginChatgpt(api, operation.abort.signal);
        if (!live() || !status) return;
        owner.current.loginId = material.loginId;
        const next: ChatgptSummary = {
          ...status,
          state: "signing_in",
          login: { loginId: material.loginId, startedAt: material.startedAt },
        };
        currentStatus.current = next;
        setSummary(next);
        paint(material);
        known.current = true;
        setVerified(true);
        setUncertain(false);
      } else if (action === "refresh") {
        const response = await refreshChatgpt(api, operation.abort.signal);
        if (live()) apply(response);
      } else {
        if (action === "logout") await logoutChatgpt(api, operation.abort.signal);
        else
          await cancelChatgpt(
            api,
            action === "cancel_install" ? "install" : "login",
            operation.abort.signal,
          );
        if (live()) await read(true, operation);
      }
    } catch (failure) {
      if (!live()) return;
      clearMaterial();
      unverify();
      const problem = failure instanceof ChatgptFailure ? failure : new ChatgptFailure(true);
      if (action === "login" && problem.refusal) {
        pendingKind.current = null;
        await read(true, operation);
        if (live() && known.current) setError(problem.refusal);
        return;
      }
      setUncertain(problem.uncertain);
      if (action === "install" && !problem.uncertain) {
        watchingInstall.current = false;
        setInstallWatching(false);
        pendingKind.current = null;
      }
      setError(problem.message);
    } finally {
      if (command.current === operation) {
        command.current = null;
        setBusy(null);
        setChecking(false);
      }
      operation.abort.abort();
    }
  };
  const copyCode = async () => {
    const epoch = owner.current.epoch,
      value = code.current?.value;
    if (!usable() || !materialCurrent() || !value || currentStatus.current?.state !== "signing_in")
      return;
    try {
      await navigator.clipboard.writeText(value);
      if (usable() && owner.current.epoch === epoch) setNotice("Sign-in code copied.");
    } catch {
      if (usable() && owner.current.epoch === epoch)
        setNotice("Select the code and copy it manually.");
    }
  };
  return {
    summary,
    materialReady,
    installWatching,
    verified,
    busy,
    checking,
    uncertain,
    blocked,
    expired,
    error,
    notice,
    code: attachCode,
    link: attachLink,
    models: summary?.state === "signed_in" && verified ? (summary.models ?? []) : [],
    canStart:
      verified &&
      !busy &&
      !blocked &&
      !away() &&
      owner.current.api === api &&
      summary?.available === true &&
      summary.install.state === "ready" &&
      summary.sandbox === "passed" &&
      summary.state === "signed_in",
    canCancelInstall:
      watchingInstall.current ||
      pendingKind.current === "install" ||
      ["downloading", "verifying"].includes(summary?.install.state ?? ""),
    canCancelLogin: pendingKind.current === "login" || summary?.state === "signing_in",
    isMutating: () => command.current !== null,
    install: () => run("install"),
    checkSandbox: () => run("check"),
    login: () => run("login"),
    cancelInstall: () => run("cancel_install"),
    cancelLogin: () => run("cancel_login"),
    logout: () => run("logout"),
    refresh: () => run("refresh"),
    check: () => read(true),
    copyCode,
    openPage: () => {
      if (
        !usable() ||
        !materialCurrent() ||
        currentStatus.current?.state !== "signing_in" ||
        !code.current?.value ||
        link.current?.value !== "https://auth.openai.com/codex/device"
      )
        return;
      window.open(link.current.value, "_blank", "noopener,noreferrer");
    },
  };
}
export type ChatgptControls = ReturnType<typeof useChatgpt>;
