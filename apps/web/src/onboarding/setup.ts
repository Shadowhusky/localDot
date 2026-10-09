import type { ProviderSpec } from "@localdot/providers";

// Setup's five steps, as the first-run setup counts them: how dot thinks, the key, the model,
// permissions and turning the computer on. The rail lists the first four; the curtain's Turn on is
// the fifth.
export const SETUP_STEPS = 5;

export interface SetupStep {
  id: "thinks" | "key" | "model" | "permissions";
  title: string;
  detail: string;
  done: boolean;
}

export interface SetupInput {
  // The main model's provider; "chatgpt" for a ChatGPT plan.
  provider: ProviderSpec | "chatgpt" | null;
  // The key the main model uses, or the plan it is signed in to; null while there is none.
  key: string | null;
  // The main model is chosen and can start.
  modelReady: boolean;
  model: string | null;
  // The autonomy preset the user chose; null until they have chosen one.
  permissions: string | null;
  // A computer has been turned on before.
  computer: boolean;
}

function thinks(provider: SetupInput["provider"]): string {
  if (provider === "chatgpt") return "ChatGPT plan";
  if (!provider) return "Not chosen yet";
  if (provider.local) return "Local model";
  if (provider.plan) return "Coding plan";
  if (provider.custom) return "Custom address";
  return "API key";
}

export function setupSteps(input: SetupInput): { steps: SetupStep[]; done: number } {
  const { provider } = input;
  const local = provider !== null && provider !== "chatgpt" && !!provider.local;
  const steps: SetupStep[] = [
    { id: "thinks", title: "How dot thinks", detail: thinks(provider), done: !!provider },
    local
      ? { id: "key", title: "Key", detail: "Not needed", done: true }
      : {
          id: "key",
          title: provider === "chatgpt" ? "Sign-in" : "Key",
          detail: input.key ?? (provider === "chatgpt" ? "Not signed in" : "Not added yet"),
          done: input.key !== null,
        },
    {
      id: "model",
      title: "Model",
      detail: input.modelReady ? (input.model ?? "Chosen") : "Needed to start",
      done: input.modelReady,
    },
    {
      id: "permissions",
      title: "Permissions",
      detail: input.permissions ?? "Balanced until you choose",
      done: input.permissions !== null,
    },
  ];
  return {
    steps,
    done: steps.filter((step) => step.done).length + (input.computer ? 1 : 0),
  };
}
