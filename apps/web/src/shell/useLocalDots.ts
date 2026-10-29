import type { DotSummary } from "@localdot/protocol";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  dotProblem,
  dotSignIn,
  listDots,
  startDot,
  stopDot,
  waitForJob,
} from "../settings/dots-api.ts";
import { showToast } from "../ui/Toast.tsx";

// The dots on this computer, as the switcher and Settings show them. Each action answers with what
// went wrong, or null.
export interface LocalDots {
  // As last listed; null until listed once.
  dots: readonly DotSummary[] | null;
  // Whether this installation can add, remove, start and stop dots from here.
  manage: boolean;
  // The dot an action is under way for.
  busy: string | null;
  refresh(): void;
  // Starts it first when it is stopped, then signs this browser in there and goes.
  open(dot: DotSummary): Promise<string | null>;
  start(dot: DotSummary): Promise<string | null>;
  stop(dot: DotSummary): Promise<string | null>;
}

const go = (url: string) => window.location.assign(url);

export function useLocalDots(
  api: ApiClient | null,
  navigate: (url: string) => void = go,
): LocalDots {
  const [dots, setDots] = useState<readonly DotSummary[] | null>(null);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // An answer older than the newest ask is dropped.
  const asked = useRef(0);
  const navigateTo = useRef(navigate);
  navigateTo.current = navigate;

  const refresh = useCallback(() => {
    if (!api) return;
    const ask = ++asked.current;
    void listDots(api)
      .then((reply) => {
        if (ask !== asked.current) return;
        setDots(reply.dots);
        setManage(reply.manage);
      })
      .catch(() => {});
  }, [api]);

  const act = useCallback(
    async (dot: DotSummary, run: (api: ApiClient) => Promise<string | null>, fallback: string) => {
      if (!api) return fallback;
      setBusy(dot.id);
      try {
        return await run(api);
      } catch (error) {
        return dotProblem(error, fallback);
      } finally {
        setBusy(null);
        refresh();
      }
    },
    [api, refresh],
  );

  const switchOn = useCallback(async (client: ApiClient, dot: DotSummary) => {
    const job = await waitForJob(client, await startDot(client, dot.id));
    return job.state === "done" ? null : (job.error ?? `${dot.name} didn't start.`);
  }, []);

  return useMemo(
    () => ({
      dots,
      manage,
      busy,
      refresh,
      start: (dot) => act(dot, (client) => switchOn(client, dot), `${dot.name} didn't start.`),
      async stop(dot) {
        return act(
          dot,
          async (client) => {
            const job = await waitForJob(client, await stopDot(client, dot.id));
            return job.state === "done" ? null : (job.error ?? `${dot.name} didn't stop.`);
          },
          `${dot.name} didn't stop.`,
        );
      },
      open: (dot) =>
        act(
          dot,
          async (client) => {
            if (dot.state !== "running") {
              const problem = await switchOn(client, dot);
              if (problem) return problem;
            }
            navigateTo.current((await dotSignIn(client, dot.id)).url);
            return null;
          },
          `Couldn't open ${dot.name}.`,
        ),
    }),
    [dots, manage, busy, refresh, act, switchOn],
  );
}

// Goes to another dot, starting it first when it is stopped, and says so while it starts.
export function switchToDot(dots: LocalDots, dot: DotSummary): void {
  if (dot.self) return;
  if (dot.state !== "running") showToast({ id: "dot-switch", title: `Starting ${dot.name}…` });
  void dots.open(dot).then((problem) => {
    if (problem)
      showToast({
        id: "dot-switch",
        title: `Couldn't open ${dot.name}`,
        description: problem,
        tone: "danger",
      });
  });
}
