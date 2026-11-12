import type {
  PreviewItem,
  PreviewRequest,
  PreviewServer,
  PreviewsStatus,
} from "@localdot/protocol";
import { useEffect, useId } from "react";
import { t } from "../i18n/index.ts";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupHead, GroupRow } from "../ui/Group.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { TOUCH, useMediaQuery } from "../ui/media.ts";
import { macAddress, PreviewActions } from "./OpenOnMac.tsx";
import { type Previews, requestKey, unavailable, usePreviews } from "./PreviewsContext.tsx";
import "../ui/previews.css";

// An address without its scheme, as the computer's servers print it.
const shownAddress = (address: string) => address.replace(/^https?:\/\//, "").replace(/\/$/, "");

// One web app to open: a server answering in the computer, or a *.localhost site one names (several
// can share a port), which answers for itself.
interface App {
  address: string;
  request: PreviewRequest;
  server: PreviewServer;
  state: PreviewServer["state"];
}

function appsOf(servers: readonly PreviewServer[], previews: readonly PreviewItem[]): App[] {
  return servers.flatMap((server) => [
    {
      address: shownAddress(server.url),
      request: { port: server.port },
      server,
      state: server.state,
    },
    ...previews
      .filter((preview) => {
        const url = new URL(preview.target);
        return url.hostname.endsWith(".localhost") && Number(url.port) === server.port;
      })
      .map((preview) => ({
        address: shownAddress(preview.target),
        request: { url: preview.target },
        server,
        state: preview.state ?? server.state,
      })),
  ]);
}

// The apps this conversation runs lead. Another conversation's, and a copy that has been replaced or
// has stopped answering, are real, so they stay reachable, but folded away. A computer that can't say
// who started a server (one not yet updated) lists them all as its own.
export function arrangeApps(apps: readonly App[]): {
  running: App[];
  others: App[];
  fading: App[];
} {
  const fades = (app: App) => app.state !== "answering" || !!app.server.older;
  return {
    running: apps.filter((app) => !fades(app) && app.server.here !== false),
    others: apps.filter((app) => !fades(app) && app.server.here === false),
    fading: apps.filter(fades),
  };
}

// A server that stops answering leaves the list ten minutes after it last did.
function stateText(app: App, now: number): string {
  if (app.state === "answering") return app.server.older ? t`Replaced by a newer copy` : t`Running`;
  const minutes = Math.floor((now - Date.parse(app.server.seenAt)) / 60_000);
  return minutes < 1 ? t`Not answering` : t`Not answering for ${minutes} min`;
}

// The web apps dot runs in its computer, to open on the owner's devices: the panel's Previews tab.
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
          ? t`Previews aren't available for this computer.`
          : t`Looking for web apps in dot's computer…`}
      </p>
    );
  const apps = appsOf(status.servers, status.previews);
  const { running, others, fading } = arrangeApps(apps);
  const notice = status.state === "ready" ? null : unavailable(status.state, status.message);
  return (
    <div className="previews-panel">
      <p className="previews-intro">
        {t`Web apps dot runs on its computer. Open one on this device or your phone.`}
      </p>
      {status.state === "needs-update" && (
        <Banner
          tone="attention"
          title={t`Update your computer to open previews`}
          actions={<UpdateAction previews={previews} />}
        >
          {notice?.message}
        </Banner>
      )}
      {status.state === "needs-tailscale" && (
        <Banner
          tone="attention"
          title={t`Previews open over Tailscale`}
          actions={
            <Button size="sm" onClick={(event) => previews.openSettings(event.currentTarget)}>
              {t`Open settings`}
            </Button>
          }
        >
          {notice?.message}
        </Banner>
      )}
      {status.state === "computer-off" && (
        <EmptyState layout="start" title={t`Your computer is off`}>
          {notice?.message}
        </EmptyState>
      )}
      {running.length > 0 && (
        <section aria-label={t`Web apps in dot's computer`}>
          <AppRows apps={running} previews={previews} />
        </section>
      )}
      {status.state === "ready" && !running.length && apps.length > 0 && (
        <EmptyState layout="start" title={t`None running from this conversation`} />
      )}
      {others.length > 0 && (
        <FoldedApps label={t`From other conversations`} apps={others} previews={previews} />
      )}
      {fading.length > 0 && (
        <FoldedApps label={t`Replaced or not answering`} apps={fading} previews={previews} />
      )}
      <OnThisMac previews={previews} status={status} />
      {apps.length > 0 && status.previews.length > 0 && (
        <Group>
          <GroupRow
            label={t`Signed-in devices`}
            detail={t`Each stays signed in to an app until it goes unused for two hours.`}
            trailing={
              <Button
                size="sm"
                variant="quiet"
                busy={previews.pending.has("sign-out")}
                onClick={(event) => previews.signOut(event.currentTarget)}
              >
                {t`Sign out`}
              </Button>
            }
          />
        </Group>
      )}
      {status.state === "ready" && !apps.length && (
        <EmptyState layout="start" title={t`No web apps running`}>
          {t`When dot starts one in its computer, such as a dev server, it shows up here.`}
        </EmptyState>
      )}
    </div>
  );
}

