// Every URL browserd reports (navigation results, page reads, hit-test targets, downloads) passes
// through redactUrl: sign-in flows put bearer material in URLs (OAuth codes and tokens, magic
// links, signed URLs), and the agent's prompt and the event log must not carry it (P8-R15).
const SECRET_PARAM =
  /^(access_?token|id_?token|refresh_?token|token|code|auth|authorization|session(_?id)?|sid|ssid|key|api_?key|secret|client_secret|password|passwd|pwd|otp|signature|sig|jwt|assertion|saml_?(response|request)|ticket|nonce|x-amz-(signature|credential|security-token)|x-goog-(signature|credential))$/i;
const JWT = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const OPAQUE = /^[A-Za-z0-9_~%.+/=-]{40,}$/;
export const REDACTED_PART = "…";

function secretValue(value: string): boolean {
  return JWT.test(value) || OPAQUE.test(value);
}

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
  const path = url.pathname
    .split("/")
    .map((seg) => (secretValue(seg) ? REDACTED_PART : seg))
    .join("/");
  const params: string[] = [];
  for (const [name, value] of url.searchParams) {
    const hidden = SECRET_PARAM.test(name) || secretValue(value);
    params.push(
      `${encodeURIComponent(name)}=${hidden ? REDACTED_PART : encodeURIComponent(value)}`,
    );
  }
  return `${url.origin}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

// The host alone, for events and the quarantine's "from" line.
export function urlHost(raw: string): string {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : "";
  } catch {
    return "";
  }
}
