import { useEffect, useMemo, useState } from "react";
import { hudFor } from "./cells/hud-state.ts";
import { useCell } from "./cells/useCell.ts";
import { type ApiClient, createApi } from "./lib/api.ts";
import { bootstrapToken, forgetToken } from "./lib/token.ts";
import { ConversationRail } from "./shell/ConversationRail.tsx";
import { PlanRail } from "./shell/PlanRail.tsx";
import { StageColumn } from "./shell/StageColumn.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { Stage } from "./stage/Stage.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => bootstrapToken());
  const [rejected, setRejected] = useState(false);

  // Opening the daemon's link in a tab that already shows this page changes only the fragment,
  // which the browser does not reload for.
  useEffect(() => {
    const onHashChange = () => {
      const given = bootstrapToken();
      if (!given) return;
      setRejected(false);
      setToken(given);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const api = useMemo<ApiClient | null>(
    () =>
      token
        ? createApi(token, {
            fetchImpl,
            onUnauthorized: () => {
              forgetToken();
              setRejected(true);
              setToken(null);
            },
          })
        : null,
    [token, fetchImpl],
  );

  if (!api) return <NoToken rejected={rejected} />;
  return <Theatre api={api} />;
}

function Theatre({ api }: { api: ApiClient }) {
  const { cell, busy, error, reconnects, start, stop } = useCell(api);
  const hud = hudFor(cell, busy);
  useEffect(() => {
    document.title = `localDot — ${hud.label}`;
    return () => {
      document.title = "localDot";
    };
  }, [hud.label]);
  return (
    <div className="app">
      <TopBar title="Your computer" live={hud.live} />
      <div className="house">
        <ConversationRail />
        <StageColumn hud={error ? { ...hud, caption: error } : hud} onStart={start} onStop={stop}>
          <Stage cell={cell} api={api} reconnects={reconnects} />
        </StageColumn>
        <PlanRail />
      </div>
    </div>
  );
}

function NoToken({ rejected }: { rejected: boolean }) {
  return (
    <section className="notice" role="alert">
      <h1>No access token</h1>
      <p>
        {rejected ? "The daemon rejected the stored token." : "This page needs the install token."}{" "}
        Open the link the daemon printed at startup: <code>http://127.0.0.1:4750/#token=…</code>
      </p>
    </section>
  );
}
