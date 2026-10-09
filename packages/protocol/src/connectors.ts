import { z } from "zod";
import { SecretId } from "./keyd.ts";
import type { ActionClass } from "./safety.ts";

// Connectors: the user's apps and services as tools (MCP). A connector is a remote server reached
// through keyd, or a program that runs walled off in its own connector cell; dot sees each tool as
// `<connector>__<tool>`, a name no localDot tool has.

export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9]{1,15}$/;
export const ConnectorId = z.string().regex(CONNECTOR_ID_PATTERN);
export const MAX_CONNECTORS = 16;
// The tools of one connector dot is shown, and of all of them in one task.
export const MAX_CONNECTOR_TOOLS = 64;
export const MAX_TASK_CONNECTOR_TOOLS = 96;
// At most 48 characters, so that a harness's own prefix (mcp__localdot__) stays within 64.
const TOOL_PART = 30;
export const CONNECTOR_TOOL_NAME_PATTERN = /^[a-z][a-z0-9]{1,15}__[A-Za-z0-9_-]{1,30}$/;
// Keys made for a connector: keyd swaps them in for the connector only, never for the computer.
export const CONNECTOR_SECRET_PREFIX = "connector-";

export function isConnectorToolName(name: string): boolean {
  return CONNECTOR_TOOL_NAME_PATTERN.test(name);
}

export function isConnectorSecret(id: string): boolean {
  return id.startsWith(CONNECTOR_SECRET_PREFIX);
}

export function connectorSecretId(connectorId: string): string {
  return `${CONNECTOR_SECRET_PREFIX}${connectorId}`;
}

