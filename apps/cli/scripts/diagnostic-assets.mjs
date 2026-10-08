// Shared by the CLI build and full runtime assembly. The scanner has one source
// of truth; fixture tests and installed diagnostics must use these same bytes.
export const DIAGNOSTIC_ASSETS = Object.freeze({
  "apps/daemon/src/keyd/testing/canary-scan.py": "dist/canary-scan.py",
  "apps/cli/src/install/canary-worker.py": "dist/canary-worker.py",
});
