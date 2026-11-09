import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

export const REFUSED = {
  error: "invalid_client",
  error_description: "The client_id is not valid for the requested domain.",
};

// A sign-in service as WorkOS AuthKit behaves for a client-side app: it sends the browser back only
// to the address registered for its client, and trades a code only with a page at that address
// (CORS). Anything else gets the answer thema-app's preview showed.
export function signInService(registered: () => string): Server {
  const codes = new Set<string>();
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://service");
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/user_management/authorize") {
      const back = url.searchParams.get("redirect_uri") ?? "";
      if (!URL.canParse(back) || new URL(back).origin !== registered()) return answer(400, REFUSED);
      const code = randomBytes(12).toString("hex");
      codes.add(code);
      res.writeHead(302, { location: `${back}?code=${code}` });
      return void res.end();
    }
    if (url.pathname === "/user_management/authenticate") {
      const cors: Record<string, string> =
        req.headers.origin === registered()
          ? {
              "access-control-allow-origin": registered(),
              "access-control-allow-headers": "content-type",
              vary: "origin",
            }
          : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return void res.end();
      }
      if (!cors["access-control-allow-origin"]) return answer(400, REFUSED);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { code } = JSON.parse(body || "{}") as { code?: string };
        if (code && codes.delete(code))
          return answer(200, { user: { email: "owner@thema.test" } }, cors);
        answer(400, { error: "invalid_grant" }, cors);
      });
      return;
    }
    answer(404, { error: "not_found" });
  });
}

// thema-app as AuthKit runs it in the browser: the address to come back to is the page's own
// (window.origin), and the callback page trades its code with the sign-in service itself.
export function signInApp(service: () => string) {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Thema (dev)</title>
<a id="sign-in" href="#">Sign in</a><p id="who"></p>
<script>
const service = ${JSON.stringify(service())};
const who = document.getElementById("who");
if (location.pathname === "/callback") {
  const code = new URLSearchParams(location.search).get("code");
  fetch(service + "/user_management/authenticate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
    .then((answer) => answer.json())
    .then(
      (body) => { who.textContent = body.user ? "Signed in as " + body.user.email : body.error; },
      () => { who.textContent = "Sign-in failed"; },
    );
} else {
  document.getElementById("sign-in").href = service +
    "/user_management/authorize?client_id=client_test&redirect_uri=" +
    encodeURIComponent(window.origin + "/callback");
}
</script>`);
  });
  return { server, seen };
}