// The name dot calls an app's tool by: its own name in the characters every model accepts, cut to
// fit, and numbered when two would read the same.
export function connectorToolName(
  connectorId: string,
  tool: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const base =
    tool
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^[_-]+|[_-]+$/g, "")
      .slice(0, TOOL_PART) || "tool";
  let name = `${connectorId}__${base}`;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${n}`;
    name = `${connectorId}__${base.slice(0, TOOL_PART - suffix.length)}${suffix}`;
  }
  return name;
}

const LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "home.arpa",
  "ldot",
];
const PUBLIC_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z][a-z0-9-]{0,61}[a-z0-9]|xn--[a-z0-9-]{1,59})$/;

// Why a remote connector's address can't be used, or nothing. keyd reaches public https sites on
// the web's port only, so the address is a public name over https.
export function connectorUrlProblem(raw: string): string | undefined {
  if (!URL.canParse(raw)) return "Enter the connector's full address, starting with https://.";
  const url = new URL(raw);
  if (url.protocol !== "https:") return "Use an https:// address.";
  if (url.username || url.password) return "Leave sign-in details out of the address.";
  if (url.port && url.port !== "443") return "Use an address on the standard https port.";
  if (url.hash) return "Leave the # part out of the address.";
  const host = url.hostname.toLowerCase();
  if (!PUBLIC_NAME.test(host)) return "Use a public web address, not a local one or a number.";
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))
    return "Use a public web address, not a local one.";
  return undefined;
}

export const ConnectorUrl = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    const problem = connectorUrlProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export function connectorHost(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => text.isWellFormed() && !/\p{Cc}/u.test(text) && text.trim() === text);

export const ConnectorAuth = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  // A key saved in keyd, bound to the server's host: keyd puts it in at the edge.
  z.strictObject({ kind: z.literal("key"), secret: SecretId }),
  // Sign-in with the app (OAuth): the access token keyd keeps once the user signed in.
  z.strictObject({ kind: z.literal("oauth"), secret: SecretId.optional() }),
]);
export type ConnectorAuth = z.infer<typeof ConnectorAuth>;

export const RemoteServer = z.strictObject({
  kind: z.literal("remote"),
  url: ConnectorUrl,
  transport: z.enum(["http", "sse"]),
  auth: ConnectorAuth,
});
export type RemoteServer = z.infer<typeof RemoteServer>;

// Variables a connector cell sets itself: its proxy, certificates and paths.
const RESERVED_ENV =
  /^(?:HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|PATH|HOME|USER|SHELL|TMPDIR|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|PYTHONHOME|LOCALDOT_\w*|UV_\w*|NPM_CONFIG_\w*|PIP_\w*|XDG_\w*)$/i;
export const ConnectorEnv = z
  .strictObject({
    name: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .refine((name) => !RESERVED_ENV.test(name), "this variable is set by localDot"),
    // A plain setting, or a key whose stand-in the program gets in its place.
    value: z
      .string()
      .max(1024)
      .regex(/^[^\0\r\n]*$/)
      .optional(),
    secret: SecretId.optional(),
  })
  .refine((env) => (env.value === undefined) !== (env.secret === undefined), "a value or a key");
export type ConnectorEnv = z.infer<typeof ConnectorEnv>;

export const LocalServer = z.strictObject({
  kind: z.literal("local"),
  command: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/),
  args: z
    .array(
      z
        .string()
        .max(512)
        .regex(/^[^\0]*$/),
    )
    .max(32),
  env: z
    .array(ConnectorEnv)
    .max(16)
    .refine((env) => new Set(env.map((e) => e.name)).size === env.length, "a variable is repeated"),
});
export type LocalServer = z.infer<typeof LocalServer>;

export const ConnectorServer = z.discriminatedUnion("kind", [RemoteServer, LocalServer]);
export type ConnectorServer = z.infer<typeof ConnectorServer>;

export const ToolAccess = z.enum(["read", "write"]);
export type ToolAccess = z.infer<typeof ToolAccess>;
export const ConnectorToolChoice = z.strictObject({
  enabled: z.boolean().optional(),
  // The user's word on what the tool does, over the app's and the name's.
  access: ToolAccess.optional(),
});
export type ConnectorToolChoice = z.infer<typeof ConnectorToolChoice>;
const ToolKey = z.string().min(1).max(128);
const MAX_TOOL_CHOICES = 256;

export const ConnectorConfig = z.strictObject({
  id: ConnectorId,
  name: label(40),
  catalog: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  enabled: z.boolean(),
  server: ConnectorServer,
  tools: z
    .record(ToolKey, ConnectorToolChoice)
    .refine((tools) => Object.keys(tools).length <= MAX_TOOL_CHOICES),
  // A signed-in app's registration of localDot (OAuth dynamic registration): public, no secret.
  client: z
    .strictObject({ clientId: z.string().min(1).max(512), redirectUri: z.string().max(2048) })
    .optional(),
  createdAt: z.number().int().nonnegative(),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

export const ConnectorDraft = z.strictObject({
  name: label(40),
  catalog: ConnectorConfig.shape.catalog,
  server: ConnectorServer,
});
export type ConnectorDraft = z.infer<typeof ConnectorDraft>;

export const ConnectorPatch = z.strictObject({
  name: label(40).optional(),
  enabled: z.boolean().optional(),
  server: ConnectorServer.optional(),
  // null returns a tool to its defaults.
  tools: z
    .record(ToolKey, ConnectorToolChoice.nullable())
    .refine((tools) => Object.keys(tools).length <= MAX_TOOL_CHOICES)
    .optional(),
});
export type ConnectorPatch = z.infer<typeof ConnectorPatch>;

export const ConnectorStatus = z.enum([
  "off",
  "connecting",
  "ready",
  "needs_key",
  "needs_sign_in",
  "failed",
]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const AccessSource = z.enum(["app", "name", "you"]);
export type AccessSource = z.infer<typeof AccessSource>;

export const ConnectorToolView = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  access: ToolAccess,
  accessFrom: AccessSource,
  enabled: z.boolean(),
});
export type ConnectorToolView = z.infer<typeof ConnectorToolView>;

export const ConnectorView = z.object({
  id: z.string(),
  name: z.string(),
  catalog: z.string().optional(),
  enabled: z.boolean(),
  server: ConnectorServer,
  status: ConnectorStatus,
  problem: z.string().max(300).optional(),
  tools: z.array(ConnectorToolView),
  createdAt: z.number(),
});
export type ConnectorView = z.infer<typeof ConnectorView>;

// What a harness is told about one connector tool for a task.
export const ConnectorToolSpec = z.object({
  name: z.string().regex(CONNECTOR_TOOL_NAME_PATTERN),
  // The app's name, as the user gave it.
  app: z.string().min(1).max(40),
  description: z.string().max(600),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ConnectorToolSpec = z.infer<typeof ConnectorToolSpec>;

// What the user is told an app's tool may do, and what it asks as.
export interface ToolAnnotationsLike {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}
export interface ToolAccessView {
  readonly access: ToolAccess;
  readonly from: AccessSource;
  readonly actionClass: ActionClass;
}

const READ_VERBS = new Set(
  "get list search find read fetch query view show describe lookup look count retrieve check status whoami me resolve preview summarize summarise explain browse download export inspect validate diff compare ask answer current recent stats info load watch".split(
    " ",
  ),
);
const WRITE_CLASSES: readonly [ActionClass, RegExp][] = [
  [
    "purchase",
    /^(?:buy|pay|payment|purchase|order|checkout|subscribe|donate|charge|refund|payout|transfer|tip|invoice)s?$/,
  ],
  [
    "delete",
    /^(?:delete|remove|destroy|trash|erase|purge|drop|archive|revoke|unpublish|wipe|clear)s?$/,
  ],
  [
    "system_settings",
    /^(?:account|settings?|permissions?|password|roles?|members?|admin|billing|tokens?|secrets?|sso|security|2fa|webhooks?|collaborators?)$/,
  ],
  ["send", /^(?:send|reply|forward|email|mail|message|dm|invite|notify|sms|text|call|ping)s?$/],
  [
    "post",
    /^(?:post|publish|comment|tweet|share|create|add|update|edit|set|write|put|patch|insert|upload|move|rename|assign|label|merge|close|reopen|star|follow|like|react|approve|reject|submit|save|apply|run|execute|trigger|deploy|start|stop|restart|enable|disable|install|schedule|book|rsvp|accept|decline|mark|complete|import|sync|link|unlink|lock|unlock|pin|unpin|mute|block|transition|convert|duplicate|copy|change|modify|replace|upsert|append|new)s?$/,
  ],
];
// A tool's first sentence that says it changes something, whatever the app claims.
const CHANGES =
  /^(?:this tool\s+)?(?:will\s+)?(buys?|pays?|purchases?|orders?|charges?|deletes?|removes?|destroys?|archives?|sends?|replies|forwards?|emails?|invites?|posts?|publishes|comments?|creates?|adds?|updates?|edits?|sets?|writes?|uploads?|moves?|merges?|closes?|modif(?:y|ies)|changes?|replaces?)\b/i;

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function writeClass(tokens: readonly string[]): ActionClass | undefined {
  // An account word asks as an account change only with a verb that changes it.
  const changes = tokens.some(
    (token) => !READ_VERBS.has(token) && WRITE_CLASSES.some(([, pattern]) => pattern.test(token)),
  );
  for (const [actionClass, pattern] of WRITE_CLASSES) {
    if (actionClass === "system_settings" && !changes) continue;
    if (tokens.some((token) => pattern.test(token))) return actionClass;
  }
  return undefined;
}

// After a reading verb, only these change something: in get_workflow_run or list_labels the other
// words are things, not actions.
const CHANGES_AFTER_READ =
  /^(?:create|update|delete|remove|send|publish|write|edit|add|pay|buy|purchase|merge|upload|replace|modify|destroy|trash|erase|purge|insert|upsert)s?$/;

function nameClass(tokens: readonly string[]): ActionClass | undefined {
  if (!READ_VERBS.has(tokens[0] ?? "")) return writeClass(tokens);
  const later = tokens.slice(1);
  return later.some((token) => CHANGES_AFTER_READ.test(token)) ? writeClass(later) : undefined;
}

// Read or change, from the user's choice first, then the app's annotations, then the tool's name.
// The description can only make a tool ask more, since a server writes it.
export function toolAccess(
  tool: { name: string; description?: string; annotations?: ToolAnnotationsLike },
  choice?: ToolAccess,
): ToolAccessView {
  const tokens = words(tool.name);
  const firstSentence = (tool.description ?? "").trim().split(/[.!?\n]/, 1)[0] ?? "";
  const described = CHANGES.exec(firstSentence)?.[1];
  const describedClass = described ? writeClass(words(described)) : undefined;
  const named = nameClass(tokens);
  const changeClass: ActionClass = named ?? describedClass ?? "unknown";
  if (choice === "read") return { access: "read", from: "you", actionClass: "reading" };
  if (choice === "write") return { access: "write", from: "you", actionClass: changeClass };
  const hints = tool.annotations;
  if (hints?.destructiveHint === true)
    return { access: "write", from: "app", actionClass: named ?? describedClass ?? "delete" };
  if (hints?.readOnlyHint === true && !describedClass)
    return { access: "read", from: "app", actionClass: "reading" };
  if (hints?.readOnlyHint === false)
    return { access: "write", from: "app", actionClass: changeClass };
  const reads = !named && !describedClass && tokens.some((token) => READ_VERBS.has(token));
  return reads
    ? { access: "read", from: "name", actionClass: "reading" }
    : { access: "write", from: "name", actionClass: changeClass };
}

const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/gu;
const HIDDEN_BLOCK =
  /<\s*(important|system|instructions?|secret|hidden|admin|note|context|prompt)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const TAG = /<\/?[A-Za-z][^>]{0,200}>/g;
// Sentences that talk to the model instead of describing the tool.
const STEERING = [
  /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:instructions?|rules|prompts?|guidelines|messages?)\b/i,
  /\b(?:system prompt|developer (?:message|prompt)|assistant must|as an ai)\b/i,
  /\byou (?:must|should|need to|have to) (?:always|first|also|never|immediately)\b/i,
  /\b(?:do not|don'?t|never) (?:tell|inform|mention|show|reveal|alert)\b.{0,40}\buser\b/i,
  /\b(?:before|after|instead of) (?:using|calling|running) (?:any|this|other|every)\b.{0,40}\btools?\b/i,
  /\b(?:read|send|upload|include|pass|attach|copy)\b.{0,60}(?:~\/|\.ssh|id_rsa|\.env\b|passwords?|api[ -]?keys?|credentials|private keys?|secrets?)/i,
  /\b(?:call|use|invoke)\b.{0,30}\b(?:tool|function)\b.{0,30}\b(?:first|always|every time)\b/i,
];

// A server's words about a tool, as dot may read them: visible characters on one line, no markup,
// no sentences that address the model, cut to `max`. Tool descriptions are untrusted.
export function sanitizeToolText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const text = raw
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(HIDDEN_BLOCK, " ")
    .replace(TAG, " ")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && !STEERING.some((pattern) => pattern.test(sentence)))
    .join(" ");
  const chars = [...kept];
  return chars.length <= max ? kept : `${chars.slice(0, max - 1).join("")}…`;
}

const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "format",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "nullable",
]);
const PROPERTY_NAME = /^[A-Za-z0-9_.$-]{1,64}$/;
const SCHEMA_DEPTH = 6;
const SCHEMA_PROPERTIES = 64;
export const SCHEMA_BYTES = 16 * 1024;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function cleanSchema(value: unknown, depth: number, budget: { properties: number }): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > SCHEMA_DEPTH)
    return {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    switch (key) {
      case "description":
      case "title": {
        const text = sanitizeToolText(child, key === "title" ? 60 : 160);
        if (text) out[key] = text;
        break;
      }
      case "type":
        if (typeof child === "string" && TYPES.has(child)) out.type = child;
        else if (Array.isArray(child) && child.every((t) => typeof t === "string" && TYPES.has(t)))
          out.type = child.slice(0, 7);
        break;
      case "properties": {
        if (!child || typeof child !== "object" || Array.isArray(child)) break;
        const props: Record<string, unknown> = {};
        for (const [name, schema] of Object.entries(child as Record<string, unknown>)) {
          if (!PROPERTY_NAME.test(name) || budget.properties <= 0) continue;
          budget.properties--;
          props[name] = cleanSchema(schema, depth + 1, budget);
        }
        out.properties = props;
        break;
      }
      case "required":
        if (Array.isArray(child))
          out.required = child
            .filter((name) => typeof name === "string")
            .slice(0, SCHEMA_PROPERTIES);
        break;
      case "items":
      case "additionalProperties":
        out[key] = typeof child === "boolean" ? child : cleanSchema(child, depth + 1, budget);
        break;
      case "anyOf":
      case "oneOf":
        if (Array.isArray(child))
          out[key] = child.slice(0, 8).map((option) => cleanSchema(option, depth + 1, budget));
        break;
      case "enum":
        if (Array.isArray(child))
          out.enum = child
            .filter(
              (item) =>
                item === null ||
                typeof item === "number" ||
                typeof item === "boolean" ||
                (typeof item === "string" && item.length <= 100),
            )
            .slice(0, 50)
            .map((item) => (typeof item === "string" ? sanitizeToolText(item, 100) : item));
        break;
      case "pattern":
      case "format":
        if (typeof child === "string" && child.length <= 200) out[key] = child;
        break;
      case "const":
      case "default":
        if (child === null || ["string", "number", "boolean"].includes(typeof child))
          out[key] = typeof child === "string" ? sanitizeToolText(child, 100) : child;
        break;
      default:
        if (typeof child === "number" || typeof child === "boolean") out[key] = child;
    }
  }
  const properties = out.properties as Record<string, unknown> | undefined;
  if (Array.isArray(out.required))
    out.required = (out.required as string[]).filter((name) => properties && name in properties);
  return out;
}

// A tool's input schema as dot is shown it and as its arguments are checked: known keywords only,
// its words sanitized, bounded in depth, properties and size. Always an object at the top.
export function sanitizeToolSchema(raw: unknown): Record<string, unknown> {
  const cleaned = cleanSchema(raw, 0, { properties: SCHEMA_PROPERTIES }) as Record<string, unknown>;
  const schema = { ...cleaned, type: "object", properties: cleaned.properties ?? {} };
  if (JSON.stringify(schema).length > SCHEMA_BYTES)
    return { type: "object", properties: {}, additionalProperties: true };
  return schema;
}

// What dot reads about a tool: which app it is from, then the app's own words.
export function connectorToolDescription(
  appName: string,
  tool: { name: string; title?: string; description?: string },
): string {
  const said = sanitizeToolText(tool.description, 480) || sanitizeToolText(tool.title, 80);
  return `${sanitizeToolText(appName, 40)} (the user's connected app): ${said || tool.name}`;
}

