import type { ReactNode } from "react";
import { announce, type Urgency, withdraw as unsay } from "./Announcer.tsx";
import type { IconName } from "./icons.ts";

// A toast waits this long before it shows, so a state that flips straight back shows nothing.
export const SETTLE_MS = 400;
// Once shown, a toast stays at least this long, even with another waiting or its news gone.
export const SHOWN_AT_LEAST = 1600;
// How long a result stays when nothing waits behind it.
export const SHOWN_FOR = 4000;
// A failure stays this long, and a toast with an action yields to one waiting after this long.
export const SHOWN_AT_MOST = 6000;
// The same message never shows again within this long of leaving.
export const REPEAT_MS = 5000;

export type ToastTone = "neutral" | "success" | "danger";

export interface ToastAction {
  label: string;
  onAction(): void;
}

export interface ToastOptions {
  // Showing again under the same id changes that toast in place, or the one still waiting.
  id?: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  // In place of the tone's own glyph.
  icon?: IconName;
  // A toast with an action stays until it is dismissed, unless others wait.
  action?: ToastAction;
  // Lines behind a quiet Details disclosure; a toast with them stays like one with an action.
  details?: readonly string[];
  // Shown in the title's place and kept current by itself, such as a progress that counts up; the
  // title is what is announced. A toast with one stays like one with an action.
  live?: ReactNode;
  // "assertive" only for an error that stops work.
  urgency?: Urgency;
}

export interface Toast {
  id: string;
  // Names its element. It stays the same when the toast changes in place, and changes when the
  // toast comes back while its old element is still being swiped off.
  key: string;
  title: string;
  description?: string;
  tone: ToastTone;
  icon?: IconName;
  action?: ToastAction;
  details?: readonly string[];
  live?: ReactNode;
  // Set once dismissed: it fades back under its anchor, or it was swiped away.
  leaving?: "fade" | "swipe";
}

export interface ToastQueue {
  show(options: ToastOptions): string;
  // The user sent it away: it goes at once.
  dismiss(id: string, how?: Toast["leaving"]): void;
  // What it said no longer holds: one still settling never shows, one waiting is dropped, and the
  // one on screen goes once it has been seen.
  withdraw(id: string): void;
  // Drops a dismissed toast once it has left the screen.
  forget(id: string): void;
  // While any reason holds, the toast on screen keeps its time.
  hold(reason: string, on: boolean): void;
  // The toast on screen, then any still leaving.
  list(): readonly Toast[];
  subscribe(listener: () => void): () => void;
}

interface Entry {
  toast: Toast;
  // Two toasts with the same id and words are the same message.
  message: string;
  urgency?: Urgency;
  withdrawn?: boolean;
}

const words = (toast: Toast) => [toast.title, toast.description].filter(Boolean).join(". ");

