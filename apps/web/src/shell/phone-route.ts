import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Where a phone is in its stack, which the address says, so Back, a reload and a link all work. The
// id is a conversation's latest task, `new` for one not yet started, or `current` for whichever the
// daemon has as current.
export type PhoneRoute = { level: 0; id?: undefined } | { level: 1 | 2; id: string };

export const LIST: PhoneRoute = { level: 0 };
const ADDRESS = /^#\/c\/([^/]+)(\/computer)?$/;
// How soon after a touch at the edge a Back is taken to be Safari's own swipe, for browsers that
// don't say so through the event.
const EDGE_PX = 24;
const EDGE_BACK_MS = 1500;

export function parsePhoneRoute(hash: string): PhoneRoute {
  const found = ADDRESS.exec(hash);
  const id = found?.[1];
  if (!id) return LIST;
  return { level: found?.[2] ? 2 : 1, id };
}

export function phoneHash(route: PhoneRoute): string {
  if (route.level === 0) return "";
  return `#/c/${route.id}${route.level === 2 ? "/computer" : ""}`;
}

export const sameRoute = (a: PhoneRoute, b: PhoneRoute) => a.level === b.level && a.id === b.id;

const address = (route: PhoneRoute) =>
  `${window.location.pathname}${window.location.search}${phoneHash(route)}`;

// Safari's own edge swipe has already drawn the page leaving, so it must not be animated again.
export const browserTab = () =>
  !(
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone
  );

export interface PhoneNav {
  route: PhoneRoute;
  // The latest change came with the browser's own transition, so it draws at once.
  drawnByBrowser: { current: boolean };
  push(route: PhoneRoute): void;
  replace(route: PhoneRoute): void;
  // One level up, as the browser's Back does.
  back(): void;
  // A conversation on show: over the list, or in place of the one on show.
  show(id: string): void;
  // Coming into the stack from the other view style: at this conversation, with the list under it.
  enter(id: string): void;
  // Leaving the stack: the address stops naming a place in it.
  leave(): void;
  // The conversation the page last asked the daemon to take up, or the address has settled on.
  asked: { current: string | null };
}