export interface CatalogKey {
  // Where the key comes from and what it is called there.
  readonly label: string;
  readonly help: string;
  readonly helpUrl: string;
  // Where keyd puts it in, and how.
  readonly hosts: readonly string[];
  readonly header: string;
  readonly format: "bearer" | "raw";
}
export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly server:
    | {
        readonly kind: "remote";
        readonly url: string;
        readonly transport: "http" | "sse";
        readonly auth: "none" | "key" | "oauth" | "oauth-or-key";
      }
    | {
        readonly kind: "local";
        readonly command: string;
        readonly args: readonly string[];
        // The variable the program reads its key from.
        readonly keyEnv: string;
      };
  readonly key?: CatalogKey;
}

// A short list of common apps whose makers publish an MCP server. Anything else can be added by its
// address or command.
export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Your repositories, issues and pull requests.",
    server: {
      kind: "remote",
      url: "https://api.githubcopilot.com/mcp/",
      transport: "http",
      auth: "key",
    },
    key: {
      label: "Personal access token",
      help: "Make a fine-grained token in GitHub's developer settings, with access to the repositories dot may use.",
      helpUrl: "https://github.com/settings/personal-access-tokens/new",
      hosts: ["api.githubcopilot.com"],
      header: "authorization",
      format: "bearer",
    },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Your issues, projects and cycles.",
    server: {
      kind: "remote",
      url: "https://mcp.linear.app/mcp",
      transport: "http",
      auth: "oauth-or-key",
    },
    key: {
      label: "Personal API key",
      help: "Make one in Linear under Settings, Security and access.",
      helpUrl: "https://linear.app/settings/account/security",
      hosts: ["mcp.linear.app"],
      header: "authorization",
      format: "bearer",
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and edit your pages and databases.",
    server: { kind: "remote", url: "https://mcp.notion.com/mcp", transport: "http", auth: "oauth" },
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Errors and performance problems in your projects.",
    server: { kind: "remote", url: "https://mcp.sentry.dev/mcp", transport: "http", auth: "oauth" },
  },
  {
    id: "brave",
    name: "Brave Search",
    description: "Web, news and image search with your own search key.",
    server: {
      kind: "local",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      keyEnv: "BRAVE_API_KEY",
    },
    key: {
      label: "Search API key",
      help: "Get a key from the Brave Search API dashboard.",
      helpUrl: "https://api-dashboard.search.brave.com/app/keys",
      hosts: ["api.search.brave.com"],
      header: "x-subscription-token",
      format: "raw",
    },
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Answers about public code repositories. No account needed.",
    server: {
      kind: "remote",
      url: "https://mcp.deepwiki.com/mcp",
      transport: "http",
      auth: "none",
    },
  },
];

export function catalogEntry(id: string | undefined): CatalogEntry | undefined {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id);
}
