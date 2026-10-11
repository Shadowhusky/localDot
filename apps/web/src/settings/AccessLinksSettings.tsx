import { useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { copyHomeScreenLink, LinkNotCopied } from "../notify/home-screen-link.ts";
import { Button } from "../ui/Button.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { SignInLinkSheet } from "./SignInLinkSheet.tsx";
import { StableText } from "./StableText.tsx";

type Address = { origin: string; label: string; description: string; available?: boolean };
export function AccessLinksSettings({ api }: { api: ApiClient }) {
  const [tailscaleSetup, setTailscaleSetup] = useState(false);
  const [links, setLinks] = useState<Address[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [result, setResult] = useState<{
    origin: string;
    expiresAt: number;
    fallback?: string;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the address list.
  useEffect(() => {
    let disposed = false;
    const read = async () => {
      try {
        const value = await api.get<{ links: Address[]; tailscaleSetup?: boolean }>(
          "/api/access-links",
        );
        if (!Array.isArray(value.links)) throw new Error("Invalid address list");
        if (!disposed) {
          setLinks(value.links);
          setTailscaleSetup(!!value.tailscaleSetup);
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
    void read();
    window.addEventListener("focus", read);
    return () => {
      disposed = true;
      window.removeEventListener("focus", read);
    };
  }, [api, retry]);
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
  return (
    <div>
      <GroupHead title="App links" />
      <GroupNote>Open localDot on your devices. Keep this computer on.</GroupNote>
      {tailscaleSetup && (
        <Group>
          <div className="settings-remote-action">
            <Button
              variant="quiet"
              busy={busy === "tailscale"}
              disabledReason={busy && busy !== "tailscale" ? "Please wait…" : undefined}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy("tailscale");
                setError(null);
                try {
                  const value = await api.post<{ links: Address[]; tailscaleSetup?: boolean }>(
                    "/api/access-links/tailscale",
                  );
                  setLinks(value.links);
                  setTailscaleSetup(!!value.tailscaleSetup);
                } catch {
                  setError(
                    "Tailscale could not be enabled. Check Tailscale is signed in and HTTPS is enabled, then try again.",
                  );
                } finally {
                  lock.current = false;
                  setBusy(null);
                }
              }}
            >
              Enable Tailscale link
            </Button>
            <span className="settings-remote-hint">
              Only devices on your Tailscale network can connect.
            </span>
          </div>
        </Group>
      )}
      {links.map((address) => (
        <div key={address.origin}>
          <Group>
            <div className="settings-remote-action">
              <Button
                variant="quiet"
                icon={result?.origin === address.origin && !result.fallback ? "check" : "copy"}
                busy={busy === address.origin}
                disabledReason={
                  address.available === false
                    ? "LAN sharing is not enabled"
                    : busy && busy !== address.origin
                      ? "Creating a link…"
                      : undefined
                }
                onClick={() => void copy(address.origin)}
              >
                <StableText
                  choices={[
                    `Copy ${address.label.toLowerCase()} link`,
                    `${address.label} link copied`,
                  ]}
                  value={
                    result?.origin === address.origin && !result.fallback
                      ? `${address.label} link copied`
                      : `Copy ${address.label.toLowerCase()} link`
                  }
                />
              </Button>
              <span className="settings-remote-hint settings-access-origin">{address.origin}</span>
            </div>
          </Group>
          <GroupNote>{address.description}</GroupNote>
        </div>
      ))}
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
        <GroupNote>
          <span role="alert">{error}</span>{" "}
          <Button variant="quiet" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </Button>
        </GroupNote>
      )}
    </div>
  );
}
