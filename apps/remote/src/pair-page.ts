// Secrets stay in the fragment, are removed immediately, and are never sent in a URL/log.
export function pairPage(): Response {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to localDot</title>
<style nonce="${nonce}">:root{color-scheme:dark;font:16px system-ui;background:#0b0c0d;color:#f5f5f7}body{margin:0;min-height:100svh;display:grid;place-items:center}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.5rem}p{line-height:1.6;color:#aaa}</style>
<main><h1>Connect to localDot</h1><p id="status">This browser isn't connected to this localDot yet. Open a sign-in link from that computer here.</p></main>
<script nonce="${nonce}">
(async()=>{if(!location.hash)return;const p=new URLSearchParams(location.hash.slice(1));const key=p.get('remote');const code=p.get('code');history.replaceState(null,'',location.pathname+location.search);if(!key||!code)return;const status=document.getElementById('status');status.textContent='Connecting to your computer…';try{const r=await fetch('/_remote/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});if(!r.ok)throw Error();location.replace('/#code='+encodeURIComponent(code));}catch{status.textContent='This link could not connect. Make sure localDot is open, then create a fresh link from Settings.'}})();
</script></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

// A page opened from another site, such as the localDot menu on localhost or a tailnet address,
// arrives without the SameSite=Strict pairing cookie. Pair links carry their own secret, and a
// request referred by this relay's own page is never bounced, so a visit bounces at most once.
export function crossSiteEntry(request: Request, url: URL): boolean {
  const referrer = request.headers.get("referer");
  return (
    request.method === "GET" &&
    request.headers.get("sec-fetch-site") === "cross-site" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    (request.headers.get("sec-fetch-dest") ?? "document") === "document" &&
    !url.pathname.startsWith("/_remote/") &&
    !(referrer && URL.canParse(referrer) && new URL(referrer).origin === url.origin)
  );
}

// The same address again, requested by this origin's own page, carries the cookie in Chromium and
// WebKit; an HTTP redirect keeps the cross-site start and never does. The fragment isn't kept.
export function bouncePage(url: URL): Response {
  const again = url.href.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta http-equiv="refresh" content="0;url=${again}"><title>localDot</title></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // The return names this page as its referrer, which is what stops a second bounce.
        "referrer-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}
