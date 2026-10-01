import { useEffect, useMemo, useState } from "react";
import { type ApiClient, createApi } from "./lib/api.ts";
import { bootstrapToken, forgetToken } from "./lib/token.ts";

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
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setConnected(false);
    api.get("/api/whoami").then(
      () => {
        if (!cancelled) setConnected(true);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api) return <NoToken rejected={rejected} />;
  return <p className="notice">{connected ? "Connected to the daemon." : "Connecting…"}</p>;
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
