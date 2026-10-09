import {
  type CatalogEntry,
  type ConnectorDraft,
  type ConnectorToolChoice,
  type ConnectorToolView,
  type ConnectorView,
  connectorHost,
  connectorIdFor,
  connectorSecretId,
  connectorUrlProblem,
} from "@localdot/protocol";
import type { ConnectorKey } from "./useConnectors.ts";

// What a tool does when dot calls it, as the user picks it per tool.
export type ToolMode = "runs" | "asks" | "off";

export const TOOL_MODES: readonly { value: ToolMode; label: string }[] = [
  { value: "runs", label: "Just runs" },
  { value: "asks", label: "Asks first" },
  { value: "off", label: "Off" },
];

export function toolMode(tool: Pick<ConnectorToolView, "enabled" | "access">): ToolMode {
  if (!tool.enabled) return "off";
  return tool.access === "read" ? "runs" : "asks";
}

export function toolChoice(mode: ToolMode): ConnectorToolChoice {
  if (mode === "off") return { enabled: false };
  return { access: mode === "runs" ? "read" : "write" };
}

// A tool's name for people: words, not snake case.
export function toolLabel(tool: Pick<ConnectorToolView, "name" | "title">): string {
  if (tool.title) return tool.title;
  const words = tool.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : tool.name;
}

export function statusLine(view: ConnectorView): string {
  switch (view.status) {
    case "off":
      return "Off";
    case "connecting":
      return "Connecting";
    case "needs_key":
      return "No key yet";
    case "needs_sign_in":
      return "Not signed in yet";
    case "failed":
      return "Not connected";
    case "ready": {
      const on = view.tools.filter((t) => t.enabled);
      if (!view.tools.length) return "No tools";
      const asks = on.filter((t) => t.access === "write").length;
      const count = `${on.length} ${on.length === 1 ? "tool" : "tools"}`;
      return asks ? `${count} · ${asks} ask first` : count;
    }
  }
}

export function initialOf(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

// Splits a command line into the program and its words, honouring quotes; a problem otherwise.
export function parseCommand(line: string): { command: string; args: string[] } | string {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return "A quote isn't closed.";
  if (started) words.push(word);
  const [command, ...args] = words;
  if (!command) return "Enter the command that starts the app.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/.test(command))
    return "Start with the program's name, such as npx or uvx.";
  if (args.length > 32) return "That command is too long.";
  return { command, args };
}

// What adding a listed app sends, and the key it saves first.
export function catalogDraft(
  entry: CatalogEntry,
  taken: ReadonlySet<string>,
  keyValue?: string,
): { draft: ConnectorDraft & { id: string }; key?: ConnectorKey } {
  const id = connectorIdFor(entry.id, taken);
  const secret = connectorSecretId(id);
  const key =
    entry.key && keyValue
      ? {
          hosts: entry.key.hosts,
          header: entry.key.header,
          format: entry.key.format,
          value: keyValue,
        }
      : undefined;
  const { server } = entry;
  if (server.kind === "local")
    return {
      draft: {
        id,
        name: entry.name,
        catalog: entry.id,
        server: {
          kind: "local",
          command: server.command,
          args: [...server.args],
          env: [{ name: server.keyEnv, secret }],
        },
      },
      ...(key ? { key } : {}),
    };
  const auth =
    server.auth === "none"
      ? ({ kind: "none" } as const)
      : server.auth === "oauth" || (server.auth === "oauth-or-key" && !key)
        ? ({ kind: "oauth" } as const)
        : ({ kind: "key", secret } as const);
  return {
    draft: {
      id,
      name: entry.name,
      catalog: entry.id,
      server: { kind: "remote", url: server.url, transport: server.transport, auth },
    },
    ...(key && auth.kind === "key" ? { key } : {}),
  };
}

export interface CustomForm {
  kind: "address" | "command";
  name: string;
  url: string;
  signIn: "none" | "key" | "oauth";
  command: string;
  keyEnv: string;
  keyHost: string;
  header: string;
  key: string;
}

export const EMPTY_CUSTOM: CustomForm = {
  kind: "address",
  name: "",
  url: "",
  signIn: "none",
  command: "",
  keyEnv: "",
  keyHost: "",
  header: "Authorization",
  key: "",
};

const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export type CustomProblems = Partial<Record<keyof CustomForm, string>>;

// The app the form describes and the key to save first, or what to fix, field by field.
export function customDraft(
  form: CustomForm,
  taken: ReadonlySet<string>,
): { draft: ConnectorDraft & { id: string }; key?: ConnectorKey } | { problems: CustomProblems } {
  const problems: CustomProblems = {};
  const name = form.name.trim();
  if (!name) problems.name = "Give the app a name.";
  const id = connectorIdFor(name || "app", taken);
  const secret = connectorSecretId(id);
  const value = form.key.trim();
  const header = form.header.trim() || "Authorization";
  if (!/^[A-Za-z0-9-]{1,128}$/.test(header))
    problems.header = "Use a header name, such as Authorization.";
  const format = header.toLowerCase() === "authorization" ? "bearer" : "raw";
  if (form.kind === "address") {
    const url = form.url.trim();
    const urlProblem = connectorUrlProblem(url);
    if (urlProblem) problems.url = urlProblem;
    if (form.signIn === "key" && !value) problems.key = "Paste the app's key.";
    if (Object.keys(problems).length) return { problems };
    const auth =
      form.signIn === "key"
        ? ({ kind: "key", secret } as const)
        : form.signIn === "oauth"
          ? ({ kind: "oauth" } as const)
          : ({ kind: "none" } as const);
    return {
      draft: { id, name, server: { kind: "remote", url, transport: "http", auth } },
      ...(auth.kind === "key"
        ? { key: { hosts: [connectorHost(url)], header, format, value } }
        : {}),
    };
  }
  const parsed = parseCommand(form.command);
  if (typeof parsed === "string") problems.command = parsed;
  const keyEnv = form.keyEnv.trim();
  const keyHost = form.keyHost.trim().toLowerCase();
  const withKey = Boolean(keyEnv || value || keyHost);
  if (withKey) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(keyEnv))
      problems.keyEnv = "Name the variable the app reads its key from, such as API_KEY.";
    if (!HOST.test(keyHost))
      problems.keyHost = "Name the host the key is for, such as api.example.com.";
    if (!value) problems.key = "Paste the app's key.";
  }
  if (Object.keys(problems).length || typeof parsed === "string") return { problems };
  return {
    draft: {
      id,
      name,
      server: {
        kind: "local",
        command: parsed.command,
        args: parsed.args,
        env: withKey ? [{ name: keyEnv, secret }] : [],
      },
    },
    ...(withKey ? { key: { hosts: [keyHost], header, format, value } } : {}),
  };
}
