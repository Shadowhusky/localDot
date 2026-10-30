import type {
  PreviewRefusal,
  PreviewRequest,
  PreviewsState as PreviewsAvailability,
  PreviewsStatus,
} from "@localdot/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComputerUpdate } from "../cells/useComputerUpdate.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { copyIssuedLink, LinkNotCopied } from "../notify/home-screen-link.ts";
import { showToast } from "../ui/Toast.tsx";
import { readPreviews, refusalOf, requestPreview, stopPreview } from "./previews-api.ts";

// What a tap that could not open a preview shows beside the control that was tapped.
export interface PreviewNoticeState {
  anchor: HTMLElement;
  refusal?: PreviewRefusal;
  // What the notice's own button asks again: a new tap, which may open a tab.
  request?: PreviewRequest;
  // The browser kept the new tab from opening, or the clipboard refused it: the notice holds the
  // preview's link instead.
  link?: string;
  // It came from Copy link, which its button tries again.
  copy?: boolean;
}

export interface Previews {
  status: PreviewsStatus | null;
  // The status has been asked for and answered, or found unavailable.
  settled: boolean;
  // Asks once for the status, as the first chip appears.
  want(): void;
  // While the list is on show its servers and previews are read again every few seconds.
  watch(): () => void;
  open(request: PreviewRequest, trigger: HTMLElement): void;
  // Copies a link that opens the preview once, on any of the owner's devices.
  copy(request: PreviewRequest, trigger: HTMLElement): void;
  // Ends every preview link, so each device has to open it from localDot again.
  signOut(trigger: HTMLElement): void;
  // Requests being opened or copied ("copy " before its key), and "sign-out".
  pending: ReadonlySet<string>;
  notice: PreviewNoticeState | null;
  closeNotice(): void;
  // Settings at Your computer, where Tailscale is turned on.
  openSettings(trigger: HTMLElement): void;
  update?: ComputerUpdate;
}

const POLL_MS = 5000;
// A refusal this recent is trusted: a tap then explains at once instead of opening a tab to close.
const FRESH_MS = 30_000;
// A link signs a device in once, within this long.
const LINK_MS = 120_000;

export const requestKey = (request: PreviewRequest) =>
  "url" in request ? `url ${request.url}` : `port ${request.port}`;

// iOS opens a tab only inside the tap itself, so the tab opens blank before the preview exists. It
// never learns which page opened it.
function blankTab(): Window | null {
  try {
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    return tab;
  } catch {
    return null;
  }
}

