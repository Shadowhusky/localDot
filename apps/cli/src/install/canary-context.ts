import type { ServiceConfiguration } from "../../../../packages/protocol/src/install-services.ts";
import { cleanupCanaryResources } from "./canary-cleanup.ts";
import { canaryCleanupClient } from "./canary-cleanup-client.ts";
import { type CanaryOperationContext, canaryOperationStore } from "./canary-operation.ts";
import { keydCanaryLeaseAcquirer } from "./install-lock.ts";
import { verifyServiceOwner } from "./service-journal.ts";

/** Caller holds the install mutex and independently verifies the helper's release signature.
 * This constructs the real recovery adapters; it starts no gateway or Docker operation itself.
 */
export async function installedCanaryOperationContext(
  input: ServiceConfiguration,
  verifiedKeydPath: string,
): Promise<CanaryOperationContext> {
  const config = await verifyServiceOwner(input),
    client = canaryCleanupClient(config.settings.dockerSocket);
  return {
    state: config.settings.state,
    store: canaryOperationStore(config.settings.state),
    acquire: keydCanaryLeaseAcquirer(verifiedKeydPath),
    cleanup: (record, _directory, signal) => {
      if (record.owner !== config.settings.ownerId)
        throw new Error("Diagnostic owner does not match this installation.");
      return cleanupCanaryResources(record, client, signal);
    },
  };
}
