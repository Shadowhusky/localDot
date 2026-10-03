import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The schema files of `codex app-server generate-json-schema` whose shapes localDot relies on.
// Each file carries its own definitions, so any change underneath changes its digest. An upgrade
// regenerates them (Task 13) and every changed digest is read before the pin moves (P5c-R1).
export const CONTRACT_FILES = Object.freeze([
  "ServerRequest.json",
  "McpServerElicitationRequestParams.json",
  "McpServerElicitationRequestResponse.json",
  "CommandExecutionRequestApprovalResponse.json",
  "FileChangeRequestApprovalResponse.json",
  "PermissionsRequestApprovalResponse.json",
  "ToolRequestUserInputParams.json",
  "ToolRequestUserInputResponse.json",
  "ApplyPatchApprovalResponse.json",
  "ExecCommandApprovalResponse.json",
  "DynamicToolCallResponse.json",
  "v1/InitializeParams.json",
  "v2/ThreadStartParams.json",
  "v2/ThreadStartResponse.json",
  "v2/TurnStartParams.json",
  "v2/TurnSteerParams.json",
  "v2/TurnInterruptParams.json",
  "v2/TurnStartedNotification.json",
  "v2/TurnCompletedNotification.json",
  "v2/ItemStartedNotification.json",
  "v2/ItemCompletedNotification.json",
  "v2/AgentMessageDeltaNotification.json",
  "v2/ReasoningSummaryTextDeltaNotification.json",
  "v2/ErrorNotification.json",
  "v2/ThreadTokenUsageUpdatedNotification.json",
  "v2/AccountRateLimitsUpdatedNotification.json",
  "v2/GetAccountParams.json",
  "v2/GetAccountResponse.json",
  "v2/GetAccountRateLimitsResponse.json",
  "v2/LoginAccountParams.json",
  "v2/LoginAccountResponse.json",
  "v2/CancelLoginAccountParams.json",
  "v2/AccountLoginCompletedNotification.json",
  "v2/ModelListParams.json",
  "v2/ModelListResponse.json",
] as const);

export interface SchemaContract {
  serverRequests: string[];
  files: Record<string, string>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export class SchemaContractError extends Error {
  constructor() {
    super("Codex schema contract is missing or invalid.");
    this.name = "SchemaContractError";
  }
}
export function schemaContract(schemaDir: string): SchemaContract {
  try {
    const files: Record<string, string> = Object.create(null);
    let requests: string[] = [];
    for (const file of CONTRACT_FILES) {
      const text = readFileSync(join(schemaDir, file), "utf8");
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new SchemaContractError();
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new SchemaContractError();
      if (file === "ServerRequest.json") {
        const variants = (value as { oneOf?: unknown }).oneOf;
        if (!Array.isArray(variants) || variants.length === 0) throw new SchemaContractError();
        requests = variants
          .map((v) => {
            const choices = v?.properties?.method?.enum;
            if (
              !Array.isArray(choices) ||
              choices.length !== 1 ||
              typeof choices[0] !== "string" ||
              !choices[0]
            )
              throw new SchemaContractError();
            return choices[0] as string;
          })
          .sort();
        if (new Set(requests).size !== requests.length) throw new SchemaContractError();
      }
      files[file] = createHash("sha256")
        .update(JSON.stringify(canonical(value)))
        .digest("hex");
    }
    return { serverRequests: requests, files };
  } catch {
    throw new SchemaContractError();
  }
}
