import { CONNECTOR_CATALOG, type ConnectorView } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  catalogDraft,
  customDraft,
  EMPTY_CUSTOM,
  parseCommand,
  statusLine,
  toolChoice,
  toolLabel,
  toolMode,
} from "./connectors-form.ts";

const entry = (id: string) => {
  const found = CONNECTOR_CATALOG.find((e) => e.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("a tool's behaviour", () => {
  it("is one choice: just runs, asks first, or off", () => {
    expect(toolMode({ enabled: true, access: "read" })).toBe("runs");
    expect(toolMode({ enabled: true, access: "write" })).toBe("asks");
    expect(toolMode({ enabled: false, access: "read" })).toBe("off");
    expect(toolChoice("runs")).toEqual({ access: "read" });
    expect(toolChoice("asks")).toEqual({ access: "write" });
    expect(toolChoice("off")).toEqual({ enabled: false });
    expect(toolLabel({ name: "add_issueComment" })).toBe("Add issue comment");
    expect(toolLabel({ name: "x", title: "Search pages" })).toBe("Search pages");
  });

  it("is summed up under the app's name", () => {
    const view = {
      status: "ready",
      tools: [
        { name: "a", access: "read", enabled: true },
        { name: "b", access: "write", enabled: true },
        { name: "c", access: "write", enabled: false },
      ],
    } as unknown as ConnectorView;
    expect(statusLine(view)).toBe("2 tools · 1 ask first");
    expect(statusLine({ ...view, status: "needs_sign_in" })).toBe("Not signed in yet");
    expect(statusLine({ ...view, tools: [] })).toBe("No tools");
  });
});

describe("parseCommand", () => {
  it("splits words and keeps quoted ones whole", () => {
    expect(parseCommand(" npx -y \"@scope/my server\" --flag='a b' ")).toEqual({
      command: "npx",
      args: ["-y", "@scope/my server", "--flag=a b"],
    });
    expect(parseCommand("")).toBe("Enter the command that starts the app.");
    expect(parseCommand('npx "open')).toBe("A quote isn't closed.");
    expect(parseCommand("rm;ls")).toBeTypeOf("string");
  });
});

describe("catalogDraft", () => {
  it("binds a listed app's key to its own host, under the app's own id", () => {
    const { draft, key } = catalogDraft(entry("github"), new Set(["github"]), "ghp_x");
    expect(draft).toMatchObject({
      id: "github2",
      server: { kind: "remote", auth: { kind: "key", secret: "connector-github2" } },
    });
    expect(key).toEqual({
      hosts: ["api.githubcopilot.com"],
      header: "authorization",
      format: "bearer",
      value: "ghp_x",
    });
  });

  it("signs in when no key is given, and gives a program its key's variable", () => {
    expect(catalogDraft(entry("linear"), new Set()).draft.server).toMatchObject({
      auth: { kind: "oauth" },
    });
    expect(catalogDraft(entry("linear"), new Set(), "lin_x").draft.server).toMatchObject({
      auth: { kind: "key", secret: "connector-linear" },
    });
    const brave = catalogDraft(entry("brave"), new Set(), "BSA");
    expect(brave.draft.server).toEqual({
      kind: "local",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      env: [{ name: "BRAVE_API_KEY", secret: "connector-brave" }],
    });
    expect(brave.key).toMatchObject({ header: "x-subscription-token", format: "raw" });
  });
});

describe("customDraft", () => {
  it("says what to fix, field by field", () => {
    expect(customDraft({ ...EMPTY_CUSTOM, url: "http://x.example" }, new Set())).toEqual({
      problems: { name: "Give the app a name.", url: "Use an https:// address." },
    });
    const command = customDraft(
      { ...EMPTY_CUSTOM, kind: "command", name: "Weather", command: "uvx weather-mcp", key: "k" },
      new Set(),
    );
    expect(command).toMatchObject({
      problems: { keyEnv: expect.any(String), keyHost: expect.any(String) },
    });
  });

  it("adds an address with a key bound to its host, or a command with its key's variable", () => {
    expect(
      customDraft(
        {
          ...EMPTY_CUSTOM,
          name: "Docs",
          url: "https://mcp.docs.example/mcp",
          signIn: "key",
          key: " secret ",
          header: "X-Api-Key",
        },
        new Set(),
      ),
    ).toEqual({
      draft: {
        id: "docs",
        name: "Docs",
        server: {
          kind: "remote",
          url: "https://mcp.docs.example/mcp",
          transport: "http",
          auth: { kind: "key", secret: "connector-docs" },
        },
      },
      key: { hosts: ["mcp.docs.example"], header: "X-Api-Key", format: "raw", value: "secret" },
    });
    expect(
      customDraft(
        {
          ...EMPTY_CUSTOM,
          kind: "command",
          name: "Weather",
          command: "uvx weather-mcp --units metric",
          keyEnv: "WEATHER_KEY",
          keyHost: "API.weather.example",
          key: "w",
        },
        new Set(),
      ),
    ).toMatchObject({
      draft: {
        server: {
          kind: "local",
          command: "uvx",
          args: ["weather-mcp", "--units", "metric"],
          env: [{ name: "WEATHER_KEY", secret: "connector-weather" }],
        },
      },
      key: { hosts: ["api.weather.example"], header: "Authorization", format: "bearer" },
    });
  });
});