export function usePreviewsState(
  api: ApiClient,
  sessionId: string | null,
  actions: { openSettings(trigger: HTMLElement): void; update?: ComputerUpdate },
): Previews | null {
  const [known, setKnown] = useState<{
    owner: string;
    status: PreviewsStatus | null;
    at: number;
  } | null>(null);
  const [watchers, setWatchers] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<PreviewNoticeState | null>(null);
  const current = known?.owner === sessionId ? known : null;
  const latest = useRef(current);
  latest.current = current;
  const asked = useRef<string | null>(null);
  const owner = useRef(sessionId);
  owner.current = sessionId;
  // Only the newest read lands: one begun before an open or a stop never undoes it.
  const reads = useRef({ started: 0, open: 0 });

  const load = useCallback(() => {
    if (!sessionId) return;
    const read = ++reads.current.started;
    reads.current.open++;
    const newest = () => owner.current === sessionId && read === reads.current.started;
    readPreviews(api, sessionId)
      .then(
        (status) => {
          if (newest()) setKnown({ owner: sessionId, status, at: Date.now() });
        },
        () => {
          // An unknown computer, or a localDot without previews: no chip can open anything.
          if (newest())
            setKnown((was) =>
              was?.owner === sessionId ? was : { owner: sessionId, status: null, at: Date.now() },
            );
        },
      )
      .finally(() => {
        reads.current.open--;
      });
  }, [api, sessionId]);

  const want = useCallback(() => {
    if (!sessionId || asked.current === sessionId) return;
    asked.current = sessionId;
    load();
  }, [load, sessionId]);

  const watch = useCallback(() => {
    setWatchers((count) => count + 1);
    return () => setWatchers((count) => count - 1);
  }, []);

  useEffect(() => {
    if (!watchers || !sessionId) return;
    asked.current = sessionId;
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !reads.current.open) load();
    }, POLL_MS);
    const shown = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [watchers, sessionId, load]);

  const mark = useCallback((key: string, on: boolean) => {
    setPending((was) => {
      const next = new Set(was);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const busy = useRef(new Set<string>());

  const refuse = useCallback(
    (anchor: HTMLElement, refusal: PreviewRefusal, request?: PreviewRequest, copy = false) => {
      setNotice({ anchor, refusal, ...(request ? { request } : {}), ...(copy ? { copy } : {}) });
      const state = refusal.state;
      if (state && sessionId)
        setKnown((was) =>
          was?.owner === sessionId && was.status
            ? {
                ...was,
                status: { ...was.status, state, message: refusal.message },
                at: Date.now(),
              }
            : was,
        );
    },
    [sessionId],
  );

  // A state that keeps previews from opening, known lately: the tap explains it at once.
  const refused = useCallback(
    (request: PreviewRequest, trigger: HTMLElement) => {
      const seen = latest.current;
      if (!seen?.status || seen.status.state === "ready" || Date.now() - seen.at >= FRESH_MS)
        return false;
      refuse(trigger, unavailable(seen.status.state, seen.status.message), request);
      load();
      return true;
    },
    [refuse, load],
  );

  const run = useCallback(
    (key: string, work: () => Promise<unknown>) => {
      busy.current.add(key);
      mark(key, true);
      void work().finally(() => {
        busy.current.delete(key);
        mark(key, false);
        load();
      });
    },
    [load, mark],
  );

  const open = useCallback(
    (request: PreviewRequest, trigger: HTMLElement) => {
      const key = requestKey(request);
      if (!sessionId || busy.current.has(key) || refused(request, trigger)) return;
      setNotice(null);
      const tab = blankTab();
      run(key, () =>
        requestPreview(api, sessionId, request).then(
          (opened) => {
            if (tab && !tab.closed) tab.location.replace(opened.open);
            else setNotice({ anchor: trigger, link: opened.open });
          },
          (error: unknown) => {
            tab?.close();
            refuse(trigger, refusalOf(error), request);
          },
        ),
      );
    },
    [api, sessionId, run, refused, refuse],
  );

  const copy = useCallback(
    (request: PreviewRequest, trigger: HTMLElement) => {
      const key = `copy ${requestKey(request)}`;
      if (!sessionId || busy.current.has(key) || refused(request, trigger)) return;
      setNotice(null);
      // The copy starts within the tap, as Safari needs; the link fills it once it is made.
      const issued = requestPreview(api, sessionId, request).then((opened) => ({
        link: opened.open,
        expiresAt: Date.now() + LINK_MS,
      }));
      run(key, () =>
        copyIssuedLink(issued, navigator.clipboard).then(
          () =>
            showToast({
              title: "Link copied",
              description: "It opens this app once, on any of your devices, within two minutes.",
              tone: "success",
            }),
          (error: unknown) => {
            if (error instanceof LinkNotCopied)
              setNotice({ anchor: trigger, link: error.link, copy: true });
            else refuse(trigger, refusalOf(error), request, true);
          },
        ),
      );
    },
    [api, sessionId, run, refused, refuse],
  );

  const signOut = useCallback(
    (trigger: HTMLElement) => {
      const ids = latest.current?.status?.previews.map((preview) => preview.id) ?? [];
      if (!sessionId || busy.current.has("sign-out")) return;
      run("sign-out", async () => {
        const ended = await Promise.allSettled(ids.map((id) => stopPreview(api, sessionId, id)));
        // A link that has already ended is as good as one ended now.
        const failed = ended.some(
          (result) =>
            result.status === "rejected" &&
            !(result.reason instanceof ApiError && result.reason.status === 404),
        );
        if (failed)
          refuse(trigger, { message: "localDot couldn't sign your devices out. Try again." });
      });
    },
    [api, sessionId, run, refuse],
  );

  const closeNotice = useCallback(() => setNotice(null), []);
  // The app hands over new functions with every render; the context changes only with what shows.
  const given = useRef(actions);
  given.current = actions;
  const openSettings = useCallback(
    (trigger: HTMLElement) => given.current.openSettings(trigger),
    [],
  );
  const offered = !!actions.update;
  const available = !!actions.update?.available;
  const updating = !!actions.update?.busy;
  const failed = actions.update?.error ?? null;
  const waitReason = actions.update?.waitReason;
  const update = useMemo<ComputerUpdate | undefined>(
    () =>
      offered
        ? {
            available,
            busy: updating,
            error: failed,
            ...(waitReason ? { waitReason } : {}),
            run: () => given.current.update?.run(),
          }
        : undefined,
    [offered, available, updating, failed, waitReason],
  );
  return useMemo(
    () =>
      sessionId
        ? {
            status: current?.status ?? null,
            settled: !!current,
            want,
            watch,
            open,
            copy,
            signOut,
            pending,
            notice,
            closeNotice,
            openSettings,
            update,
          }
        : null,
    [
      sessionId,
      current,
      want,
      watch,
      open,
      copy,
      signOut,
      pending,
      notice,
      closeNotice,
      openSettings,
      update,
    ],
  );
}

// What a state that keeps previews from opening says when the daemon gave no words of its own.
export function unavailable(
  state: PreviewsAvailability,
  message: string | undefined,
): PreviewRefusal {
  if (message) return { state, message };
  return {
    state,
    message:
      state === "needs-tailscale"
        ? "Previews open over Tailscale. Turn it on in Settings → Your computer, then try again."
        : state === "needs-update"
          ? "Your computer needs its newest version to open previews."
          : state === "computer-off"
            ? "Turn on your computer to open the servers dot starts in it."
            : "Try again in a moment.",
  };
}

const Context = createContext<Previews | null>(null);

// The owner's own surfaces only: a shared link's guest and Replay get no previews.
export function PreviewsScope({
  value,
  children,
}: {
  value: Previews | null;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const usePreviews = () => useContext(Context);
