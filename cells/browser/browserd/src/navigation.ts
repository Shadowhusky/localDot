import { z as schema } from "zod";
import { BROWSER_NAVIGATION_TIMEOUT_MS } from "../../../../packages/protocol/src/browser-control.ts";
import type { GuardedCdp } from "./cdp.ts";
import { navigable } from "./cdp-guard.ts";

export { BROWSER_NAVIGATION_TIMEOUT_MS };
export const MAX_NAVIGATION_EVENTS = 256;
// Documents a page may move on to by itself after the requested one commits, as web.telegram.org
// sends itself to /k/ by script and a challenge page reloads itself.
export const FOLLOWED_DOCUMENTS = 3;

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

export async function navigateOwnedDocument(
  options: OwnedNavigationOptions,
): Promise<"download" | void> {
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
  // The root's documents in the order they committed: the requested one first, then any the page
  // moved on to by itself.
  const committed: schema.infer<typeof frameSchema>[] = [];
  let withinDocument: string | undefined;
  let eventCount = 0;
  const readyDocuments = new Set<string>();
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
      const requested = committed[0];
      if (requested && requested.loaderId !== acknowledgement.loaderId) return refuse("stale");
      const latest = committed.at(-1);
      if (latest && readyDocuments.has(latest.loaderId)) loaded.resolve();
    } else {
      if (committed.length) return refuse("stale");
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
      {
        sessionId: options.sessionId,
        signal: lifetime.signal,
        // Turning events on changes nothing to answer for if it is given up on.
        patience: BROWSER_NAVIGATION_TIMEOUT_MS,
      },
    );
    check();
    initial = await readFrame();
    check();
    listen("Page.frameNavigated", (params) => {
      const frame = schema.object({ frame: frameSchema }).parse(params).frame;
      if (frame.parentId) return;
      count();
      if (
        frame.id !== initial?.id ||
        withinDocument !== undefined ||
        committed.some((document) => document.loaderId === frame.loaderId) ||
        committed.length > FOLLOWED_DOCUMENTS
      )
        return refuse("stale");
      committed.push(frame);
    });
    listen("Page.navigatedWithinDocument", (params) => {
      const event = schema
        .object({ frameId: identifier, url: schema.string().max(32768) })
        .parse(params);
      if (event.frameId !== initial?.id) return;
      count();
      // The committed document may rewrite its own URL with the history API before it loads, as
      // sign-in pages do; the final frame check still requires that same document.
      if (committed.length) return;
      if (withinDocument !== undefined) return refuse("stale");
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
      // A usable document need not finish every image, tracker or long-lived resource.
      // Correlate DOM readiness with the acknowledged root loader, never a generic page event.
      if (event.frameId !== initial?.id || !["DOMContentLoaded", "load"].includes(event.name))
        return;
      count();
      readyDocuments.add(event.loaderId);
    });
    check();
    options.preflight();
    dispatched = true;
    const reply = await options.broker.send(
      "Page.navigate",
      { url: options.url },
      {
        sessionId: options.sessionId,
        signal: lifetime.signal,
        // Chromium answers once the document commits: a slow site is not a stuck browser.
        patience: BROWSER_NAVIGATION_TIMEOUT_MS,
      },
    );
    check();
    acknowledgement = acknowledgementSchema.parse(reply);
    // A download leaves the current document in place. Chromium may report ERR_ABORTED
    // alongside isDownload because no replacement document commits. Do not retire the
    // browser or wait for a load event that will never arrive.
    if (acknowledgement.isDownload) {
      const final = await readFrame();
      check();
      if (
        acknowledgement.frameId !== initial.id ||
        (acknowledgement.errorText && acknowledgement.errorText !== "net::ERR_ABORTED") ||
        committed.length ||
        withinDocument !== undefined ||
        final.id !== initial.id ||
        final.loaderId !== initial.loaderId ||
        frameUrl(final) !== frameUrl(initial)
      )
        throw new BrowserNavigationError("stale");
      return "download";
    }
    if (
      acknowledgement.frameId !== initial.id ||
      acknowledgement.errorText ||
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
      final.loaderId !==
        (acknowledgement.loaderId ? committed.at(-1)?.loaderId : initial.loaderId) ||
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
