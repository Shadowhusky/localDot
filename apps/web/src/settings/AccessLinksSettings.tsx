import type {
  AccessAddress,
  AccessLinksStatus,
  TailscaleAccess,
  TailscaleProblem,
} from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { copyHomeScreenLink, LinkNotCopied } from "../notify/home-screen-link.ts";
import { localDotHost } from "../shell/local-dots.ts";
import { Button } from "../ui/Button.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { SignInLinkSheet } from "./SignInLinkSheet.tsx";
import { StableText } from "./StableText.tsx";

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
const WAITING_POLL_MS = 2000;

// The Tailscale row's second line: where it stands. The note under the list says what to do.
const STANDING: Record<TailscaleAccess["state"], string> = {
  "not-installed": "Not installed",
  "not-running": "Not running",
  "needs-login": "Signed out",
  "needs-approval": "Waiting for you to allow HTTPS",
  "ready-to-enable": "Off",
  served: "On",
  unavailable: "Unavailable",
};
const PROBLEMS: Record<TailscaleProblem, string> = {
  permission: "Needs your permission",
  "port-taken": "Port in use",
  funnel: "Public through Funnel",
  "no-name": "No ts.net name",
  "no-answer": "Not answering",
  "other-user": "In use by another account",
  failed: "Couldn't turn on",
};
// What a localDot started before it reported Tailscale's state answers.
const OUTDATED: TailscaleAccess = {
  state: "unavailable",
  message: "Restart localDot on this computer to set up Tailscale here.",
};

function accessStatus(value: unknown): AccessLinksStatus {
  const answer = value as Partial<AccessLinksStatus> | null;
  if (!answer || !Array.isArray(answer.links)) throw new Error("Invalid address list");
  return {
    links: answer.links,
    tailscale: typeof answer.tailscale?.state === "string" ? answer.tailscale : OUTDATED,
  };
}

const standing = (tailscale: TailscaleAccess) =>
  tailscale.state === "served" && tailscale.origin
    ? localDotHost(tailscale.origin)
    : tailscale.state === "unavailable" && tailscale.reason
      ? PROBLEMS[tailscale.reason]
      : STANDING[tailscale.state];
const named = (label: string) => (label === "Tailscale" ? label : label.toLowerCase());
const openPage = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