export function usePhoneRoute(on: boolean): PhoneNav {
  const [route, setRoute] = useState<PhoneRoute>(() =>
    on ? parsePhoneRoute(window.location.hash) : LIST,
  );
  const now = useRef(route);
  now.current = route;
  const drawnByBrowser = useRef(false);
  // Backs this page asked for, whose popstate it has already drawn.
  const backs = useRef(0);
  const edgeAt = useRef(Number.NEGATIVE_INFINITY);

  const arrive = useCallback((next: PhoneRoute, byBrowser: boolean) => {
    if (sameRoute(next, now.current)) return;
    drawnByBrowser.current = byBrowser;
    now.current = next;
    setRoute(next);
  }, []);

  useEffect(() => {
    if (!on) return;
    // Opening a link builds the stack under it, so Back has somewhere to go. The state says the
    // entries are this stack's, across a reload too.
    const opened = parsePhoneRoute(window.location.hash);
    if (opened.level > 0 && !window.history.state?.phone) {
      window.history.replaceState(null, "", address(LIST));
      window.history.pushState({ phone: 1 }, "", address({ level: 1, id: opened.id as string }));
      if (opened.level === 2) window.history.pushState({ phone: 2 }, "", address(opened));
    }
    arrive(opened, false);
    const popped = (event: PopStateEvent) => {
      if (backs.current > 0) {
        backs.current--;
        return;
      }
      const byBrowser =
        !!(event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition ||
        (browserTab() && performance.now() - edgeAt.current < EDGE_BACK_MS);
      arrive(parsePhoneRoute(window.location.hash), byBrowser);
    };
    const hashed = () => arrive(parsePhoneRoute(window.location.hash), false);
    const touched = (event: TouchEvent) => {
      if ((event.touches[0]?.clientX ?? EDGE_PX) < EDGE_PX) edgeAt.current = performance.now();
    };
    window.addEventListener("popstate", popped);
    window.addEventListener("hashchange", hashed);
    window.addEventListener("touchstart", touched, { passive: true });
    return () => {
      window.removeEventListener("popstate", popped);
      window.removeEventListener("hashchange", hashed);
      window.removeEventListener("touchstart", touched);
    };
  }, [on, arrive]);

  const push = useCallback(
    (next: PhoneRoute) => {
      if (sameRoute(next, now.current)) return;
      window.history.pushState({ phone: next.level }, "", address(next));
      arrive(next, false);
    },
    [arrive],
  );
  const replace = useCallback(
    (next: PhoneRoute) => {
      if (sameRoute(next, now.current)) return;
      window.history.replaceState(next.level ? { phone: next.level } : null, "", address(next));
      arrive(next, false);
    },
    [arrive],
  );
  const back = useCallback(() => {
    const was = now.current;
    if (was.level === 0) return;
    const up: PhoneRoute = was.level === 2 ? { level: 1, id: was.id } : LIST;
    // An entry of the stack's own has one under it; one a link replaced may not, and Back never
    // leaves the app from here.
    if (window.history.state?.phone) {
      backs.current++;
      window.history.back();
      arrive(up, false);
    } else replace(up);
  }, [arrive, replace]);
  const asked = useRef<string | null>(null);
  const show = useCallback(
    (id: string) => {
      asked.current = id;
      const level1: PhoneRoute = { level: 1, id };
      if (now.current.level === 0) push(level1);
      else replace(level1);
    },
    [push, replace],
  );
  const enter = useCallback(
    (id: string) => {
      const opened: PhoneRoute = { level: 1, id };
      window.history.replaceState(null, "", address(LIST));
      window.history.pushState({ phone: 1 }, "", address(opened));
      asked.current = id;
      arrive(opened, false);
    },
    [arrive],
  );
  const leave = useCallback(() => {
    window.history.replaceState(null, "", address(LIST));
    arrive(LIST, false);
  }, [arrive]);
  return useMemo(
    () => ({ route, drawnByBrowser, push, replace, back, show, enter, leave, asked }),
    [route, push, replace, back, show, enter, leave],
  );
}

export interface PhoneAddressInput {
  on: boolean;
  nav: PhoneNav;
  // The daemon has said which conversation is current, and its tasks, the latest last.
  known: boolean;
  sessions: readonly string[];
  current: string | null;
  // Which conversation is current is on its way to changing, or a history is being read instead.
  settling: boolean;
  takeUp(id: string): void;
  startNew(): void;
}

// The address names the conversation on show. Taking it up is the daemon's, so a link, Back or
// Forward takes it up once which is current is known, and each conversation goes by its latest task,
// so the address follows as a new task starts.
export function usePhoneAddress({
  on,
  nav,
  known,
  sessions,
  current,
  settling,
  takeUp,
  startNew,
}: PhoneAddressInput): void {
  const { route, asked, replace } = nav;
  const { level, id } = route;
  const later = useRef({ takeUp, startNew });
  later.current = { takeUp, startNew };
  useEffect(() => {
    if (!on) return;
    if (level === 0 || !id) {
      asked.current = null;
      return;
    }
    if (!known || settling) return;
    if (id === "current") {
      asked.current = current ?? "new";
      replace({ level, id: current ?? "new" });
    } else if (id === "new") {
      if (!current) return;
      if (asked.current === "new") replace({ level, id: current });
      else {
        asked.current = "new";
        later.current.startNew();
      }
    } else if (sessions.includes(id)) {
      asked.current = current;
      if (current && current !== id) replace({ level, id: current });
    } else if (asked.current !== id) {
      asked.current = id;
      later.current.takeUp(id);
    }
  }, [on, level, id, known, sessions, current, settling, asked, replace]);
}
