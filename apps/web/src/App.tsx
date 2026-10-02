import { useEffect, useMemo, useState } from "react";
import { type HudActionKind, hudFor } from "./cells/hud-state.ts";
import { useCell } from "./cells/useCell.ts";
import { type ApiClient, ApiError, createApi } from "./lib/api.ts";
import { forgetToken, keepToken, storedToken, takeFragmentToken } from "./lib/token.ts";
import { ConversationRail } from "./shell/ConversationRail.tsx";
import { PlanRail } from "./shell/PlanRail.tsx";
import { StageColumn } from "./shell/StageColumn.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { Stage } from "./stage/Stage.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "link" | null;

const RETRY_CHECK_MS = 2000;

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => storedToken());
  // A token from a link, used and stored only once the daemon accepts it, so a wrong link can't
  // log the user out.
  const [candidate, setCandidate] = useState(() => takeFragmentToken());
  const [rejected, setRejected] = useState<Rejected>(null);

  // Opening the daemon's link in a tab that already shows this page changes only the fragment,
  // which the browser does not reload for.
  useEffect(() => {
    const onHashChange = () => {
      const given = takeFragmentToken();
      if (given) setCandidate(given);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!candidate) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      createApi(candidate, { fetchImpl })
        .get("/api/whoami")
        .then(
          () => {
            if (cancelled) return;
            keepToken(candidate);
            setToken(candidate);
            setRejected(null);
            setCandidate(null);
          },
          (err: unknown) => {
            if (cancelled) return;
            if (err instanceof ApiError && err.status === 401) {
              setRejected("link");
              setCandidate(null);
              return;
            }
            // No answer: the daemon may be restarting.
            timer = setTimeout(check, RETRY_CHECK_MS);
          },
        );
    };
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [candidate, fetchImpl]);

  const api = useMemo<ApiClient | null>(
    () =>
      token
        ? createApi(token, {
            fetchImpl,
            // A 401 that arrives after a newer token took over leaves that token alone.
            onUnauthorized: () => {
              forgetToken(token);
              setRejected("stored");
              setToken((current) => (current === token ? null : current));
            },
          })
        : null,
    [token, fetchImpl],
  );

  if (api) return <Theatre key={token} api={api} />;
  if (candidate) {
    return (
      <p className="notice" role="status">
        Checking the link…
      </p>
    );
  }
  return <NoToken rejected={rejected} />;
}

function Theatre({ api }: { api: ApiClient }) {
  const { cell, status, pending, error, reconnects, start, stop, retry } = useCell(api);
  const hud = hudFor({ cell, status, pending });
  useEffect(() => {
    document.title = `localDot — ${hud.label}`;
    return () => {
      document.title = "localDot";
    };
  }, [hud.label]);
  const onAction = (kind: HudActionKind) => {
    if (kind === "start") start();
    else if (kind === "stop") stop();
    else retry();
  };
  return (
    <div className="app">
      <TopBar title="Your computer" live={hud.live} />
      <div className="house">
        <ConversationRail />
        <StageColumn hud={error ? { ...hud, caption: error } : hud} onAction={onAction}>
          <Stage cell={cell} api={api} reconnects={reconnects} />
        </StageColumn>
        <PlanRail />
      </div>
    </div>
  );
}

const REJECTED: Record<Exclude<Rejected, null>, string> = {
  stored: "The daemon rejected the stored token.",
  link: "The daemon rejected the token in the link.",
};

function NoToken({ rejected }: { rejected: Rejected }) {
  return (
    <section className="notice" role="alert">
      <h1>No access token</h1>
      <p>
        {rejected ? REJECTED[rejected] : "This page needs the install token."} Open the link the
        daemon printed at startup: <code>{window.location.origin}/#token=…</code>
      </p>
    </section>
  );
}
