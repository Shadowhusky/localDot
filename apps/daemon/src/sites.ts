// Country-code domains sell names one level down (example.co.uk). A short list keeps such
// sites whole without shipping the public suffix list.
const SECOND_LEVEL = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gen",
  "go",
  "gob",
  "gov",
  "ltd",
  "mil",
  "ne",
  "net",
  "nic",
  "nom",
  "or",
  "org",
  "plc",
  "sch",
]);
// Hosting where anyone can take a name one level down, so each name under it has its own owner.
const SHARED = [
  "appspot.com",
  "azurewebsites.net",
  "blogspot.com",
  "cloudfront.net",
  "codeberg.page",
  "deno.dev",
  "firebaseapp.com",
  "fly.dev",
  "github.io",
  "gitlab.io",
  "glitch.me",
  "herokuapp.com",
  "hf.space",
  "myshopify.com",
  "neocities.org",
  "netlify.app",
  "ngrok-free.app",
  "ngrok.io",
  "notion.site",
  "onrender.com",
  "pages.dev",
  "r2.dev",
  "readthedocs.io",
  "repl.co",
  "replit.app",
  "run.app",
  "streamlit.app",
  "surge.sh",
  "trycloudflare.com",
  "vercel.app",
  "web.app",
  "webflow.io",
  "wixsite.com",
  "workers.dev",
];

export function siteOf(host: string): string {
  const labels = host.split(".");
  const [second, top] = labels.slice(-2);
  const keep = top?.length === 2 && SECOND_LEVEL.has(second ?? "") && labels.length > 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

// The name a host's owner holds: its site, or the name under shared hosting. None for a suffix on
// its own (co.uk, github.io), which nobody owns.
export function ownerOf(host: string): string | undefined {
  if (!host.includes(".")) return undefined;
  const shared = SHARED.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (shared) {
    const below = host
      .slice(0, -shared.length - 1)
      .split(".")
      .at(-1);
    return below ? `${below}.${shared}` : undefined;
  }
  const site = siteOf(host);
  return siteOf(`x.${site}`) === site ? site : undefined;
}
