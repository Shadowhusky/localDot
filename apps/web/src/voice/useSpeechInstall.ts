import { useCallback, useEffect, useRef, useState } from "react";
import {
  SpeechInstallStatus,
  type SpeechTierId,
} from "../../../../packages/protocol/src/speech-install.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { showToast } from "../ui/Toast.tsx";
import { refreshVoiceSupport } from "./support.ts";

const INSTALL_PATH = "/api/voice/install";
// An install under way, whichever device started it, then a slower look while someone's watching.
const RUNNING_MS = 1500;
const WATCHING_MS = 15_000;

export interface SpeechInstallControl {
  status: SpeechInstallStatus | null;
  pending: "install" | "cancel" | "remove" | null;
  failure: string | null;
  // Resolves false, with `failure` set, when the computer refused. Only ever from a press.
  install(tier: SpeechTierId): Promise<boolean>;
  cancel(): void;
  remove(): void;
}

const failureOf = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.status === 409 && error.message ? error.message : fallback;

// Tells the voice route to look again, and the person how it ended if they've moved on.
function speechEnded(status: SpeechInstallStatus, tier: SpeechTierId) {
  refreshVoiceSupport();
  if (status.job?.state === "failed")
    showToast({
      id: "speech-install",
      title: "Speech didn't finish installing",
      description: "Settings → Voice says why, and can try again.",
      tone: "danger",
    });
  else if (!status.job && status.installed?.tier === tier)
    showToast({
      id: "speech-install",
      title: "dot can hear you now",
      description: "Tap the microphone to talk.",
      tone: "success",
    });
}

export function useSpeechInstall(
  api: ApiClient,
  watching: boolean,
  ended: (status: SpeechInstallStatus, tier: SpeechTierId) => void = speechEnded,
): SpeechInstallControl {
  const [status, setStatus] = useState<SpeechInstallStatus | null>(null);
  const [pending, setPending] = useState<SpeechInstallControl["pending"]>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const running = status?.job?.state === "running";
  const runningTier = useRef<SpeechTierId | null>(null);

  useEffect(() => {
    if (runningTier.current && !running && status) ended(status, runningTier.current);
    runningTier.current = running ? (status?.job?.tier ?? null) : null;
  }, [running, status, ended]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = running ? RUNNING_MS : watching ? WATCHING_MS : null;
    const read = () => {
      api
        .get<unknown>(INSTALL_PATH, { signal: abort.signal })
        .then((value) => {
          if (!abort.signal.aborted) setStatus(SpeechInstallStatus.parse(value));
        })
        .catch(() => {})
        .finally(() => {
          if (!abort.signal.aborted && every) timer = setTimeout(read, every);
        });
    };
    const refresh = () => {
      if (!document.hidden) read();
    };
    read();
    window.addEventListener("focus", refresh);
    return () => {
      abort.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [api, running, watching]);

  const change = useCallback(
    async (
      kind: NonNullable<SpeechInstallControl["pending"]>,
      work: () => Promise<unknown>,
      fallback: string,
    ) => {
      setPending(kind);
      setFailure(null);
      try {
        setStatus(SpeechInstallStatus.parse(await work()));
        return true;
      } catch (error) {
        setFailure(failureOf(error, fallback));
        return false;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const install = useCallback(
    (tier: SpeechTierId) =>
      change(
        "install",
        () => api.post(INSTALL_PATH, { tier }),
        "Couldn't start the download. Try again.",
      ),
    [api, change],
  );
  const cancel = useCallback(() => {
    void change(
      "cancel",
      () => api.post(`${INSTALL_PATH}/cancel`),
      "Couldn't cancel the download. Try again.",
    );
  }, [api, change]);
  const remove = useCallback(() => {
    void change(
      "remove",
      async () => {
        await api.del(INSTALL_PATH);
        return api.get(INSTALL_PATH);
      },
      "Couldn't remove speech. Try again.",
    );
  }, [api, change]);

  return { status, pending, failure, install, cancel, remove };
}
