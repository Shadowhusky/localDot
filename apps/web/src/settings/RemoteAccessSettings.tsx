import { useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { copyIssuedLink, LinkNotCopied } from "../notify/home-screen-link.ts";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";

type Status = {
  supported: boolean;
  enabled: boolean;
  state: "off" | "connecting" | "online" | "offline";
  url: string | null;
  detail: string;
};
export function RemoteAccessSettings({ api }: { api: ApiClient }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  const [copiedUntil, setCopiedUntil] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const revision = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    let disposed = false,
      unavailable = false,
      reading = false;
    const read = async () => {
      if (unavailable || document.hidden || saving.current || reading) return;
      reading = true;
      const current = revision.current;
      try {
        const result = await api.get<Status>("/api/remote-access");
        if (!disposed && current === revision.current) {
          setStatus(result);
          setLoadError(null);
        }
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 404) unavailable = true;
        else if (!disposed && current === revision.current)
          setLoadError("Remote access status couldn't load. Retrying…");
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    const expiresAt = link?.expiresAt ?? copiedUntil;
    if (!expiresAt) return;
    const timer = setTimeout(
      () => {
        setLink(null);
        setCopiedUntil(null);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link, copiedUntil]);
  const enable = async (enabled: boolean) => {
    if (saving.current) return;
    saving.current = true;
    revision.current++;
    setBusy(true);
    setError(null);
    setLink(null);
    setCopiedUntil(null);
    try {
      setStatus(await api.put<Status>("/api/remote-access", { enabled }));
    } catch {
      setError("Remote access couldn't be changed. Try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const createLink = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setLink(null);
    setCopiedUntil(null);
    try {
      const issued = api
        .post<{ url: string; expiresAt: number }>("/api/remote-access/link")
        .then((value) => ({ link: value.url, expiresAt: value.expiresAt }));
      const copied = await copyIssuedLink(issued, navigator.clipboard);
      setCopiedUntil(copied.expiresAt);
    } catch (failure) {
      if (failure instanceof LinkNotCopied)
        setLink({ url: failure.link, expiresAt: failure.expiresAt });
      else setError("Couldn't create a link. Check the connection and try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  if (!status) return loadError ? <GroupNote>{loadError}</GroupNote> : null;
  return (
    <div>
      <GroupHead title="Remote access" />
      <Group>
        <Switch
          className="ui-group-row"
          label="Allow remote access"
          description={
            !status.supported
              ? status.detail
              : status.state === "online"
                ? "Connected"
                : status.enabled
                  ? "Connecting…"
                  : "Off · Only on this computer"
          }
          checked={status.enabled}
          disabledReason={
            !status.supported ? "Remote service is not configured" : busy ? "Saving…" : undefined
          }
          onCheckedChange={(on) => void enable(on)}
        />
        {status.enabled && (
          <div className="settings-remote-action">
            <Button
              variant="quiet"
              icon={copiedUntil ? "check" : "copy"}
              busy={busy}
              disabledReason={status.state !== "online" ? "Wait until connected" : undefined}
              onClick={() => void createLink()}
            >
              {copiedUntil ? "Link copied" : "Copy sign-in link"}
            </Button>
            <span className="settings-remote-hint" role="status">
              {copiedUntil
                ? "Open on your other device within a minute."
                : "One device · Expires in 1 minute"}
            </span>
          </div>
        )}
      </Group>
      <GroupNote>Uses localDot’s relay and Cloudflare, which can process your traffic.</GroupNote>
      <Disclosure inline summary="Privacy details" className="settings-remote-privacy">
        <p>
          Encrypted in transit, but not end-to-end encrypted against the relay. Optional and off by
          default; local access works without it. Keep this computer on while connected. Turn off to
          disconnect remote devices and revoke their access.
        </p>
      </Disclosure>
      {link && (
        <div className="settings-remote-pairing">
          <GroupNote>Copying was blocked. Select this link and copy it manually.</GroupNote>
          <TextField
            aria-label="Remote sign-in link"
            value={link.url}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
      {(error || loadError) && <GroupNote>{error || loadError}</GroupNote>}
    </div>
  );
}
