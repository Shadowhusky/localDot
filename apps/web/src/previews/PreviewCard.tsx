import type { ResultPreview } from "@localdot/protocol";
import { useEffect } from "react";
import type { AgentResult } from "../agent/model.ts";
import { Button } from "../ui/Button.tsx";
import { Group, GroupRow, IconTile } from "../ui/Group.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { macAddress, OpenOnMac, openOnMac } from "./OpenOnMac.tsx";
import { type Previews, requestKey, usePreviews } from "./PreviewsContext.tsx";
import "../ui/previews.css";

// Each app once, on the newest reply that offers it: a later turn's card takes an earlier one's place,
// so a run of changes to one app never repeats it down the chat.
export function newestOffers(
  results: readonly AgentResult[],
): ReadonlyMap<string, readonly ResultPreview[]> {
  const seen = new Set<string>();
  const offers = new Map<string, readonly ResultPreview[]>();
  for (const result of [...results].reverse()) {
    const fresh = (result.previews ?? []).filter((offer) => !seen.has(offer.url));
    for (const offer of fresh) seen.add(offer.url);
    if (fresh.length) offers.set(result.id, fresh);
  }
  return offers;
}

// A redraw of a reply is owed only when what it offers changes.
export function sameOffers(
  a: readonly ResultPreview[] | undefined,
  b: readonly ResultPreview[] | undefined,
): boolean {
  return a === b || (a?.length === b?.length && !!a?.every((offer, at) => offer === b?.[at]));
}

type CardState = "checking" | "running" | "quiet" | "off" | "stopped" | "unknown";

// What a reply's preview is now. It was running as the turn ended; it may not be since, and what
// listens on its port now may be another program.
export function offerState(
  offer: ResultPreview,
  previews: Pick<Previews, "status" | "settled">,
): CardState {
  const { status } = previews;
  // Read and not answered: localDot can't say which computer it was on, or it has been replaced.
  if (!status) return previews.settled ? "unknown" : "checking";
  if (status.state === "computer-off") return "off";
  // A computer too old to list what it runs still explains itself when the link is tried.
  if (status.state === "needs-update") return "running";
  const server = status.servers.find(
    (entry) =>
      entry.port === offer.port && (!offer.name || !entry.name || entry.name === offer.name),
  );
  if (!server) return "stopped";
  const site = status.previews.find((preview) => preview.target === offer.url);
  return (site?.state ?? server.state) === "answering" ? "running" : "quiet";
}

const shownAddress = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

const WORDS: Record<CardState, string> = {
  checking: "Checking…",
  running: "Running",
  quiet: "Not answering",
  off: "Your computer is off",
  stopped: "Stopped. Ask dot to start it again.",
  unknown: "Can't be checked right now",
};

// A web app a reply comes with, one tap from opening on this device.
export function PreviewCard({ offer }: { offer: ResultPreview }) {
  const previews = usePreviews();
  const watch = previews?.watch;
  useEffect(() => watch?.(), [watch]);
  if (!previews) return null;
  const state = offerState(offer, previews);
  const request = { url: offer.url };
  const address = shownAddress(offer.url);
  const opens = state === "running" || state === "quiet" || state === "checking";
  const onMac = opens ? openOnMac(previews, offer.url) : undefined;
  return (
    <Group className="preview-card" data-state={state}>
      <GroupRow
        leading={<IconTile icon="app-window" />}
        label={offer.title ?? address}
        detail={[
          offer.title ? address : offer.project,
          WORDS[state],
          onMac && `On this Mac at ${macAddress(onMac)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        trailing={
          opens && (
            <>
              <IconButton
                icon="copy"
                label={`Copy link to ${address}`}
                aria-busy={previews.pending.has(`copy ${requestKey(request)}`) || undefined}
                onClick={(event) => previews.copy(request, event.currentTarget)}
              />
              <OpenOnMac
                previews={previews}
                request={request}
                target={offer.url}
                address={address}
                app={offer.project ?? offer.title ?? address}
                port={offer.port}
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
          )
        }
      />
    </Group>
  );
}
