import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

export const CanaryRunId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const identity = { v: z.literal(1), runId: CanaryRunId, cellId: z.string().regex(ULID_PATTERN) };
export const CanaryReady = z
  .object({
    ...identity,
    type: z.literal("ready"),
    port: z.number().int().min(1024).max(65535),
    proxyToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    caCertPem: z
      .string()
      .min(100)
      .max(8192)
      .regex(/^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n$/),
    surrogate: z.string().regex(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/),
    syntheticSecret: z.string().regex(/^canary-[a-f0-9]{64}$/),
    challenge: z.string().regex(/^[a-f0-9]{32}$/),
    url: z.string().max(128),
  })
  .strict()
  .refine((r) => r.url === `https://canary.localdot.invalid/v1/canary/${r.challenge}`);
const echoSchema = z
  .object({
    started: z.number().int().min(0).max(16),
    authenticated: z.number().int().min(0).max(16),
    reflected: z.number().int().min(0).max(16),
    active: z.literal(0),
    closed: z.literal(true),
  })
  .strict()
  .refine((r) => r.reflected <= r.authenticated && r.authenticated <= r.started);
export const CanaryClosed = z
  .object({
    ...identity,
    type: z.literal("closed"),
    gatewayClosed: z.literal(true),
    echo: echoSchema,
  })
  .strict();
export type CanaryReady = Readonly<z.infer<typeof CanaryReady>>;
export type CanaryClosed = z.infer<typeof CanaryClosed>;
