import { z } from "zod";
import { ReleaseIdentity } from "./install-update.ts";

// Private durable authority for the installation's unpredictable launchd labels. This is not a
// service readiness statement. Losing it while service definitions remain requires recovery.
export const ServiceOwner = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{32}$/),
  state: z.string().max(1024),
  home: z.string().max(1024),
  uid: z.number().int().positive(),
});
export type ServiceOwner = z.infer<typeof ServiceOwner>;

// Set only by the verified installer launcher. This describes the installed release, not an
// independently verified signature. The installer still verifies files and process identities.
export const ManagedServiceIdentity = z.strictObject({
  ownerId: z.string().regex(/^[a-f0-9]{32}$/),
  release: ReleaseIdentity,
});
export type ManagedServiceIdentity = z.infer<typeof ManagedServiceIdentity>;
export const ServiceProcessIdentity = ManagedServiceIdentity.extend({
  pid: z.number().int().min(1).max(0x7fff_ffff),
});
export type ServiceProcessIdentity = z.infer<typeof ServiceProcessIdentity>;
export function sameManagedService(a: ManagedServiceIdentity, b: ManagedServiceIdentity): boolean {
  return (
    a.ownerId === b.ownerId &&
    a.release.version === b.release.version &&
    a.release.packageSha256 === b.release.packageSha256 &&
    a.release.manifestSha256 === b.release.manifestSha256
  );
}

export const ServiceReadinessReply = z
  .strictObject({
    v: z.literal(1),
    service: ServiceProcessIdentity,
    bootId: z.string().uuid(),
    recovery: z.enum(["starting", "ready", "failed", "stopping"]),
    keyd: z
      .strictObject({
        service: ServiceProcessIdentity,
        bootId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .nullable(),
    checks: z.strictObject({
      recovery: z.boolean(),
      admission: z.boolean(),
      keydIdentity: z.boolean(),
      audit: z.boolean(),
      hairpin: z.boolean(),
    }),
    ready: z.boolean(),
  })
  .refine(
    (reply) =>
      reply.checks.recovery === (reply.recovery === "ready") &&
      reply.checks.keydIdentity ===
        (reply.keyd !== null && sameManagedService(reply.service, reply.keyd.service)) &&
      reply.ready === Object.values(reply.checks).every(Boolean),
    "readiness must match its recovery, identity and checks",
  );
export type ServiceReadinessReply = z.infer<typeof ServiceReadinessReply>;

// Paths are bounded here and checked for canonical lexical form by the service builder.
// Durable records contain public configuration only, never tokens or provider credentials.
export const ServiceConfiguration = z.strictObject({
  settings: z.strictObject({
    state: z.string().min(1).max(1024),
    home: z.string().min(1).max(1024),
    userHome: z.string().min(1).max(1024),
    node: z.string().min(1).max(1024),
    dockerSocket: z.string().min(1).max(1024),
    uid: z.number().int().min(1).max(0xffff_fffe),
    port: z.number().int().min(1024).max(65535),
    ownerId: z.string().regex(/^[a-f0-9]{32}$/),
  }),
  release: ReleaseIdentity,
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ServiceConfiguration = z.infer<typeof ServiceConfiguration>;

const ServicePid = z.number().int().min(1).max(0x7fff_ffff);
export const ServiceJobState = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("absent") }),
  z.strictObject({ phase: z.literal("bootstrapping") }),
  z.strictObject({ phase: z.literal("loaded") }),
  z.strictObject({ phase: z.literal("starting") }),
  z.strictObject({ phase: z.literal("running"), pid: ServicePid }),
  z.strictObject({ phase: z.literal("removing"), pid: ServicePid.nullable() }),
]);
export type ServiceJobState = z.infer<typeof ServiceJobState>;

export const ServiceJournal = z
  .strictObject({
    v: z.literal(1),
    id: z.string().uuid(),
    configuration: ServiceConfiguration,
    previous: ServiceConfiguration.nullable(),
    phase: z.enum(["starting", "validating", "running", "stopping", "stopped"]),
    jobs: z.strictObject({ keyd: ServiceJobState, daemon: ServiceJobState }),
  })
  .refine((record) => {
    const { keyd, daemon } = record.jobs;
    if (record.phase === "running" || record.phase === "validating")
      return keyd.phase === "running" && daemon.phase === "running" && keyd.pid !== daemon.pid;
    if (record.phase === "stopped") return keyd.phase === "absent" && daemon.phase === "absent";
    if (record.phase === "starting")
      return (
        keyd.phase !== "removing" &&
        daemon.phase !== "removing" &&
        (daemon.phase === "absent" || keyd.phase === "running")
      );
    return true;
  }, "service phase must match its job observations");
export type ServiceJournal = z.infer<typeof ServiceJournal>;
