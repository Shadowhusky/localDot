import { randomUUID } from "node:crypto";
import {
  ManagedServiceIdentity,
  ServiceProcessIdentity,
  ServiceReadinessReply,
  sameManagedService,
} from "../../../packages/protocol/src/install-services.ts";
import { KeydStatus } from "../../../packages/protocol/src/keyd.ts";

export function managedServiceFromEnv(env: NodeJS.ProcessEnv): ManagedServiceIdentity | null {
  const raw = env.LOCALDOT_SERVICE_IDENTITY;
  if (raw === undefined) return null;
  try {
    if (Buffer.byteLength(raw) > 1024) throw new Error();
    return ManagedServiceIdentity.parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid installed service identity.");
  }
}

/** HTTP liveness is separate from recovered startup. These are fresh readiness observations,
 * not durable authority to start tasks or an isolation self-test. The installer must also match
 * the launched PIDs, verify Docker/isolation, and use the authenticated endpoint.
 */
export class ManagedServiceReadiness {
  readonly #service: ServiceProcessIdentity;
  readonly #bootId = randomUUID();
  #phase: ServiceReadinessReply["recovery"] = "starting";
  #started = false;
  #probe: Promise<KeydStatus | null> | undefined;

  constructor(
    identity: ManagedServiceIdentity,
    private readonly readKeyd: () => Promise<unknown>,
    private readonly recoveredFor: (bootId: string) => boolean,
    pid = process.pid,
  ) {
    this.#service = ServiceProcessIdentity.parse({ ...identity, pid });
  }

  async runStartup(work: () => Promise<void>): Promise<void> {
    if (this.#started || this.#phase !== "starting")
      throw new Error("Service startup already attempted.");
    this.#started = true;
    try {
      await work();
      if (this.#phase === "starting") this.#phase = "ready";
    } catch (error) {
      if (this.#phase === "starting") this.#phase = "failed";
      throw error;
    }
  }
  stopping(): void {
    this.#phase = "stopping";
  }

  async snapshot(): Promise<ServiceReadinessReply> {
    // Only coalesce concurrent reads; a completed success is never cached across later probes.
    if (!this.#probe) {
      const probe = Promise.resolve()
        .then(() => this.readKeyd())
        .then((value) => KeydStatus.parse(value))
        .catch(() => null);
      this.#probe = probe;
      void probe.finally(() => {
        if (this.#probe === probe) this.#probe = undefined;
      });
    }
    const status = await this.#probe;
    const keyd =
      status?.service && /^[A-Za-z0-9_-]{1,128}$/.test(status.bootId)
        ? { service: status.service, bootId: status.bootId }
        : null;
    const checks = {
      recovery: this.#phase === "ready",
      admission: status !== null && this.recoveredFor(status.bootId),
      keydIdentity: keyd !== null && sameManagedService(this.#service, keyd.service),
      audit: status?.audit.ok === true,
      hairpin: status?.hairpin?.state === "active" && status.hairpin.addresses > 0,
    };
    return ServiceReadinessReply.parse({
      v: 1,
      service: this.#service,
      bootId: this.#bootId,
      recovery: this.#phase,
      keyd,
      checks,
      ready: Object.values(checks).every(Boolean),
    });
  }
}
