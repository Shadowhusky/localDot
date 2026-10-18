import {
  CLAUDE_PLAN_REFUSAL,
  claudePlanToken,
  GeneralSecretValue,
  type HTTP_FORMATS,
  JEV_HOST,
  JEV_SECRET_ID,
  type LLM_PROVIDERS,
  PRINTABLE_ASCII,
  RESERVED_SECRET_IDS,
  SECRET_ID_PATTERN,
  SecretBinding,
} from "@localdot/protocol";

export type Provider = (typeof LLM_PROVIDERS)[number];
export type HttpFormat = (typeof HTTP_FORMATS)[number];

export interface KeyDraft {
  kind: "llm" | "http" | "secret";
  id: string;
  provider: Provider;
  baseURL: string;
  hosts: string;
  header: string;
  format: HttpFormat;
}

export const EMPTY_DRAFT: KeyDraft = {
  kind: "llm",
  id: "",
  provider: "anthropic",
  baseURL: "",
  hosts: "",
  header: "Authorization",
  format: "bearer",
};

// A Jev key, for the purpose check: a web API key sent to Jev's host as a bearer token.
export const JEV_KEY: Pick<KeyDraft, "id" | "hosts" | "header" | "format"> = {
  id: JEV_SECRET_ID,
  hosts: JEV_HOST,
  header: "Authorization",
  format: "bearer",
};

export const PROVIDER_NAMES: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  xai: "xAI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  groq: "Groq",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible",
  azure: "Azure OpenAI",
  "anthropic-compatible": "Anthropic-compatible",
};

// Providers with their own address first, then those that take an address the user names.
export const PROVIDER_GROUPS: readonly { label: string; providers: readonly Provider[] }[] = [
  {
    label: "Providers",
    providers: [
      "anthropic",
      "openai",
      "google",
      "xai",
      "mistral",
      "deepseek",
      "groq",
      "openrouter",
    ],
  },
  { label: "Your own address", providers: ["openai-compatible", "anthropic-compatible", "azure"] },
];

export const FORMAT_NAMES: Record<HttpFormat, string> = {
  bearer: "Bearer token",
  raw: "The key as is",
  "basic-user": "Basic auth, key as user",
  "basic-password": "Basic auth, key as password",
};

// The providers with no fixed address: the key goes to the base URL the user names.
export const needsBaseURL = (p: Provider) =>
  p === "openai-compatible" || p === "azure" || p === "anthropic-compatible";

// keyd refuses private hosts and ports, so a server on this Mac is reached through its own route.
export function baseURLHint(p: Provider): string | undefined {
  const local = "Local servers go through LM Studio or Ollama.";
  if (p === "openai-compatible") return `Use https. ${local}`;
  if (p === "anthropic-compatible") return `Use https, ending in /v1 (added if missing). ${local}`;
  return undefined;
}

export type DraftField = "id" | "baseURL" | "hosts" | "header" | "value";
export type DraftCheck =
  | { ok: true; binding: SecretBinding }
  | { ok: false; field: DraftField; message: string };

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