// One toast on screen at a time; the rest wait their turn in the order they came.
export function createToasts(now: () => number = () => performance.now()): ToastQueue {
  const listeners = new Set<() => void>();
  const holds = new Set<string>();
  const settling = new Map<string, { entry: Entry; timer: ReturnType<typeof setTimeout> }>();
  const waiting: Entry[] = [];
  let front:
    | { entry: Entry; seen: number; since: number | null; timer?: ReturnType<typeof setTimeout> }
    | undefined;
  let leaving: Toast[] = [];
  let list: readonly Toast[] = [];
  // When each message that left may show again.
  const lately = new Map<string, number>();
  let made = 0;

  const emit = () => {
    list = front ? [front.entry.toast, ...leaving] : leaving;
    for (const listener of listeners) listener();
  };

  const allowed = ({ toast, withdrawn }: Entry) => {
    if (withdrawn) return SHOWN_AT_LEAST;
    const stays = !!toast.action || !!toast.details?.length || toast.live !== undefined;
    if (waiting.length) return stays ? SHOWN_AT_MOST : SHOWN_AT_LEAST;
    if (stays) return Number.POSITIVE_INFINITY;
    return toast.tone === "danger" ? SHOWN_AT_MOST : SHOWN_FOR;
  };

  const retire = (how: NonNullable<Toast["leaving"]>) => {
    if (!front) return;
    clearTimeout(front.timer);
    const { toast, message } = front.entry;
    front = undefined;
    leaving = [...leaving.filter((other) => other.key !== toast.key), { ...toast, leaving: how }];
    lately.set(message, now() + REPEAT_MS);
    unsay(`toast ${toast.id}`);
  };

  // Brings the next toast forward when there is none on screen, and lets the one on screen go once
  // it has had its time. Time on screen counts only while nothing holds it.
  const advance = () => {
    for (;;) {
      if (!front) {
        const next = waiting.shift();
        if (!next) return;
        front = { entry: next, seen: 0, since: null };
        announce(`toast ${next.toast.id}`, words(next.toast), next.urgency);
      }
      clearTimeout(front.timer);
      const at = now();
      if (front.since !== null) front.seen += at - front.since;
      front.since = null;
      if (holds.size > 0) return;
      const left = allowed(front.entry) - front.seen;
      if (left > 0) {
        front.since = at;
        if (Number.isFinite(left)) front.timer = setTimeout(update, left);
        return;
      }
      retire("fade");
    }
  };
  const update = () => {
    advance();
    emit();
  };

  const queue: ToastQueue = {
    show(options) {
      made += 1;
      const id = options.id ?? `toast-${made}`;
      const message = [
        options.id ?? "",
        options.title,
        options.description ?? "",
        ...(options.details ?? []),
      ].join("\n");
      const same = (entry: Entry | undefined) => entry?.message === message;
      if (
        (lately.get(message) ?? Number.NEGATIVE_INFINITY) > now() ||
        same(front?.entry) ||
        waiting.some(same) ||
        [...settling.values()].some(({ entry }) => same(entry))
      )
        return id;
      const entry = (key: string): Entry => ({
        toast: {
          id,
          key,
          title: options.title,
          description: options.description,
          tone: options.tone ?? "neutral",
          icon: options.icon,
          action: options.action,
          details: options.details,
          live: options.live,
        },
        message,
        urgency: options.urgency,
      });
      if (front?.entry.toast.id === id) {
        front.entry = entry(front.entry.toast.key);
        front.seen = 0;
        front.since = null;
        announce(`toast ${id}`, words(front.entry.toast), options.urgency);
        update();
        return id;
      }
      const queued = waiting.findIndex((other) => other.toast.id === id);
      if (queued >= 0) {
        waiting[queued] = entry(`${id}:${made}`);
        return id;
      }
      clearTimeout(settling.get(id)?.timer);
      const next = entry(`${id}:${made}`);
      settling.set(id, {
        entry: next,
        timer: setTimeout(() => {
          settling.delete(id);
          waiting.push(next);
          update();
        }, SETTLE_MS),
      });
      return id;
    },
    dismiss(id, how = "fade") {
      if (front?.entry.toast.id === id) {
        retire(how);
        update();
        return;
      }
      queue.withdraw(id);
    },
    withdraw(id) {
      const pending = settling.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        settling.delete(id);
      }
      const queued = waiting.findIndex((entry) => entry.toast.id === id);
      if (queued >= 0) waiting.splice(queued, 1);
      if (front?.entry.toast.id === id && !front.entry.withdrawn) {
        front.entry = { ...front.entry, withdrawn: true };
        update();
      }
    },
    forget(id) {
      const kept = leaving.filter((toast) => toast.id !== id);
      if (kept.length === leaving.length) return;
      leaving = kept;
      emit();
    },
    hold(reason, on) {
      if (on === holds.has(reason)) return;
      if (on) holds.add(reason);
      else holds.delete(reason);
      advance();
    },
    list: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return queue;
}
