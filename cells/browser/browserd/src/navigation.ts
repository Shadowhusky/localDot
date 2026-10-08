import { z as schema } from "zod";
import type { GuardedCdp } from "./cdp.ts";
import { navigable } from "./cdp-guard.ts";

export const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
export const MAX_NAVIGATION_EVENTS = 256;

const identifier = schema.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const frameSchema = schema.object({
  id: identifier,
  parentId: identifier.optional(),
  loaderId: identifier,
  url: schema.string().max(32768),
  urlFragment: schema.string().max(32768).optional(),
});
const acknowledgementSchema = schema.object({
  frameId: identifier,
  loaderId: identifier.optional(),
  errorText: schema.string().max(8192).optional(),
  isDownload: schema.boolean().optional(),
});

export class BrowserNavigationError extends Error {
  constructor(readonly reason: "request" | "stale" | "unready" | "protocol") {
    super(`Browser navigation refused: ${reason}`);
  }
}

export interface OwnedNavigationOptions {
  readonly broker: Pick<GuardedCdp, "send" | "on">;
  readonly sessionId: string;
  readonly url: string;
  readonly signal?: AbortSignal;
  check(): void;
  preflight(): void;
  ambiguous(): void;
}

function frameUrl(frame: schema.infer<typeof frameSchema>): string {
  try {
    const url = new URL(frame.url);
    if (frame.urlFragment !== undefined) url.hash = frame.urlFragment;
    return url.href;
  } catch {
    throw new BrowserNavigationError("protocol");
  }
}

export async function navigateOwnedDocument(options: OwnedNavigationOptions): Promise<void> {
  if (!navigable(options.url)) throw new BrowserNavigationError("request");
  if (options.signal?.aborted) throw new BrowserNavigationError("stale");
  options.preflight();
  const requestedUrl = new URL(options.url).href;
  const lifetime = new AbortController();
  const loaded = Promise.withResolvers<void>();
  void loaded.promise.catch(() => {});
  let refusal: BrowserNavigationError | undefined;
  let dispatched = false;
  let initial: schema.infer<typeof frameSchema> | undefined;
  let acknowledgement: schema.infer<typeof acknowledgementSchema> | undefined;
  let navigated: schema.infer<typeof frameSchema> | undefined;
  let withinDocument: string | undefined;
  let eventCount = 0;
  const loads = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  const refuse = (reason: BrowserNavigationError["reason"]) => {
    refusal ??= new BrowserNavigationError(reason);
    loaded.reject(refusal);
    lifetime.abort();
  };
  const cancel = () => refuse("stale");
  const timeout = setTimeout(() => refuse("unready"), BROWSER_NAVIGATION_TIMEOUT_MS);
  const count = () => {
    eventCount += 1;
    if (eventCount > MAX_NAVIGATION_EVENTS) throw new BrowserNavigationError("protocol");
  };
  const check = () => {
    if (refusal) throw refusal;
    if (options.signal?.aborted) throw new BrowserNavigationError("stale");
    options.check();
  };
  const complete = () => {
    if (!acknowledgement || !initial || refusal) return;
    if (acknowledgement.loaderId) {
      if (withinDocument !== undefined) return refuse("stale");
      if (navigated && navigated.loaderId !== acknowledgement.loaderId) return refuse("stale");
      if (navigated && loads.has(acknowledgement.loaderId)) loaded.resolve();
    } else {
      if (navigated) return refuse("stale");
      if (withinDocument !== undefined) {
        if (withinDocument !== requestedUrl) return refuse("stale");
        loaded.resolve();
      }
    }
  };
  const listen = (event: string, receive: (params: Readonly<Record<string, unknown>>) => void) => {
    unsubscribe.push(
      options.broker.on(event, (params, sessionId) => {
        if (!dispatched || sessionId !== options.sessionId || refusal) return;
        try {
          receive(params);
          complete();
        } catch {
          refuse("protocol");
        }
      }),
    );
  };
  const readFrame = async () => {
    const reply = await options.broker.send(
      "Page.getFrameTree",
      {},
      { sessionId: options.sessionId, signal: lifetime.signal },
    );
    const frame = schema.object({ frameTree: schema.object({ frame: frameSchema }) }).parse(reply)
      .frameTree.frame;
    if (frame.parentId) throw new BrowserNavigationError("protocol");
    return frame;
  };
  try {
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    check();
    await options.broker.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      { sessionId: options.sessionId, signal: lifetime.signal },
    );
    check();
    initial = await readFrame();
    check();
    listen("Page.frameNavigated", (params) => {
      const frame = schema.object({ frame: frameSchema }).parse(params).frame;
      if (frame.parentId) return;
      count();
      if (frame.id !== initial?.id || navigated || withinDocument !== undefined)
        return refuse("stale");
      navigated = frame;
    });
    listen("Page.navigatedWithinDocument", (params) => {
      const event = schema
        .object({ frameId: identifier, url: schema.string().max(32768) })
        .parse(params);
      if (event.frameId !== initial?.id) return;
      count();
      if (withinDocument !== undefined || navigated) return refuse("stale");
      withinDocument = new URL(event.url).href;
    });
    listen("Page.lifecycleEvent", (params) => {
      const event = schema
        .object({
          frameId: identifier,
          loaderId: identifier,
          name: schema.string().min(1).max(128),
          timestamp: schema.number().finite().nonnegative(),
        })
        .parse(params);
      if (event.frameId !== initial?.id || event.name !== "load") return;
      count();
      loads.add(event.loaderId);
    });
    check();
    options.preflight();
    dispatched = true;
    const reply = await options.broker.send(
      "Page.navigate",
      { url: options.url },
      { sessionId: options.sessionId, signal: lifetime.signal },
    );
    check();
    acknowledgement = acknowledgementSchema.parse(reply);
    if (
      acknowledgement.frameId !== initial.id ||
      acknowledgement.errorText ||
      acknowledgement.isDownload ||
      acknowledgement.loaderId === initial.loaderId
    )
      throw new BrowserNavigationError("unready");
    complete();
    await loaded.promise;
    check();
    const final = await readFrame();
    check();
    if (
      final.id !== initial.id ||
      final.loaderId !== (acknowledgement.loaderId ?? initial.loaderId) ||
      !navigable(frameUrl(final)) ||
      (!acknowledgement.loaderId && frameUrl(final) !== requestedUrl)
    )
      throw new BrowserNavigationError("stale");
  } catch (error) {
    if (dispatched) {
      try {
        options.ambiguous();
      } catch {}
    }
    throw error instanceof BrowserNavigationError ? error : new BrowserNavigationError("protocol");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
    for (const dispose of unsubscribe) dispose();
    lifetime.abort();
  }
}
