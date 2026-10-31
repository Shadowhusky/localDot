import { APICallError, TypeValidationError } from "ai";
import { expect, it } from "vitest";
import { failureMessage, providerFailure } from "./provider-failure.ts";

const error = (statusCode: number, body: unknown = {}, responseHeaders = {}) =>
  new APICallError({
    url: "http://llm.ldot/provider",
    message: "Request failed",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify(body),
    responseHeaders,
  });
it("distinguishes local spending controls from provider credit", () => {
  expect(providerFailure(error(402, {}, { "X-Keyd-Reason": "budget-task" }))).toBe("budget");
  expect(providerFailure(error(402, {}, { "x-keyd-reason": "budget-day" }))).toBe("budget");
  expect(providerFailure(error(402))).toBe("limit");
});
it.each([
  [429, { error: { code: "insufficient_quota" } }],
  [400, { error: { message: "Your credit balance is too low" } }],
  [403, { error: { code: "usage_limit_exceeded" } }],
])("stops retrying an exhausted provider (%s)", (status, body) => {
  expect(providerFailure(error(status, body))).toBe("limit");
});
it.each([401, 429, 500, 503])("does not call an ordinary %s a credit limit", (status) => {
  expect(
    providerFailure(error(status, { error: { message: "Please retry shortly" } })),
  ).toBeUndefined();
});
it("keeps an ordinary failure's message as it was", () => {
  const refused = new APICallError({
    url: "http://llm.ldot/provider",
    message: "Cannot connect to API: connect ECONNREFUSED",
    requestBodyValues: {},
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  expect(failureMessage(refused)).toBe("Cannot connect to API: connect ECONNREFUSED");
  expect(failureMessage(error(503))).toBe("Request failed");
  expect(failureMessage("plain")).toBe("plain");
});
it("names a 200 reply that could not be read without quoting it", () => {
  const invalid = new APICallError({
    url: "http://llm.ldot/provider",
    message: "Invalid JSON response",
    requestBodyValues: {},
    statusCode: 200,
    responseBody: '{"choices":"PRIVATE-TEXT"}',
    cause: TypeValidationError.wrap({
      value: { choices: "PRIVATE-TEXT" },
      cause: new Error("choices: expected array"),
    }),
  });
  expect(failureMessage(invalid)).toBe(
    "The reply could not be read: Invalid JSON response; not the expected shape; choices: expected array",
  );
});
