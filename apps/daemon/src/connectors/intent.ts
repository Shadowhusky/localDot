import type { TaskConnectorTool } from "./hub.ts";

// dot's own line for the user, which every connector tool takes besides the app's arguments.
export const INTENT_ARGUMENT = "intent";
const INTENT_SCHEMA = {
  type: "string",
  description:
    'For the user: what you are doing and why, at most 12 words, present tense, such as "Checking your open issues".',
};

// The schema dot is shown: the app's, with room for dot's line unless the app uses the name.
export function withIntent(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (INTENT_ARGUMENT in properties) return schema;
  return { ...schema, properties: { ...properties, [INTENT_ARGUMENT]: INTENT_SCHEMA } };
}

// dot's line, and the arguments the app itself gets.
export function splitIntent(
  entry: Pick<TaskConnectorTool, "schema">,
  args: Record<string, unknown>,
): { intent?: string; args: Record<string, unknown> } {
  const own = ((entry.schema.properties ?? {}) as Record<string, unknown>)[INTENT_ARGUMENT];
  if (own !== undefined || !(INTENT_ARGUMENT in args)) return { args };
  const { [INTENT_ARGUMENT]: line, ...rest } = args;
  return { ...(typeof line === "string" && line.trim() ? { intent: line } : {}), args: rest };
}
