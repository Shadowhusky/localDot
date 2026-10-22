import type { AccountRead, LoginStarted, ModelList } from "@localdot/codex-harness";
import { type PremiumSpeed, ReasoningEffort, type SubscriptionUsageData } from "@localdot/protocol";
import { servedSpeed } from "@localdot/providers";
import type { z } from "zod";

export type ChatgptState = "unavailable" | "signed_out" | "signing_in" | "signed_in" | "expired";
export interface ChatgptLogin {
  loginId: string;
  method: "browser" | "code";
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  startedAt: number;
}
export interface ChatgptStatus {
  available: boolean;
  reason?: string;
  codexVersion: string;
  state: ChatgptState;
  account?: { email: string | null; plan: string };
  login?: ChatgptLogin;
  lastError?: string;
  usage?: SubscriptionUsageData;
  models?: {
    id: string;
    name: string;
    isDefault: boolean;
    efforts?: ReasoningEffort[];
    // The account's own tier for each premium speed it offers the model; empty when it lists none.
    tiers?: Partial<Record<PremiumSpeed, string>>;
  }[];
  checkedAt?: number;
}
export interface CodexAccount {
  status(opts?: { fresh?: boolean }): Promise<ChatgptStatus>;
  login(method?: "code" | "browser"): Promise<ChatgptLogin>;
  cancelLogin(): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<ChatgptStatus>;
}
export class AccountError extends Error {
  constructor(
    readonly status: 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}
const plans = new Set(["free", "go", "plus", "pro", "team", "business", "enterprise", "edu"]);
export function accountFor(account: AccountRead["account"]): ChatgptStatus["account"] {
  if (account?.type !== "chatgpt") return;
  const email =
    typeof account.email === "string" &&
    account.email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)
      ? account.email
      : null;
  return {
    email,
    plan:
      typeof account.planType === "string" && plans.has(account.planType)
        ? account.planType
        : "unknown",
  };
}
export function modelsFor(list: z.infer<typeof ModelList>): NonNullable<ChatgptStatus["models"]> {
  const seen = new Set<string>(),
    models: NonNullable<ChatgptStatus["models"]> = [];
  for (const item of list.data) {
    if (item.hidden || seen.has(item.id) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.id)) continue;
    const name = item.displayName
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .trim()
      .slice(0, 128);
    if (!name) continue;
    seen.add(item.id);
    const efforts = item.supportedReasoningEfforts?.flatMap((option) => {
      const effort = ReasoningEffort.safeParse(option.reasoningEffort);
      return effort.success && effort.data !== "enabled" ? [effort.data] : [];
    });
    const listed = item.serviceTiers?.map((tier) => tier.id) ?? item.additionalSpeedTiers;
    const tiers: Partial<Record<PremiumSpeed, string>> = {};
    for (const id of listed ?? []) {
      const speed = servedSpeed(id);
      if (speed && !tiers[speed] && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id)) tiers[speed] = id;
    }
    models.push({
      id: item.id,
      name,
      isDefault: item.isDefault,
      ...(efforts ? { efforts: [...new Set(efforts)] } : {}),
      ...(listed ? { tiers } : {}),
    });
    if (models.length === 128) break;
  }
  return models;
}
// The pinned official issuer/paths are in Codex rust-v0.154.0 login/{server,device_code_auth}.rs.
// Necessary OAuth parameters remain inside the authenticated response; never log this object.
export function loginFor(
  result: LoginStarted,
  method: "browser" | "code",
  startedAt: number,
): ChatgptLogin {
  const invalid = () =>
    new AccountError(503, "The ChatGPT sign-in response could not be verified.");
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(result.loginId) ||
    !Number.isFinite(startedAt) ||
    startedAt < 0
  )
    throw invalid();
  const raw = result.type === "chatgpt" ? result.authUrl : result.verificationUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (
    raw.length > 8192 ||
    /[\p{Cc}\p{Cf}]/u.test(raw) ||
    url.origin !== "https://auth.openai.com" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw invalid();
  if (
    method === "code" &&
    result.type === "chatgptDeviceCode" &&
    url.pathname === "/codex/device" &&
    !url.search &&
    /^[A-Za-z0-9-]{1,64}$/.test(result.userCode)
  )
    return {
      loginId: result.loginId,
      method,
      verificationUrl: raw,
      userCode: result.userCode,
      startedAt,
    };
  if (
    method === "browser" &&
    result.type === "chatgpt" &&
    url.pathname === "/oauth/authorize" &&
    url.searchParams.getAll("redirect_uri").length === 1 &&
    url.searchParams.get("redirect_uri") === "http://localhost:1455/auth/callback"
  )
    return { loginId: result.loginId, method, authUrl: raw, startedAt };
  throw invalid();
}
