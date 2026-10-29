import { type ReactNode, useEffect, useMemo } from "react";
import { Chip } from "../ui/Chip.tsx";
import {
  type LocalUrl,
  localUrl,
  localUrlsIn,
  mayBeComputer,
  mentionsPrivateAddress,
} from "./local-urls.ts";
import { requestKey, usePreviews } from "./PreviewsContext.tsx";
import "../ui/previews.css";

const NONE: readonly string[] = [];

export function PreviewChip({ url, inline = false }: { url: LocalUrl; inline?: boolean }) {
  const previews = usePreviews();
  const want = previews?.want;
  useEffect(() => want?.(), [want]);
  if (!previews) return null;
  const request = { url: url.href };
  return (
    <Chip
      variant="outline"
      icon="share"
      className="preview-chip"
      data-inline={inline || undefined}
      data-state={previews.status?.state}
      aria-label={`Open preview of ${url.label}`}
      aria-busy={previews.pending.has(requestKey(request)) || undefined}
      onClick={(event) => previews.open(request, event.currentTarget)}
    >
      Open preview
    </Chip>
  );
}

// The servers an output or a piece of code names, each once.
export function PreviewChips({
  text,
  limit = 3,
  inline = false,
}: {
  text: string;
  limit?: number;
  inline?: boolean;
}) {
  const previews = usePreviews();
  const on = previews !== null;
  const addresses = previews?.status?.addresses ?? NONE;
  const found = useMemo(
    () => (on ? localUrlsIn(text, addresses, limit) : []),
    [on, text, addresses, limit],
  );
  const asks = on && !previews?.settled && mentionsPrivateAddress(text);
  const want = previews?.want;
  useEffect(() => {
    if (asks) want?.();
  }, [asks, want]);
  if (!found.length) return null;
  const chips = found.map((url) => <PreviewChip key={url.href} url={url} inline={inline} />);
  return inline ? (
    <span className="preview-chips" data-inline="">
      {chips}
    </span>
  ) : (
    <div className="preview-chips">{chips}</div>
  );
}

// A link dot wrote to a server in its computer opens as a preview; any other link is left as it is.
export function LocalAddress({
  href,
  text,
  children,
}: {
  href: string;
  text: string;
  children: ReactNode;
}) {
  const previews = usePreviews();
  const on = previews !== null;
  const addresses = previews?.status?.addresses ?? NONE;
  const local = useMemo(() => (on ? localUrl(href, addresses) : undefined), [on, href, addresses]);
  const asks = on && !local && !previews?.settled && mayBeComputer(href);
  const want = previews?.want;
  useEffect(() => {
    if (asks) want?.();
  }, [asks, want]);
  if (!local) return children;
  return (
    <span className="md-local">
      <span className="md-local-address">{text}</span>
      <PreviewChip url={local} inline />
    </span>
  );
}
