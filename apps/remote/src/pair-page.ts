// Secrets stay in the fragment, are removed immediately, and are never sent in a URL/log.
export function pairPage(): Response {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to localDot</title>
<style nonce="${nonce}">:root{color-scheme:dark;font:16px system-ui;background:#0b0c0d;color:#f5f5f7}body{margin:0;min-height:100svh;display:grid;place-items:center}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.5rem}p{line-height:1.6;color:#aaa}</style>
<main><h1>Connect to localDot</h1><p id="status">Open Settings → Your computer → Remote access on your computer to create a sign-in link.</p></main>
<script nonce="${nonce}">
(async()=>{const p=new URLSearchParams(location.hash.slice(1));const key=p.get('remote');const code=p.get('code');history.replaceState(null,'','/_remote/pair');if(!key||!code)return;const status=document.getElementById('status');status.textContent='Connecting to your computer…';try{const r=await fetch('/_remote/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});if(!r.ok)throw Error();location.replace('/#code='+encodeURIComponent(code));}catch{status.textContent='This link could not connect. Make sure localDot is open, then create a fresh link from Settings.'}})();
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
