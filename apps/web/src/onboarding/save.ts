import type { AutonomyPolicy } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";
import type { SubscriptionModel } from "../settings/choices.ts";
import { loadProviderIndex, loadSettings, saveSettings } from "../settings/settings-api.ts";
import { formOf, type SettingsDraft, validateForm } from "../settings/settings-form.ts";

// One setup choice saved over what is saved now, checked as Settings checks it. Returns the first
// problem in plain words, or null once it is saved.
export async function saveSetup(
  api: ApiClient,
  change: (draft: SettingsDraft) => SettingsDraft,
  options: { subscriptionModels?: readonly SubscriptionModel[]; autonomy?: AutonomyPolicy } = {},
): Promise<string | null> {
  try {
    const [saved, index] = await Promise.all([loadSettings(api), loadProviderIndex(api)]);
    const checked = validateForm(change(formOf(saved)), saved, index, options.subscriptionModels);
    if (!checked.ok) return problemText(checked.problems[0]);
    // Saved even when it is the default, so setup knows the person chose it.
    const document = options.autonomy
      ? { ...checked.document, autonomy: options.autonomy }
      : checked.document;
    await saveSettings(api, document);
    return null;
  } catch {
    return "This couldn't be saved. Check that localDot is running, then try again.";
  }
}

// Settings prefixes each problem with its role; setup only ever asks about one.
function problemText(problem: string | undefined): string {
  const text = (problem ?? "Check the choices and try again.").replace(/^(Main|Fast): /, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
