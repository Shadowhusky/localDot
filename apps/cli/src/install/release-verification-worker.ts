import { parentPort, workerData } from "node:worker_threads";
import { createReleaseProvenanceVerifier } from "./release-provenance.ts";
import { refreshSigstoreRoot } from "./tuf-root.ts";

// One operation per worker. No caller-supplied mirror, root, issuer, verifier or network options.
if (!parentPort) throw new Error("Release verification requires its worker host.");
const port = parentPort;
try {
  const { directory, previous, docJSON, artifact } = workerData;
  const signal = new AbortController().signal;
  const { rootJSON, versions } = await refreshSigstoreRoot(directory, previous, signal);
  await createReleaseProvenanceVerifier(rootJSON)(docJSON, artifact, signal);
  port.postMessage({ ok: true, versions });
} catch {
  port.postMessage({ ok: false });
} finally {
  port.close();
}
