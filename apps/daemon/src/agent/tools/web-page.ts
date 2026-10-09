import { isIP } from "node:net";

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

// What the web browser can open (its own navigation rule): public names on the default port.
// Everything else, such as a server dot started on the desktop, stays in the desktop's Chromium.
export function opensInWebBrowser(url: URL): boolean {
  const host = url.hostname.replace(/\.$/u, "").toLowerCase();
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.port &&
    !url.username &&
    !url.password &&
    host.includes(".") &&
    isIP(host) === 0 &&
    host !== "localhost" &&
    !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}
