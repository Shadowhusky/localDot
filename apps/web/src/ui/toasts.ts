import { announce } from "./Announcer.tsx";

// How long a toast that does not persist stays in front once it gets there.
export const SHOWN_FOR = 4000;

export type ToastTone = "neutral" | "success" | "danger";

export interface ToastAction {
  label: string;
  onAction(): void;
}

export interface ToastOptions {
  // Showing again under the same id replaces that toast and brings it to the front.
  id?: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: ToastAction;
  // Stays until dismissed. A failure stays unless told otherwise.
  persist?: boolean;
}

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  action?: ToastAction;
  persist: boolean;
  // Set once dismissed: it fades back under its anchor, or it was swiped away.
  leaving?: "fade" | "swipe";
}

export interface ToastQueue {
  show(options: ToastOptions): string;
  dismiss(id: string, how?: Toast["leaving"]): void;
  // Drops a dismissed toast once it has left the screen.
  forget(id: string): void;
  // While any reason holds, the front toast's time stands still.
  hold(reason: string, on: boolean): void;
  list(): readonly Toast[];
  subscribe(listener: () => void): () => void;
}

// Newest first. Only the front toast's time runs, so each is in front for its full time before the
// next one behind it comes forward.
export function createToasts(): ToastQueue {
  let list: readonly Toast[] = [];
  const listeners = new Set<() => void>();
  const remaining = new Map<string, number>();
  const holds = new Set<string>();
  let running: { id: string; since: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let made = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const pause = () => {
    if (!running) return;
    clearTimeout(running.timer);
    const left = (remaining.get(running.id) ?? SHOWN_FOR) - (performance.now() - running.since);
    remaining.set(running.id, left);
    running = undefined;
  };

  const run = () => {
    pause();
    const front = list.find((toast) => !toast.leaving);
    if (!front || front.persist || holds.size > 0) return;
    const { id } = front;
    const left = Math.max(0, remaining.get(id) ?? SHOWN_FOR);
    running = { id, since: performance.now(), timer: setTimeout(() => queue.dismiss(id), left) };
  };

  const queue: ToastQueue = {
    show(options) {
      made += 1;
      const id = options.id ?? `toast-${made}`;
      const tone = options.tone ?? "neutral";
      const toast: Toast = {
        id,
        title: options.title,
        description: options.description,
        tone,
        action: options.action,
        persist: options.persist ?? tone === "danger",
      };
      list = [toast, ...list.filter((other) => other.id !== id)];
      remaining.delete(id);
      run();
      emit();
      announce(`toast ${id}`, [toast.title, toast.description].filter(Boolean).join(". "));
      return id;
    },
    dismiss(id, how = "fade") {
      if (!list.some((toast) => toast.id === id && !toast.leaving)) return;
      list = list.map((toast) => (toast.id === id ? { ...toast, leaving: how } : toast));
      remaining.delete(id);
      run();
      emit();
    },
    forget(id) {
      const kept = list.filter((toast) => toast.id !== id || !toast.leaving);
      if (kept.length === list.length) return;
      list = kept;
      emit();
    },
    hold(reason, on) {
      if (on === holds.has(reason)) return;
      if (on) holds.add(reason);
      else holds.delete(reason);
      run();
    },
    list: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return queue;
}
