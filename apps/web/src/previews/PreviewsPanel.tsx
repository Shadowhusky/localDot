import type { PreviewItem, PreviewServer } from "@localdot/protocol";
import { useEffect, useId } from "react";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { type Previews, requestKey, unavailable, usePreviews } from "./PreviewsContext.tsx";
import "../ui/previews.css";

// An address without its scheme, as the computer's servers print it.
const shownAddress = (address: string) => address.replace(/^https?:\/\//, "").replace(/\/$/, "");
const portOf = (address: string) => {
  if (!URL.canParse(address)) return undefined;
  const url = new URL(address);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
};

// What listens in dot's computer, and the previews open on the owner's devices: the Activity's
// Previews tab.
export function PreviewsPanel({ active }: { active: boolean }) {
  const previews = usePreviews();
  const watch = previews?.watch;
  useEffect(() => (active && watch ? watch() : undefined), [active, watch]);
  const headId = useId();
  if (!previews) return null;
  const { status } = previews;
  if (!status)
    return (
      <p className="activity-empty">
        {previews.settled
          ? "Previews aren't available for this computer."
          : "Looking for servers in dot's computer…"}
      </p>
    );
  const opened = status.previews;
  const previewed = new Set(opened.map((preview) => portOf(preview.target)));
  const servers = status.servers.filter((server) => !previewed.has(server.port));
  const notice = status.state === "ready" ? null : unavailable(status.state, status.message);
  return (
    <div className="previews-panel">
      {status.state === "needs-update" && (
        <Banner
          tone="attention"
          title="Update your computer to open previews"
          actions={<UpdateAction previews={previews} />}
        >
          {notice?.message}
        </Banner>
      )}
      {status.state === "needs-tailscale" && (
        <Banner
          tone="attention"
          title="Previews open over Tailscale"
          actions={
            <Button size="sm" onClick={(event) => previews.openSettings(event.currentTarget)}>
              Open settings
            </Button>
          }
        >
          {notice?.message}
        </Banner>
      )}
      {status.state === "computer-off" && (
        <EmptyState layout="start" title="Your computer is off">
          {notice?.message}
        </EmptyState>
      )}
      {opened.length > 0 && (
        <section aria-labelledby={`${headId}-open`}>
          <GroupHead id={`${headId}-open`} title="Open previews" />
          <Group>
            {opened.map((preview) => (
              <PreviewRow
                key={preview.id}
                preview={preview}
                name={status.servers.find((server) => server.port === portOf(preview.target))?.name}
                previews={previews}
              />
            ))}
          </Group>
          <GroupNote>Stop closes the preview's link. The server keeps running.</GroupNote>
        </section>
      )}
      {servers.length > 0 && (
        <section aria-labelledby={`${headId}-servers`}>
          <GroupHead id={`${headId}-servers`} title="Servers in dot's computer" />
          <Group>
            {servers.map((server) => (
              <ServerRow key={server.port} server={server} previews={previews} />
            ))}
          </Group>
        </section>
      )}
      {status.state === "ready" && !opened.length && !servers.length && (
        <EmptyState layout="start" title="No servers yet">
          When dot starts a server in its computer, open it here on any of your devices.
        </EmptyState>
      )}
    </div>
  );
}

function PreviewRow({
  preview,
  name,
  previews,
}: {
  preview: PreviewItem;
  // The program serving it, when the computer can tell.
  name?: string;
  previews: Previews;
}) {
  const label = shownAddress(preview.target);
  const request = { url: preview.target };
  return (
    <GroupRow
      label={label}
      detail={name}
      trailing={
        <>
          <Button
            size="sm"
            aria-label={`Open preview of ${label}`}
            busy={previews.pending.has(requestKey(request))}
            onClick={(event) => previews.open(request, event.currentTarget)}
          >
            Open
          </Button>
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Stop preview of ${label}`}
            busy={previews.pending.has(preview.id)}
            onClick={(event) => previews.stop(preview.id, event.currentTarget)}
          >
            Stop
          </Button>
        </>
      }
    />
  );
}

function ServerRow({ server, previews }: { server: PreviewServer; previews: Previews }) {
  const label = shownAddress(server.url);
  const request = { port: server.port };
  return (
    <GroupRow
      label={label}
      detail={server.name}
      trailing={
        <Button
          size="sm"
          aria-label={`Open preview of ${label}`}
          busy={previews.pending.has(requestKey(request))}
          onClick={(event) => previews.open(request, event.currentTarget)}
        >
          Open
        </Button>
      }
    />
  );
}

function UpdateAction({ previews }: { previews: Previews }) {
  const update = previews.update;
  if (update?.available)
    return (
      <Button
        size="sm"
        busy={update.busy}
        disabledReason={update.waitReason}
        onClick={() => update.run()}
      >
        Update
      </Button>
    );
  return (
    <Button size="sm" onClick={(event) => previews.openSettings(event.currentTarget)}>
      Open settings
    </Button>
  );
}