// The binding the key will be sealed for, from what the form holds. keyd checks every field again
// (and more: the deny list, forbidden headers); this catches what a person can fix while typing.
// Text keyd will see is printable ASCII: a base URL goes as `new URL(x).href`, which encodes
// anything else, so the binding the browser seals is byte for byte the one keyd rebuilds.
export function bindingOf(d: KeyDraft): DraftCheck {
  const id = d.id.trim();
  if (!SECRET_ID_PATTERN.test(id)) {
    return fail(
      "id",
      "Use lower-case letters, digits, - or _ (up to 64), starting with a letter or digit.",
    );
  }
  if (RESERVED_SECRET_IDS.includes(id))
    return fail("id", `"${id}" is built in; pick another name.`);
  if (d.kind === "secret") return { ok: true, binding: { id, kind: "secret" } };
  if (d.kind === "llm") {
    if (!needsBaseURL(d.provider))
      return { ok: true, binding: { id, kind: "llm", provider: d.provider } };
    let baseURL = httpsBase(d.baseURL);
    if (!baseURL)
      return fail(
        "baseURL",
        "Enter the API's https:// address by host name, with no port, user, query or #.",
      );
    if (d.provider === "anthropic-compatible") {
      if (/(^|\.)anthropic\.com$/.test(new URL(baseURL).hostname))
        return fail("baseURL", "For Anthropic's own API, choose Anthropic as the provider.");
      // Vendors give the address Anthropic's SDKs add /v1/messages to; the route keyd holds ends
      // in the version, as Anthropic's own does.
      baseURL = baseURL.replace(/\/+$/, "");
      if (!baseURL.endsWith("/v1")) baseURL += "/v1";
    }
    return { ok: true, binding: { id, kind: "llm", provider: d.provider, baseURL } };
  }
  const hosts = [
    ...new Set(
      d.hosts
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  if (hosts.length === 0 || hosts.length > 16)
    return fail("hosts", "Name 1 to 16 hosts, like api.example.com.");
  const bad = hosts.find((h) => !HOST.test(h));
  if (bad)
    return fail(
      "hosts",
      `"${bad}" is not a host name: use names like api.example.com, not addresses or URLs.`,
    );
  const header = d.header.trim();
  if (!HEADER.test(header))
    return fail("header", "Enter a header name, like Authorization or X-Api-Key.");
  if (d.format.startsWith("basic-") && header.toLowerCase() !== "authorization") {
    return fail("header", "Basic auth travels in the Authorization header.");
  }
  return { ok: true, binding: { id, kind: "http", hosts, header, format: d.format } };
}

// The name a key gets when none is typed: its provider's, or the service in its first host
// (api.weather.example gives weather), then -2, -3 and on past the names already saved.
export function suggestedId(d: KeyDraft, taken: readonly string[]): string {
  // Read past a scheme, port or path typed by mistake.
  const host =
    d.hosts
      .toLowerCase()
      .split(/[\s,]+/)
      .find(Boolean)
      ?.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .split(/[/:?#]/)[0]
      ?.split(".")
      .filter((label) => label && label !== "api" && label !== "www") ?? [];
  const named =
    d.kind === "secret"
      ? "general-key"
      : d.kind === "llm"
        ? d.provider
        : host.length > 1
          ? (host[0] ?? "")
          : "";
  const base =
    named
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 60) || "web-api";
  const used = new Set([...taken, ...RESERVED_SECRET_IDS]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export const valueHint = (d: KeyDraft) =>
  d.kind === "llm" && d.provider === "anthropic" ? "sk-ant-api" : undefined;

// keyd stores 8 to 8,192 printable ASCII characters with no space at either end; a paste's stray
// spaces are trimmed first.
export function valueProblem(value: string, kind: KeyDraft["kind"] = "http"): string | undefined {
  if (kind === "secret")
    return GeneralSecretValue.safeParse(value).success
      ? undefined
      : "Enter 1–8,192 UTF-8 bytes without NUL. Multiline values are supported.";
  if (claudePlanToken(value)) return CLAUDE_PLAN_REFUSAL;
  if (value.length < 8 || value.length > 8192 || !PRINTABLE_ASCII.test(value)) {
    return "A key is 8 to 8,192 characters of printable ASCII.";
  }
  if (value.startsWith(" ") || value.endsWith(" ")) {
    return "Remove spaces at the start or end of the key.";
  }
  return undefined;
}

function httpsBase(text: string): string | undefined {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !HOST.test(u.hostname)
  ) {
    return undefined;
  }
  const href = u.href;
  return href.length <= 2048 && PRINTABLE_ASCII.test(href) ? href : undefined;
}

function fail(field: DraftField, message: string): DraftCheck {
  return { ok: false, field, message };
}

// How a stored key reads in the list.
export function describeKey(k: {
  kind: "llm" | "http" | "secret";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
  header?: string;
}): string {
  if (k.kind === "secret") return "General key";
  if (k.kind === "llm") {
    const name =
      k.provider && Object.hasOwn(PROVIDER_NAMES, k.provider)
        ? PROVIDER_NAMES[k.provider as Provider]
        : (k.provider ?? "Model provider");
    try {
      return k.baseURL ? `${name} · ${new URL(k.baseURL).host}` : name;
    } catch {
      return name;
    }
  }
  return `${(k.hosts ?? []).join(", ")} · ${k.header ?? ""}`;
}

// The binding a key had, to store its value again under it: the same name, the same destination,
// so every model and task that uses the key keeps using it.
export function bindingOfRecord(k: {
  id: string;
  kind: "llm" | "http" | "secret";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
  header?: string;
  format?: string;
  methods?: string[] | null;
  paths?: string[] | null;
}): SecretBinding | undefined {
  const parsed = SecretBinding.safeParse(
    k.kind === "secret"
      ? { id: k.id, kind: "secret" }
      : k.kind === "llm"
        ? {
            id: k.id,
            kind: "llm",
            provider: k.provider,
            ...(k.baseURL ? { baseURL: k.baseURL } : {}),
          }
        : {
            id: k.id,
            kind: "http",
            hosts: k.hosts ?? [],
            header: k.header,
            format: k.format,
            ...(k.methods?.length ? { methods: k.methods } : {}),
            ...(k.paths?.length ? { paths: k.paths } : {}),
          },
  );
  return parsed.success ? parsed.data : undefined;
}

// Where a stored key is sent, in a few words.
export function destinationOf(k: {
  kind: "llm" | "http" | "secret";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
}): string {
  if (k.kind === "secret") return "general key storage";
  if (k.kind === "http") return (k.hosts ?? []).join(", ");
  try {
    if (k.baseURL) return new URL(k.baseURL).host;
  } catch {
    /* A malformed address reads as its provider. */
  }
  return k.provider && Object.hasOwn(PROVIDER_NAMES, k.provider)
    ? PROVIDER_NAMES[k.provider as Provider]
    : (k.provider ?? "its provider");
}