export function AccessLinksSettings({ api }: { api: ApiClient }) {
  const [status, setStatus] = useState<AccessLinksStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  // A read that started before an action answered is older than that answer.
  const revision = useRef(0);
  const [result, setResult] = useState<{
    origin: string;
    expiresAt: number;
    fallback?: string;
  } | null>(null);
  const tailscale = status?.tailscale;
  const waiting = tailscale?.state === "needs-approval";
  useEffect(() => {
    let disposed = false;
    const read = async (fresh: boolean) => {
      const current = revision.current;
      try {
        const value = accessStatus(await api.get(`/api/access-links${fresh ? "?fresh=1" : ""}`));
        if (!disposed && current === revision.current) {
          setStatus(value);
          setError(null);
        }
      } catch (failure) {
        if (!disposed)
          setError(
            failure instanceof ApiError && failure.status === 404
              ? "App links will be available after the localDot service is updated and restarted."
              : "App addresses couldn't load. Try again.",
          );
      }
    };
    void read(retry > 0);
    // Coming back from Tailscale is the moment its state has likely changed.
    const focus = () => void read(true);
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", focus);
    };
  }, [api, retry]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      const current = revision.current;
      try {
        const value = accessStatus(await api.get("/api/access-links"));
        if (current === revision.current) setStatus(value);
      } catch {}
    }, WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [api, waiting]);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), Math.max(0, result.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async (origin: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(origin);
    setResult(null);
    setError(null);
    try {
      const value = await copyHomeScreenLink(api, navigator.clipboard, origin);
      setResult({ origin, expiresAt: value.expiresAt });
    } catch (failure) {
      if (failure instanceof LinkNotCopied)
        setResult({ origin, expiresAt: failure.expiresAt, fallback: failure.link });
      else setError("Couldn't create a sign-in link. Try again.");
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const act = async (name: "turn-on" | "check", request: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    revision.current++;
    setBusy(name);
    setError(null);
    try {
      setStatus(accessStatus(await request()));
    } catch {
      setError(
        name === "turn-on"
          ? "Tailscale couldn't be turned on. Try again."
          : "Tailscale couldn't be checked. Try again.",
      );
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const waitReason = (name: string) => (busy && busy !== name ? "Please wait…" : undefined);
  const copyButton = (origin: string, label: string) => {
    const copied = result?.origin === origin && !result.fallback;
    return (
      <Button
        variant="quiet"
        size="sm"
        icon={copied ? "check" : "copy"}
        busy={busy === origin}
        disabledReason={waitReason(origin)}
        aria-label={copied ? `${label} link copied` : `Copy ${named(label)} link`}
        onClick={() => void copy(origin)}
      >
        <StableText choices={["Copy link", "Copied"]} value={copied ? "Copied" : "Copy link"} />
      </Button>
    );
  };
  const tailscaleAction = (state: TailscaleAccess) => {
    const page = state.approvalUrl;
    if (state.state === "served" && state.origin) return copyButton(state.origin, "Tailscale");
    if (state.state === "needs-approval" && page)
      return (
        <Button size="sm" onClick={() => openPage(page)}>
          Allow HTTPS
        </Button>
      );
    if (state.state === "ready-to-enable" || state.reason === "permission")
      return (
        <>
          {page && (
            <Button variant="quiet" size="sm" onClick={() => openPage(page)}>
              Allow HTTPS
            </Button>
          )}
          <Button
            size="sm"
            busy={busy === "turn-on"}
            disabledReason={waitReason("turn-on")}
            onClick={() => void act("turn-on", () => api.post("/api/access-links/tailscale"))}
          >
            Turn on
          </Button>
        </>
      );
    if (state.state === "not-installed")
      return (
        <Button size="sm" onClick={() => openPage(TAILSCALE_DOWNLOAD)}>
          Get Tailscale
        </Button>
      );
    if (state === OUTDATED) return undefined;
    return (
      <Button
        variant="quiet"
        size="sm"
        busy={busy === "check"}
        disabledReason={waitReason("check")}
        onClick={() => void act("check", () => api.get("/api/access-links?fresh=1"))}
      >
        Check again
      </Button>
    );
  };
  const addressRow = (address: AccessAddress) => (
    <GroupRow
      key={address.origin}
      label={address.label}
      detail={localDotHost(address.origin)}
      trailing={copyButton(address.origin, address.label)}
    />
  );
  return (
    <div>
      <GroupHead title="App links" />
      <GroupNote>Open localDot on your devices. Keep this computer on.</GroupNote>
      {status && tailscale && (
        <>
          <Group>
            {status.links.slice(0, 1).map(addressRow)}
            <GroupRow
              label="Tailscale"
              detail={
                waiting ? (
                  <span className="settings-waiting">
                    <Spinner size={12} />
                    {standing(tailscale)}
                  </span>
                ) : (
                  standing(tailscale)
                )
              }
              trailing={tailscaleAction(tailscale)}
            />
            {status.links.slice(1).map(addressRow)}
          </Group>
          <GroupNote role="status">{tailscale.message}</GroupNote>
          {tailscale.operatorHint && (
            <pre className="settings-well settings-command">{tailscale.operatorHint}</pre>
          )}
        </>
      )}
      <GroupNote>
        <span role="status">
          <StableText
            choices={[
              "Sign-in links work once and expire in 1 minute. Only share with a device you trust.",
              "Link copied. Open it on your device within a minute. Only share with a device you trust.",
            ]}
            value={
              result && !result.fallback
                ? "Link copied. Open it on your device within a minute. Only share with a device you trust."
                : "Sign-in links work once and expire in 1 minute. Only share with a device you trust."
            }
          />
        </span>
      </GroupNote>
      <SignInLinkSheet
        link={result?.fallback}
        label="App sign-in link"
        onClose={() => setResult(null)}
      />
      {error && (
        <div className="settings-inline settings-note-line">
          <p className="settings-lede" role="alert">
            {error}
          </p>
          <Button variant="quiet" size="sm" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
