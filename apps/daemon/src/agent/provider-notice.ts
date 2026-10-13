import { STALL } from "@localdot/protocol";

// Service-authored replies are persisted even when the model cannot produce its first token.
export function providerNotice(reason: string | undefined, detail?: string): string | undefined {
  const messages: Record<string, string> = {
    [STALL.providerLimit]:
      "Your AI provider is out of credit or included usage. Add credit, wait for the plan to reset, or choose another model and continue.",
    "chatgpt plan limit reached":
      "Your ChatGPT plan has reached its usage limit. Wait for it to reset, or choose another model and continue.",
    "claude code plan limit reached":
      "Your Claude plan has reached its usage limit. Wait for it to reset, or choose another model and continue.",
    "chatgpt sign-in expired":
      "Your ChatGPT sign-in has expired. Sign in again in Settings, then continue.",
    "claude code sign-in expired":
      "Claude Code needs you to sign in again. Check its connection in Settings, then continue.",
    [STALL.modelRefused]:
      "The provider could not process my request. Check the error details, API address, API type and model ID, then continue.",
    [STALL.modelUnavailable]:
      "The model is not responding after several attempts. Check its connection, or choose another model and continue.",
  };
  const text = messages[reason ?? ""];
  return text ? `${text}${detail ? `\n\nDetails: ${detail}` : ""}` : undefined;
}
