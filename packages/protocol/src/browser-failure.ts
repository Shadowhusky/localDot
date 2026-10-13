import { z } from "zod";

// Browser-owned categories only. Never forward arbitrary HTTP bodies, URLs, or page text
// as trusted error guidance. This contract also works with older desktop images' text errors.
export const BrowserFailure = z.strictObject({
  error: z.literal("browser"),
  code: z.enum([
    "certificate",
    "connection",
    "dns",
    "unsafe_port",
    "timeout",
    "no_page",
    "target",
    "network",
  ]),
});
export type BrowserFailure = z.infer<typeof BrowserFailure>;

export function browserFailureCode(reason: string): BrowserFailure["code"] {
  if (/^(?:navigation failed: )?net::ERR_CERT_[A-Z_]+$/.test(reason)) return "certificate";
  if (/^(?:navigation failed: )?net::ERR_CONNECTION_(?:REFUSED|CLOSED|RESET|FAILED)$/.test(reason))
    return "connection";
  if (reason === "navigation failed: net::ERR_NAME_NOT_RESOLVED") return "dns";
  if (reason === "navigation failed: net::ERR_UNSAFE_PORT") return "unsafe_port";
  if (
    reason === "navigation failed: net::ERR_TIMED_OUT" ||
    reason === "navigation failed: page operation timed out"
  )
    return "timeout";
  if (reason === "Chromium has no open page") return "no_page";
  if (/^navigation failed: the visible Chromium (?:page|window) /.test(reason)) return "target";
  return "network";
}

const details: Record<BrowserFailure["code"], string> = {
  certificate:
    "Chromium rejected the HTTPS certificate (not a port restriction). For a local preview, use the updated desktop browser's localhost TLS support or configure the development certificate in that disposable browser. Keep the project's HTTPS origin and callback URL; do not disable certificate checks for public sites. The app has not been verified.",
  connection:
    "The browser could not connect to the server. Check that the project's dev server or proxy is running on this exact address and port inside the desktop computer, then retry. A host-machine server is not the desktop's localhost.",
  dns: "The browser could not resolve the hostname. Check the project's preview hostname and local resolver configuration before retrying.",
  unsafe_port:
    "Chromium blocks this port as an unsafe service port. Choose a browser-safe development port in the project's configuration; ordinary preview ports such as 1355, 3000, and 5173 are supported.",
  timeout:
    "The browser operation timed out. Inspect the current visible page and server readiness before retrying; this does not establish a browser policy restriction or a completed UI test.",
  no_page: "Chromium has no open page.",
  target:
    "The visible Chromium page or window changed or could not be identified. Inspect the desktop and retry on the visible tab; do not start a hidden replacement browser.",
  network:
    "Browser navigation failed. Inspect the visible error page and the development server or proxy logs. A navigation failure alone does not mean the port is forbidden, and the app has not been verified.",
};

export function browserFailureDetail(body: string): string {
  try {
    const parsed = BrowserFailure.safeParse(JSON.parse(body));
    if (parsed.success) return details[parsed.data.code];
  } catch {
    /* Older desktop images return a short plain-text error. */
  }
  return details[browserFailureCode(body)];
}
