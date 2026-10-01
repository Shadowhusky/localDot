import { createServer } from "node:http";
import { Readable } from "node:stream";

export const SURROGATE = "ld_spike_llm_4b1e8f2a9c7d3e60";
const ROUTES = {
  anthropic: { base: "https://api.anthropic.com", header: "x-api-key", env: "ANTHROPIC_API_KEY", format: (k) => k },
  openai: { base: "https://api.openai.com", header: "authorization", env: "OPENAI_API_KEY", format: (k) => `Bearer ${k}` },
  google: { base: "https://generativelanguage.googleapis.com", header: "x-goog-api-key", env: "GEMINI_API_KEY", format: (k) => k },
  lmstudio: { base: "http://127.0.0.1:1234", header: "authorization", env: null, format: () => "Bearer lm-studio" },
};

export function startGateway(port = 4797) {
  return createServer(async (req, res) => {
    const [, name, ...rest] = (req.url ?? "/").split("/");
    const route = ROUTES[name];
    const given = req.headers[route?.header ?? ""] ?? "";
    if (!route || !String(given).includes(SURROGATE)) {
      res.writeHead(403).end("blocked: unknown route or surrogate");
      return;
    }
    const key = route.env ? process.env[route.env] : "";
    if (route.env && !key) {
      res.writeHead(503).end(`missing ${route.env}`);
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    headers[route.header] = route.format(key);
    const body = req.method === "GET" ? undefined : Readable.toWeb(req);
    const upstream = await fetch(`${route.base}/${rest.join("/")}`, { method: req.method, headers, body, duplex: "half" });
    // fetch already decoded the body, so the upstream encoding and length no longer apply.
    const passHeaders = Object.fromEntries(
      [...upstream.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k)),
    );
    res.writeHead(upstream.status, passHeaders);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  }).listen(port, "127.0.0.1");
}
