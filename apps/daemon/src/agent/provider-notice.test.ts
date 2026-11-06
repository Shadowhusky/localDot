import { expect, it } from "vitest";
import { providerNotice } from "./provider-notice.ts";

it.each([
  ["404: Not Found", "Check the API address and model ID"],
  ["401: Unauthorized", "doesn't accept this key"],
  ["403: Forbidden", "isn't allowed"],
  ["400: image input is not supported", "Check the error details"],
])("says what to fix when a provider answers %s", (detail, advice) => {
  const notice = providerNotice("model refused", detail);
  expect(notice).toContain(advice);
  expect(notice).toContain(`Details: ${detail}`);
});