function AppRows({ apps, previews }: { apps: readonly App[]; previews: Previews }) {
  return (
    <Group>
      {apps.map((app) => (
        <AppRow key={app.address} app={app} previews={previews} />
      ))}
    </Group>
  );
}

function FoldedApps({
  label,
  apps,
  previews,
}: {
  label: string;
  apps: readonly App[];
  previews: Previews;
}) {
  return (
    <Disclosure
      className="previews-folded"
      summary={label}
      meta={<span className="num">{apps.length}</span>}
    >
      <AppRows apps={apps} previews={previews} />
    </Disclosure>
  );
}

function AppRow({ app, previews }: { app: App; previews: Previews }) {
  const { server, address, request } = app;
  const title = "url" in request ? undefined : server.title;
  // A title names the app, so its address says where it is; else its folder or program does.
  const where = title ? address : (server.project ?? server.name);
  const target = "url" in request ? request.url : server.url;
  return (
    <GroupRow
      label={title ?? address}
      detail={
        <>
          {where && `${where} · `}
          <span className="preview-app-state" data-state={app.state}>
            {stateText(app, Date.now())}
          </span>
        </>
      }
      trailing={
        <>
          <PreviewActions
            previews={previews}
            request={request}
            target={target}
            address={address}
            app={server.project ?? title ?? address}
            port={server.port}
          />
          {/* A *.localhost site is a name on a port its proxy serves: stopping it would stop them all. */}
          {"port" in request && (
            <IconButton
              icon="x"
              label={t`Stop ${address}`}
              aria-busy={previews.pending.has(`stop ${server.port}`) || undefined}
              onClick={(event) => previews.stop(server.port, event.currentTarget)}
            />
          )}
        </>
      }
    />
  );
}

// The apps open on the Mac's own localhost. Each holds a port there, so each can be closed; a phone
// can only close one, as it has no way to the Mac's localhost.
function OnThisMac({ previews, status }: { previews: Previews; status: PreviewsStatus }) {
  const heading = useId();
  const touch = useMediaQuery(TOUCH);
  const open = status.previews.filter((preview) => preview.local);
  if (!open.length) return null;
  return (
    <section aria-labelledby={heading}>
      <GroupHead id={heading} title={t`On this Mac`} />
      <Group>
        {open.map((preview) => {
          const address = macAddress(preview);
          const local = Number(new URL(preview.origin).port);
          const server = status.servers.find((entry) => entry.url === preview.target);
          const request: PreviewRequest = server
            ? { port: server.port, local }
            : { url: preview.target, local };
          const target = shownAddress(preview.target);
          return (
            <GroupRow
              key={preview.id}
              label={address}
              detail={server?.title ? `${server.title} · ${target}` : target}
              trailing={
                <>
                  {!touch && (
                    <Button
                      size="sm"
                      aria-label={t`Open ${address}`}
                      busy={previews.pending.has(requestKey(request))}
                      onClick={(event) => previews.open(request, event.currentTarget)}
                    >
                      {t`Open`}
                    </Button>
                  )}
                  <IconButton
                    icon="x"
                    label={t`Close ${address} on this Mac`}
                    aria-busy={previews.pending.has(`end ${preview.id}`) || undefined}
                    onClick={(event) => previews.end(preview.id, event.currentTarget)}
                  />
                </>
              }
            />
          );
        })}
      </Group>
    </section>
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
        {t`Update`}
      </Button>
    );
  return (
    <Button size="sm" onClick={(event) => previews.openSettings(event.currentTarget)}>
      {t`Open settings`}
    </Button>
  );
}
