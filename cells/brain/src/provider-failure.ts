import { APICallError, JSONParseError, TypeValidationError } from "ai";

// What went wrong, for the user and the logs. The SDK calls a 2xx whose body it could not read
// "Failed to process successful response"; its causes say why, such as a connection that dropped
// mid-stream. A parse error's own message quotes the reply, so only its kind is kept.
export function failureMessage(error: unknown): string {
  const status = APICallError.isInstance(error) ? (error.statusCode ?? 0) : 0;
  const read = status >= 200 && status < 300;
  const parts: string[] = [];
  let unreadable = false;
  for (let e: unknown = error; e instanceof Error && parts.length < 5; e = e.cause) {
    if (JSONParseError.isInstance(e)) {
      unreadable = true;
      parts.push("not valid JSON");
      break;
    }
    if (TypeValidationError.isInstance(e)) {
      unreadable = true;
      parts.push("not the expected shape");
      continue;
    }
    const code = (e as { code?: unknown }).code;
    parts.push(
      typeof code === "string" && !e.message.includes(code) ? `${e.message} (${code})` : e.message,
    );
    if (!read && !unreadable) break;
  }
  if (!parts.length) return String(error).slice(0, 200);
  const lead = unreadable
    ? "The reply could not be read"
    : read
      ? "The reply broke off before it ended"
      : "";
  const text = parts.join("; ").replace(/\s+/g, " ").trim();
  return (lead ? `${lead}: ${text}` : text).slice(0, 200);
}

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
