import type { PreviewItem, PreviewRequest, PreviewServer } from "@localdot/protocol";
import { useEffect } from "react";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupRow } from "../ui/Group.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { type Previews, requestKey, unavailable, usePreviews } from "./PreviewsContext.tsx";
import "../ui/previews.css";

// An address without its scheme, as the computer's servers print it.
const shownAddress = (address: string) => address.replace(/^https?:\/\//, "").replace(/\/$/, "");

// One web app to open: a server answering in the computer, or a *.localhost site one names (several
// can share a port).
interface App {
  address: string;
  request: PreviewRequest;
  server: PreviewServer;
}

function appsOf(servers: readonly PreviewServer[], previews: readonly PreviewItem[]): App[] {
  return servers.flatMap((server) => [
    { address: shownAddress(server.url), request: { port: server.port }, server },
    ...previews
      .filter((preview) => {
        const url = new URL(preview.target);
        return url.hostname.endsWith(".localhost") && Number(url.port) === server.port;
      })
      .map((preview) => ({
        address: shownAddress(preview.target),
        request: { url: preview.target },
        server,
      })),
  ]);
}

// A server that stops answering leaves the list ten minutes after it last did.
function stateText(server: PreviewServer, now: number): string {
  if (server.state === "answering") return "Running";
  const minutes = Math.floor((now - Date.parse(server.seenAt)) / 60_000);
  return minutes < 1 ? "Not answering" : `Not answering for ${minutes} min`;
}

// The web apps dot runs in its computer, to open on the owner's devices: the Activity's Previews tab.
export function PreviewsPanel({ active }: { active: boolean }) {
  const previews = usePreviews();
  const watch = previews?.watch;
  useEffect(() => (active && watch ? watch() : undefined), [active, watch]);
  if (!previews) return null;
  const { status } = previews;
  if (!status)
    return (
      <p className="activity-empty">
        {previews.settled
          ? "Previews aren't available for this computer."
          : "Looking for web apps in dot's computer…"}
      </p>
    );
  const apps = appsOf(status.servers, status.previews);
  const notice = status.state === "ready" ? null : unavailable(status.state, status.message);
  return (
    <div className="previews-panel">
      <p className="previews-intro">
        Web apps dot runs on its computer. Open one on this device or your phone.
      </p>
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
      {apps.length > 0 && (
        <section aria-label="Web apps in dot's computer">
          <Group>
            {apps.map((app) => (
              <AppRow key={app.address} app={app} previews={previews} />
            ))}
          </Group>
        </section>
      )}
      {apps.length > 0 && status.previews.length > 0 && (
        <Group>
          <GroupRow
            label="Signed-in devices"
            detail="Each stays signed in to an app until it goes unused for two hours."
            trailing={
              <Button
                size="sm"
                variant="quiet"
                busy={previews.pending.has("sign-out")}
                onClick={(event) => previews.signOut(event.currentTarget)}
              >
                Sign out
              </Button>
            }
          />
        </Group>
      )}
      {status.state === "ready" && !apps.length && (
        <EmptyState layout="start" title="No web apps running">
          When dot starts one in its computer, such as a dev server, it shows up here.
        </EmptyState>
      )}
    </div>
  );
}

function AppRow({ app, previews }: { app: App; previews: Previews }) {
  const { server, address, request } = app;
  const title = "url" in request ? undefined : server.title;
  // A title names the app, so its address says where it is; else its program does.
  const where = title ? address : server.name;
  return (
    <GroupRow
      label={title ?? address}
      detail={
        <>
          {where && `${where} · `}
          <span className="preview-app-state" data-state={server.state}>
            {stateText(server, Date.now())}
          </span>
        </>
      }
      trailing={
        <>
          <IconButton
            icon="copy"
            label={`Copy link to ${address}`}
            aria-busy={previews.pending.has(`copy ${requestKey(request)}`) || undefined}
            onClick={(event) => previews.copy(request, event.currentTarget)}
          />
          <Button
            size="sm"
            aria-label={`Open preview of ${address}`}
            busy={previews.pending.has(requestKey(request))}
            onClick={(event) => previews.open(request, event.currentTarget)}
          >
            Open
          </Button>
        </>
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
