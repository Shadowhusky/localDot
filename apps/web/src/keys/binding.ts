import {
  CLAUDE_PLAN_REFUSAL,
  claudePlanToken,
  type HTTP_FORMATS,
  type LLM_PROVIDERS,
  PRINTABLE_ASCII,
  RESERVED_SECRET_IDS,
  SECRET_ID_PATTERN,
  type SecretBinding,
} from "@localdot/protocol";

export type Provider = (typeof LLM_PROVIDERS)[number];
export type HttpFormat = (typeof HTTP_FORMATS)[number];

export interface KeyDraft {
  kind: "llm" | "http";
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
};

export const FORMAT_NAMES: Record<HttpFormat, string> = {
  bearer: "Bearer token",
  raw: "The key as is",
  "basic-user": "Basic auth, key as user",
  "basic-password": "Basic auth, key as password",
};

// The two providers with no fixed address: the key goes to the base URL the user names.
export const needsBaseURL = (p: Provider) => p === "openai-compatible" || p === "azure";

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
  if (d.kind === "llm") {
    if (!needsBaseURL(d.provider))
      return { ok: true, binding: { id, kind: "llm", provider: d.provider } };
    const baseURL = httpsBase(d.baseURL);
    if (!baseURL)
      return fail(
        "baseURL",
        "Enter the https:// address the API lives at, with no port, user, query or #.",
      );
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

export const valueHint = (d: KeyDraft) =>
  d.kind === "llm" && d.provider === "anthropic" ? "sk-ant-api" : undefined;

// keyd stores 8 to 8,192 printable ASCII characters with no space at either end; a paste's stray
// spaces are trimmed first.
export function valueProblem(value: string): string | undefined {
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
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) {
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
  kind: "llm" | "http";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
  header?: string;
}): string {
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
