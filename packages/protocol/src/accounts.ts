import { z } from "zod";

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

// A registrable domain or one of its hosts, as the web browser's cookies name them.
const SiteName = z.string().min(3).max(253).regex(HOST);

export const SignInSite = z.strictObject({
  site: SiteName,
  hosts: z.array(SiteName).min(1).max(64),
  cookies: z.number().int().positive(),
});
export type SignInSite = z.infer<typeof SignInSite>;

export const SignInSites = z.strictObject({ sites: z.array(SignInSite).max(5000) });
export type SignInSites = z.infer<typeof SignInSites>;

export const SignOutRequest = z.strictObject({ site: SiteName });
export type SignOutRequest = z.infer<typeof SignOutRequest>;

// Settings > Accounts names one site; the daemon picks the page that opens.
export const SignInRequest = z.strictObject({ site: SiteName });
export type SignInRequest = z.infer<typeof SignInRequest>;

// The site whose sign-in the desktop's own browser shows, which the web browser would keep.
export const DesktopSignIn = z.strictObject({ site: SiteName.nullable() });
export type DesktopSignIn = z.infer<typeof DesktopSignIn>;

export interface KnownSignIn {
  site: string;
  name: string;
  url: string;
  // Other hosts that serve this site's sign-in pages.
  hosts: readonly string[];
}

// Sites people sign in to most, and where each one's sign-in page is.
export const KNOWN_SIGN_INS: readonly KnownSignIn[] = [
  {
    site: "google.com",
    name: "Google",
    url: "https://accounts.google.com/",
    hosts: ["accounts.google.com"],
  },
  {
    site: "microsoft.com",
    name: "Microsoft",
    url: "https://login.live.com/",
    hosts: ["login.live.com", "login.microsoftonline.com"],
  },
  {
    site: "apple.com",
    name: "Apple",
    url: "https://account.apple.com/sign-in",
    hosts: ["account.apple.com", "appleid.apple.com", "idmsa.apple.com"],
  },
  { site: "github.com", name: "GitHub", url: "https://github.com/login", hosts: [] },
  { site: "amazon.com", name: "Amazon", url: "https://www.amazon.com/gp/sign-in.html", hosts: [] },
  { site: "x.com", name: "X", url: "https://x.com/i/flow/login", hosts: [] },
  { site: "facebook.com", name: "Facebook", url: "https://www.facebook.com/login/", hosts: [] },
  {
    site: "instagram.com",
    name: "Instagram",
    url: "https://www.instagram.com/accounts/login/",
    hosts: [],
  },
  { site: "linkedin.com", name: "LinkedIn", url: "https://www.linkedin.com/login", hosts: [] },
  { site: "reddit.com", name: "Reddit", url: "https://www.reddit.com/login/", hosts: [] },
  { site: "telegram.org", name: "Telegram", url: "https://web.telegram.org/", hosts: [] },
  { site: "whatsapp.com", name: "WhatsApp", url: "https://web.whatsapp.com/", hosts: [] },
  { site: "notion.so", name: "Notion", url: "https://www.notion.so/login", hosts: [] },
  { site: "slack.com", name: "Slack", url: "https://slack.com/signin", hosts: [] },
  { site: "discord.com", name: "Discord", url: "https://discord.com/login", hosts: [] },
  { site: "dropbox.com", name: "Dropbox", url: "https://www.dropbox.com/login", hosts: [] },
];

// Names the web browser can't open: this computer, its network and reserved names.
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".arpa",
  ".test",
  ".example",
  ".invalid",
];
const IPV4 = /^\d+(?:\.\d+){3}$/u;

// The host a person means by what they typed ("Google.com", "https://mail.google.com/inbox"),
// without "www.", or undefined when it is not a public web site.
export function signInSite(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//u.test(value) ? value : `https://${value}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.port) return undefined;
  const host = url.hostname.replace(/\.$/u, "").replace(/^www\./u, "");
  if (
    host.length > 253 ||
    !HOST.test(host) ||
    IPV4.test(host) ||
    LOCAL_SUFFIXES.some((suffix) => `.${host}`.endsWith(suffix))
  )
    return undefined;
  return host;
}

export function knownSignIn(host: string): KnownSignIn | undefined {
  return KNOWN_SIGN_INS.find(
    (known) => known.hosts.includes(host) || host === known.site || host.endsWith(`.${known.site}`),
  );
}

// The page that opens for a site: its own sign-in page when known, otherwise its home page.
export function signInUrl(host: string): string {
  return knownSignIn(host)?.url ?? `https://${host}/`;
}

const SIGN_IN_PATH =
  /\/(?:log-?in|sign-?in|sign_in|signon|auth|authorize|sso|session|accounts\/login)(?:[/?#.]|$)/iu;
const SIGN_IN_HOST = /^(?:login|signin|auth|accounts?|sso|id)\./u;

// The localDot page the desktop's own browser opens on. It says sign-ins there aren't kept, and a
// site typed into it asks the app to offer that site in the web browser.
export const DESKTOP_BROWSER_NOTICE = "file:///opt/localdot/desktop-browser.html";

// The site to offer in the web browser when the desktop's browser shows a sign-in page.
export function desktopSignIn(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol === "file:") {
    const asked = url.searchParams.get("site");
    return `file://${url.pathname}` === DESKTOP_BROWSER_NOTICE && asked
      ? signInSite(asked)
      : undefined;
  }
  const host = signInSite(url.href);
  if (!host) return undefined;
  const known = KNOWN_SIGN_INS.find((entry) => entry.hosts.includes(host));
  if (known) return known.site;
  return SIGN_IN_HOST.test(host) || SIGN_IN_PATH.test(url.pathname) ? host : undefined;
}
