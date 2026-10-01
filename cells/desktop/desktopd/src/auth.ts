import { timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;

export function bearerMatches(expected: string, authorization: string | undefined): boolean {
  const given = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (expected.length < MIN_TOKEN_LENGTH || given === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
