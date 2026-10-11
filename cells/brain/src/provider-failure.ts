import { APICallError } from "ai";

export function providerFailure(error: unknown): "budget" | "limit" | undefined {
  if (!APICallError.isInstance(error)) return;
  const reason = Object.entries(error.responseHeaders ?? {}).find(
    ([key]) => key.toLowerCase() === "x-keyd-reason",
  )?.[1];
  if (error.statusCode === 402 && ["budget-task", "budget-day"].includes(reason ?? ""))
    return "budget";
  let code = "",
    message = error.message;
  try {
    const data = JSON.parse(error.responseBody ?? "");
    const detail = data?.error ?? data;
    if (typeof detail?.code === "string") code = detail.code;
    else if (typeof detail?.type === "string") code = detail.type;
    if (typeof detail?.message === "string") message = detail.message;
  } catch {
    /* Some providers return only a status or plain text. */
  }
  if (error.statusCode === 402) return "limit";
  if (![400, 403, 429].includes(error.statusCode ?? 0)) return;
  if (
    /^(insufficient_quota|insufficient_funds|credit_balance_too_low|billing_error|usage_limit_exceeded)$/.test(
      code,
    ) ||
    /credit balance is too low|insufficient (credits?|funds|balance)|out of credits?|quota (?:is )?(?:exhausted|exceeded)|(?:usage|plan|spending) limit (?:has been |was )?(?:reached|exceeded)|billing (?:is )?disabled/i.test(
      message,
    )
  )
    return "limit";
}
