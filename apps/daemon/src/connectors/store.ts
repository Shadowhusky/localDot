import { lstatSync } from "node:fs";
import { ConnectorConfig, MAX_CONNECTORS } from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "../agent/private-files.ts";

const FILE = "connectors.json";
const TOOLS_FILE = "connector-tools.json";
const MAX_BYTES = 256 * 1024;
const MAX_TOOLS_BYTES = 4 * 1024 * 1024;
// The most tools of one app the daemon keeps a description of.
export const MAX_LISTED_TOOLS = 200;

const ConnectorsFile = z
  .strictObject({ version: z.literal(1), connectors: z.array(ConnectorConfig).max(MAX_CONNECTORS) })
  .refine(
    ({ connectors }) => new Set(connectors.map((c) => c.id)).size === connectors.length,
    "a connector is listed twice",
  );

// An app's tools as last listed, already sanitized: what dot is shown until the next listing.
export const CachedTool = z.strictObject({
  name: z.string().min(1).max(128),
  title: z.string().max(80).optional(),
  description: z.string().max(600),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .strictObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
    })
    .optional(),
});
export type CachedTool = z.infer<typeof CachedTool>;
const ToolsFile = z.strictObject({
  version: z.literal(1),
  tools: z.record(
    z.string(),
    z.strictObject({ at: z.number(), tools: z.array(CachedTool).max(MAX_LISTED_TOOLS) }),
  ),
});
export type ToolCache = z.infer<typeof ToolsFile>["tools"];

export class ConnectorStoreError extends Error {
  constructor() {
    super("Your connectors couldn't be read, so none are in use.");
    this.name = "ConnectorStoreError";
  }
}

// The user's connectors in <home>/connectors.json, and their tools as last listed. Neither holds a
// key: a connector names its key, which keyd keeps.
export class ConnectorStore {
  #files: PrivateFiles | undefined;
  constructor(private readonly home: string) {}
  #private(): PrivateFiles {
    this.#files ??= new PrivateFiles(this.home);
    return this.#files;
  }
  list(): ConnectorConfig[] {
    if (!lstatSync(this.home, { throwIfNoEntry: false })) return [];
    try {
      const text = this.#private().text(FILE, MAX_BYTES);
      return text === undefined ? [] : ConnectorsFile.parse(JSON.parse(text)).connectors;
    } catch {
      throw new ConnectorStoreError();
    }
  }
  save(connectors: readonly ConnectorConfig[]): void {
    const document = ConnectorsFile.parse({ version: 1, connectors });
    this.#private().write(FILE, `${JSON.stringify(document, null, 2)}\n`);
  }
  tools(): ToolCache {
    if (!lstatSync(this.home, { throwIfNoEntry: false })) return {};
    try {
      const text = this.#private().text(TOOLS_FILE, MAX_TOOLS_BYTES);
      return text === undefined ? {} : ToolsFile.parse(JSON.parse(text)).tools;
    } catch {
      return {};
    }
  }
  saveTools(tools: ToolCache): void {
    const document = ToolsFile.parse({ version: 1, tools });
    this.#private().write(TOOLS_FILE, `${JSON.stringify(document)}\n`);
  }
}
